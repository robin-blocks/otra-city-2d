#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { loadManifest } from './harness/config.js';
import { Orchestrator } from './harness/orchestrator.js';
import { analyzeRun } from './harness/perception-analyzer.js';
import { scoreAgents } from './harness/scorer.js';
import { writeResults } from './harness/results-writer.js';
import { startApiServer } from './api/server.js';
import { extractAllReplayFrames } from './replay/extractor.js';

const DEFAULT_DATA_DIR = resolve(import.meta.dirname, '..', 'data', 'runs');

const program = new Command();

program
  .name('otra-bench')
  .description('Otra Bench — LLM benchmark harness for Otra City')
  .version('0.1.0');

program
  .command('start')
  .description('Start a benchmark run')
  .requiredOption('-m, --manifest <path>', 'Path to run manifest JSON')
  .option('-d, --data-dir <path>', 'Data directory for run output', DEFAULT_DATA_DIR)
  .action(async (opts: { manifest: string; dataDir: string }) => {
    try {
      const manifestPath = resolve(opts.manifest);
      if (!existsSync(manifestPath)) {
        console.error(`Manifest not found: ${manifestPath}`);
        process.exit(1);
      }

      const manifest = loadManifest(manifestPath);
      const orchestrator = new Orchestrator(manifest, opts.dataDir);
      await orchestrator.start();

      // Keep process alive until shutdown completes
      await new Promise<void>((resolve) => {
        process.on('beforeExit', () => resolve());
      });
    } catch (err) {
      console.error('Failed to start run:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show status of a running or completed run')
  .option('-d, --data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
  .option('-r, --run <run_id>', 'Run ID to check')
  .action((opts: { dataDir: string; run?: string }) => {
    const dataDir = resolve(opts.dataDir);

    if (opts.run) {
      const runDir = resolve(dataDir, opts.run);
      showRunStatus(runDir);
    } else {
      // List all runs
      try {
        const runs = readdirSync(dataDir).filter(f => f.startsWith('run-'));
        if (runs.length === 0) {
          console.log('No runs found.');
          return;
        }
        console.log('Runs:');
        for (const run of runs) {
          showRunStatus(resolve(dataDir, run), true);
        }
      } catch {
        console.log('No runs found.');
      }
    }
  });

program
  .command('stop')
  .description('Emergency stop — sends SIGTERM to all agent processes in a run')
  .requiredOption('-r, --run <run_id>', 'Run ID to stop')
  .option('-d, --data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
  .action((opts: { run: string; dataDir: string }) => {
    const stateFile = resolve(opts.dataDir, opts.run, 'run-state.json');
    if (!existsSync(stateFile)) {
      console.error(`Run state not found: ${stateFile}`);
      process.exit(1);
    }

    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      agents: Array<{ pid?: number; display_name: string; status: string }>;
    };

    let killed = 0;
    for (const agent of state.agents) {
      if (agent.pid && agent.status === 'running') {
        try {
          process.kill(agent.pid, 'SIGTERM');
          console.log(`Sent SIGTERM to ${agent.display_name} (PID ${agent.pid})`);
          killed++;
        } catch {
          console.log(`${agent.display_name} (PID ${agent.pid}) — already dead`);
        }
      }
    }
    console.log(`Stopped ${killed} agent(s).`);
  });

program
  .command('score')
  .description('Compute Otra Scores for a completed run')
  .requiredOption('-r, --run <run_id>', 'Run ID to score')
  .option('-d, --data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
  .action(async (opts: { run: string; dataDir: string }) => {
    try {
      const runDir = resolve(opts.dataDir, opts.run);
      if (!existsSync(runDir)) {
        console.error(`Run directory not found: ${runDir}`);
        process.exit(1);
      }

      // Read manifest for run duration and model display names
      const manifestFile = resolve(runDir, 'manifest.json');
      if (!existsSync(manifestFile)) {
        console.error(`manifest.json not found in ${runDir}`);
        process.exit(1);
      }
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8')) as {
        run_id: string;
        duration_hours: number;
        models: Array<{ model_id: string; display_name: string }>;
      };

      const displayNames = new Map(manifest.models.map(m => [m.model_id, m.display_name]));

      // Analyze perception data
      console.log(`\nAnalyzing perception data for ${opts.run}...`);
      const analyses = await analyzeRun(runDir, manifest.duration_hours);

      // Score agents
      console.log(`\nComputing scores...`);
      const scores = scoreAgents(analyses, manifest.duration_hours, runDir, displayNames);

      // Write results
      writeResults(runDir, manifest.run_id, manifest.duration_hours, scores);
    } catch (err) {
      console.error('Scoring failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('extract-replay')
  .description('Extract replay frames from perception data for all agents in a run')
  .requiredOption('-r, --run <run_id>', 'Run ID to extract replay for')
  .option('-d, --data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
  .action((opts: { run: string; dataDir: string }) => {
    const runDir = resolve(opts.dataDir, opts.run);
    if (!existsSync(runDir)) {
      console.error(`Run directory not found: ${runDir}`);
      process.exit(1);
    }

    console.log(`\nExtracting replay frames for ${opts.run}...\n`);
    extractAllReplayFrames(runDir);
    console.log(`\nDone. Run 'otra-bench serve' to serve replay data.`);
  });

program
  .command('serve')
  .description('Start the Otra Bench API server')
  .option('-d, --data-dir <path>', 'Data directory', DEFAULT_DATA_DIR)
  .option('-p, --port <port>', 'Port to listen on', '3460')
  .action((opts: { dataDir: string; port: string }) => {
    startApiServer(resolve(opts.dataDir), parseInt(opts.port, 10));
  });

function showRunStatus(runDir: string, compact = false): void {
  const summaryFile = resolve(runDir, 'summary.json');
  const stateFile = resolve(runDir, 'run-state.json');

  if (existsSync(summaryFile)) {
    const summary = JSON.parse(readFileSync(summaryFile, 'utf-8')) as {
      run_id: string;
      started_at: number;
      ended_at: number;
      duration_ms: number;
      shutdown_reason: string;
      total_cost_usd: number;
      agents: Array<{ display_name: string; final_status: string }>;
    };

    if (compact) {
      const dur = (summary.duration_ms / 3600_000).toFixed(1);
      console.log(`  ${summary.run_id} — ${dur}h — $${summary.total_cost_usd.toFixed(2)} — ${summary.shutdown_reason}`);
    } else {
      console.log(`Run: ${summary.run_id}`);
      console.log(`Status: COMPLETED (${summary.shutdown_reason})`);
      console.log(`Duration: ${(summary.duration_ms / 3600_000).toFixed(1)}h`);
      console.log(`Cost: $${summary.total_cost_usd.toFixed(2)}`);
      console.log(`Agents:`);
      for (const a of summary.agents) {
        console.log(`  ${a.display_name}: ${a.final_status}`);
      }
    }
  } else if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      run_id: string;
      started_at: number;
      agents: Array<{ display_name: string; status: string }>;
    };

    const elapsed = ((Date.now() - state.started_at) / 3600_000).toFixed(1);
    if (compact) {
      const running = state.agents.filter(a => a.status === 'running').length;
      console.log(`  ${state.run_id} — RUNNING ${elapsed}h — ${running}/${state.agents.length} agents active`);
    } else {
      console.log(`Run: ${state.run_id}`);
      console.log(`Status: RUNNING (${elapsed}h elapsed)`);
      console.log(`Agents:`);
      for (const a of state.agents) {
        console.log(`  ${a.display_name}: ${a.status}`);
      }
    }
  }
}

program.parse();
