import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { RunManifest, RunState, AgentState } from './config.js';
import { resolveApiKey } from './config.js';
import {
  registerAgent, resolveResidentId, generateOpenClawConfig,
  fetchAndWriteSkillMd, startAgent, stopAll, sanitizeModelId,
} from './agent-manager.js';
import { AgentRecorder } from './recorder.js';
import { EventDetector, type BenchEvent } from './event-detector.js';
import { CostMonitor } from './cost-monitor.js';

export class Orchestrator {
  private manifest: RunManifest;
  private runState: RunState;
  private dataDir: string;
  private recorders = new Map<string, AgentRecorder>();
  private eventDetector: EventDetector;
  private costMonitor: CostMonitor | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;

  constructor(manifest: RunManifest, baseDataDir: string) {
    this.manifest = manifest;
    this.dataDir = join(baseDataDir, manifest.run_id);
    this.runState = {
      run_id: manifest.run_id,
      started_at: Date.now(),
      data_dir: this.dataDir,
      agents: [],
    };
    this.eventDetector = new EventDetector({
      onEvent: (event) => this.handleBenchEvent(event),
    });
  }

  async start(): Promise<void> {
    console.log(`\n========================================`);
    console.log(`  Otra Bench — ${this.manifest.run_id}`);
    console.log(`  Models: ${this.manifest.models.length}`);
    console.log(`  Duration: ${this.manifest.duration_hours}h`);
    console.log(`  Budget: $${this.manifest.spending_limit_usd}`);
    console.log(`========================================\n`);

    // Create data directories
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(join(this.dataDir, 'agents'), { recursive: true });
    mkdirSync(join(this.dataDir, 'world'), { recursive: true });

    // Save manifest
    writeFileSync(
      join(this.dataDir, 'manifest.json'),
      JSON.stringify(this.manifest, null, 2),
    );

    // Step 1: Verify instance is up
    await this.verifyInstance();

    // Step 2: Register all agents
    await this.registerAllAgents();

    // Step 3: Start cost monitor
    this.startCostMonitor();

    // Step 4: Start all recorders + OpenClaw processes simultaneously
    await this.startAllAgents();

    // Step 5: Set up monitor loop
    this.startMonitorLoop();

    // Step 6: Set duration timer
    this.durationTimer = setTimeout(
      () => this.gracefulShutdown('duration_elapsed'),
      this.manifest.duration_hours * 60 * 60 * 1000,
    );

    console.log(`\n[Orchestrator] Run started. Will end in ${this.manifest.duration_hours}h or on budget limit.`);
    console.log(`[Orchestrator] Press Ctrl+C for emergency stop.\n`);

    // Handle SIGINT/SIGTERM
    const shutdown = () => this.gracefulShutdown('manual_stop');
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  private async verifyInstance(): Promise<void> {
    console.log(`[Orchestrator] Verifying instance at ${this.manifest.otra_city_instance}...`);
    const res = await fetch(`${this.manifest.otra_city_instance}/api/status`);
    if (!res.ok) {
      throw new Error(`Instance not reachable: ${res.status}`);
    }
    const status = await res.json() as { status: string; alive: number; worldTime: number };
    console.log(`[Orchestrator] Instance OK — ${status.alive} alive residents, world_time=${status.worldTime}`);
  }

  private async registerAllAgents(): Promise<void> {
    console.log(`[Orchestrator] Registering ${this.manifest.models.length} agents...`);

    for (const model of this.manifest.models) {
      const agent = await registerAgent(this.manifest, model);

      // Resolve resident ID
      agent.resident_id = await resolveResidentId(
        this.manifest.otra_city_instance,
        agent.passport_no,
      );

      // Generate OpenClaw config
      generateOpenClawConfig(this.manifest, model, agent);

      // Fetch SKILL.md into agent temp dir
      await fetchAndWriteSkillMd(this.manifest.otra_city_instance, agent.tmp_dir);

      this.runState.agents.push(agent);

      // Save passport info per agent
      const agentDir = join(this.dataDir, 'agents', sanitizeModelId(model.model_id));
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'passport.json'), JSON.stringify({
        passport_no: agent.passport_no,
        resident_id: agent.resident_id,
        model_id: model.model_id,
        display_name: model.display_name,
        agent_name: model.agent_name,
        token: agent.token,
      }, null, 2));

      console.log(`  Registered ${model.display_name} → ${agent.passport_no} (${agent.resident_id})`);
    }

