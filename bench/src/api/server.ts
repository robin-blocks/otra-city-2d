import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { RunResults } from '../harness/results-writer.js';

export function startApiServer(dataDir: string, port: number = 3460): void {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    try {
      if (url.pathname === '/api/runs') {
        handleListRuns(res, dataDir);
      } else if (url.pathname.match(/^\/api\/runs\/[^/]+$/)) {
        const runId = url.pathname.split('/')[3];
        handleGetRun(res, dataDir, runId);
      } else if (url.pathname.match(/^\/api\/runs\/[^/]+\/leaderboard$/)) {
        const runId = url.pathname.split('/')[3];
        handleGetLeaderboard(res, dataDir, runId);
      } else if (url.pathname === '/api/health') {
        json(res, 200, { status: 'ok' });
      } else {
        json(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      console.error('[API] Error:', err);
      json(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, () => {
    console.log(`[BenchAPI] Listening on http://localhost:${port}`);
    console.log(`[BenchAPI] Data directory: ${dataDir}`);
    console.log(`[BenchAPI] Endpoints:`);
    console.log(`  GET /api/runs              — list all runs`);
    console.log(`  GET /api/runs/:id          — manifest + results for a run`);
    console.log(`  GET /api/runs/:id/leaderboard — sorted leaderboard`);
  });
}

function handleListRuns(res: ServerResponse, dataDir: string): void {
  const runsDir = resolve(dataDir);
  if (!existsSync(runsDir)) {
    json(res, 200, { runs: [] });
    return;
  }

  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('run-'))
    .map(d => d.name);

  const runs = dirs.map(dir => {
    const runDir = join(runsDir, dir);
    const summary = readJsonSafe<{
      run_id: string;
      started_at: number;
      ended_at: number;
      duration_ms: number;
      shutdown_reason: string;
      total_cost_usd: number;
    }>(join(runDir, 'summary.json'));

    const hasResults = existsSync(join(runDir, 'results.json'));

    return {
      run_id: dir,
      started_at: summary?.started_at || null,
      ended_at: summary?.ended_at || null,
      duration_hours: summary?.duration_ms ? Math.round(summary.duration_ms / 3_600_000 * 10) / 10 : null,
      shutdown_reason: summary?.shutdown_reason || null,
      total_cost_usd: summary?.total_cost_usd || null,
      has_results: hasResults,
    };
  }).sort((a, b) => (b.started_at || 0) - (a.started_at || 0));

  json(res, 200, { runs });
}

function handleGetRun(res: ServerResponse, dataDir: string, runId: string): void {
  const runDir = join(resolve(dataDir), runId);
  if (!existsSync(runDir)) {
    json(res, 404, { error: `Run ${runId} not found` });
    return;
  }

  const manifest = readJsonSafe(join(runDir, 'manifest.json'));
  const results = readJsonSafe<RunResults>(join(runDir, 'results.json'));
  const summary = readJsonSafe(join(runDir, 'summary.json'));

  json(res, 200, { run_id: runId, manifest, results, summary });
}

function handleGetLeaderboard(res: ServerResponse, dataDir: string, runId: string): void {
  const runDir = join(resolve(dataDir), runId);
  const resultsFile = join(runDir, 'results.json');

  if (!existsSync(resultsFile)) {
    json(res, 404, { error: `Results not found for run ${runId}. Run 'otra-bench score' first.` });
    return;
  }

  const results = readJsonSafe<RunResults>(resultsFile);
  if (!results) {
    json(res, 500, { error: 'Failed to parse results' });
    return;
  }

  json(res, 200, {
    run_id: runId,
    scored_at: results.scored_at,
    run_duration_hours: results.run_duration_hours,
    total_cost_usd: results.total_cost_usd,
    leaderboard: results.leaderboard,
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJsonSafe<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}