    this.saveRunState();
  }

  private startCostMonitor(): void {
    const apiKey = resolveApiKey(this.manifest.openrouter_api_key_ref);
    this.costMonitor = new CostMonitor({
      apiKey,
      spendingLimit: this.manifest.spending_limit_usd,
      perModelLimit: this.manifest.per_model_limit_usd,
      dataDir: this.dataDir,
      onBudgetWarning: (snap) => {
        console.warn(`[CostMonitor] WARNING: ${snap.budget_percent.toFixed(0)}% of budget used ($${snap.total_cost_usd.toFixed(2)})`);
      },
      onBudgetExceeded: (snap) => {
        console.error(`[CostMonitor] BUDGET EXCEEDED: ${snap.budget_percent.toFixed(0)}% — initiating shutdown`);
        this.gracefulShutdown('budget_exceeded');
      },
    });
    this.costMonitor.start(this.manifest.cost_poll_interval_ms || 60_000);
  }

  private async startAllAgents(): Promise<void> {
    console.log(`[Orchestrator] Starting recorders and OpenClaw processes...`);

    // Start all recorders first
    for (const agent of this.runState.agents) {
      const recorder = new AgentRecorder({
        instanceUrl: this.manifest.otra_city_instance,
        residentId: agent.resident_id,
        modelId: agent.model_id,
        dataDir: this.dataDir,
        onMessage: (modelId, msg) => {
          this.eventDetector.handleMessage(modelId, msg);
        },
      });
      recorder.start();
      this.recorders.set(agent.model_id, recorder);

      this.eventDetector.registerAgent(
        agent.model_id,
        agent.passport_no,
        recorder,
      );
    }

    // Start all OpenClaw processes simultaneously
    const cmd = this.manifest.openclaw_command || 'npx openclaw';
    for (const agent of this.runState.agents) {
      const model = this.manifest.models.find(m => m.model_id === agent.model_id)!;
      startAgent(agent, cmd, this.dataDir);
    }

    this.saveRunState();
  }

  private startMonitorLoop(): void {
    const interval = this.manifest.poll_interval_ms || 30_000;
    this.monitorTimer = setInterval(() => this.pollAgentStatus(), interval);
  }

  private async pollAgentStatus(): Promise<void> {
    try {
      const res = await fetch(`${this.manifest.otra_city_instance}/api/bench/agents`, {
        headers: { 'X-Bench-Token': this.manifest.registration_token },
      });

      if (!res.ok) return;

      const data = await res.json() as {
        agents: Array<{
          id: string;
          passport_no: string;
          preferred_name: string;
          status: string;
          needs: Record<string, number>;
          wallet: number;
          condition?: string;
        }>;
      };

      // Log status summary
      const alive = data.agents.length;
      const totalAlive = this.eventDetector.getAliveCount();
      const elapsed = ((Date.now() - this.runState.started_at) / 3600_000).toFixed(1);
      const cost = this.costMonitor?.getTotalCost() ?? 0;

      console.log(
        `[Monitor] ${elapsed}h elapsed | ${alive} alive | $${cost.toFixed(2)} spent | ` +
        data.agents.map(a => `${a.preferred_name}: ${a.condition || a.status}`).join(', ')
      );

      // Check if all agents are dead
      if (alive === 0 && this.runState.agents.length > 0) {
        console.log('[Monitor] All agents are dead. Ending run.');
        this.gracefulShutdown('all_dead');
      }
    } catch (err) {
      console.error('[Monitor] Poll error:', err instanceof Error ? err.message : err);
    }
  }

  private handleBenchEvent(event: BenchEvent): void {
    const prefix = `[Event] ${event.model_id}`;
    switch (event.event_type) {
      case 'death':
        console.log(`${prefix} DIED: ${JSON.stringify(event.data)}`);
        break;
      case 'need_critical':
        console.log(`${prefix} CRITICAL: ${event.data.need}=${event.data.value}`);
        break;
      case 'need_recovered':
        console.log(`${prefix} RECOVERED: ${event.data.need}=${event.data.value}`);
        break;
      case 'pain_received':
        console.log(`${prefix} PAIN: ${event.data.intensity} — ${event.data.source}`);
        break;
    }
  }

  async gracefulShutdown(reason: string): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    console.log(`\n[Orchestrator] Shutting down (reason: ${reason})...`);

    // Clear timers
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);

    // Stop cost monitor
    this.costMonitor?.stop();

    // Stop all OpenClaw processes
    stopAll();

    // Stop all recorders
    for (const recorder of this.recorders.values()) {
      recorder.stop();
    }

    // Extract final events from server
    await this.extractFinalEvents();

    // Save final run state
    this.runState.agents.forEach(a => {
      if (a.status === 'running') a.status = 'stopped';
    });
    this.saveRunState();

    // Write run summary
    const summary = {
      run_id: this.manifest.run_id,
      started_at: this.runState.started_at,
      ended_at: Date.now(),
      duration_ms: Date.now() - this.runState.started_at,
      shutdown_reason: reason,
      total_cost_usd: this.costMonitor?.getTotalCost() ?? 0,
      agents: this.runState.agents.map(a => ({
        model_id: a.model_id,
        display_name: a.display_name,
        passport_no: a.passport_no,
        final_status: a.status,
      })),
      recorder_stats: Object.fromEntries(
        Array.from(this.recorders.entries()).map(([id, rec]) => [id, rec.getMessageCount()])
      ),
    };
    writeFileSync(join(this.dataDir, 'summary.json'), JSON.stringify(summary, null, 2));

    console.log(`[Orchestrator] Run complete. Data saved to ${this.dataDir}`);
    console.log(`[Orchestrator] Duration: ${((Date.now() - this.runState.started_at) / 60_000).toFixed(1)} minutes`);
    console.log(`[Orchestrator] Cost: $${(this.costMonitor?.getTotalCost() ?? 0).toFixed(4)}`);
  }

  private async extractFinalEvents(): Promise<void> {
    try {
      const res = await fetch(
        `${this.manifest.otra_city_instance}/api/bench/events?since=0&limit=50000`,
        { headers: { 'X-Bench-Token': this.manifest.registration_token } },
      );
      if (res.ok) {
        const data = await res.json() as { events: unknown[]; count: number };
        writeFileSync(
          join(this.dataDir, 'world', 'world_events.json'),
          JSON.stringify(data, null, 2),
        );
        console.log(`[Orchestrator] Extracted ${data.count} world events`);
      }
    } catch (err) {
      console.error('[Orchestrator] Failed to extract events:', err instanceof Error ? err.message : err);
    }
  }

  private saveRunState(): void {
    writeFileSync(
      join(this.dataDir, 'run-state.json'),
      JSON.stringify(this.runState, null, 2),
    );
  }
}
