import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createGunzip } from 'zlib';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { ServerMessage, PerceptionUpdate } from '@otra/shared';
import { sanitizeModelId } from './agent-manager.js';

/** Summary stats for a single agent's run */
export interface AgentAnalysis {
  model_id: string;
  passport_no: string;
  resident_id: string;

  // Survival
  first_perception_ts: number;
  last_perception_ts: number;
  death_ts: number | null;
  death_cause: string | null;
  hours_alive: number;          // real hours between first perception and death (or run end)

  // Need averages (0-100 scale, computed from all perception ticks)
  avg_hunger: number;
  avg_thirst: number;
  avg_energy: number;
  avg_health: number;
  avg_social: number;
  avg_bladder: number;

  // Economy
  total_wallet_high: number;    // highest wallet observed
  final_wallet: number;

  // Social
  conversations_heard: number;        // audible messages observed
  directed_speech_received: number;   // messages directed to this agent
  speech_acts: number;                // times this agent appeared speaking in audible

  // Events counted from events.jsonl
  need_critical_count: number;
  need_recovered_count: number;
  pain_received_count: number;

  // Buildings visited (unique)
  buildings_entered: Set<string>;

  // Perception tick count
  tick_count: number;
}

/** Parse perception.jsonl.gz for a single agent and produce analysis */
export async function analyzeAgent(
  dataDir: string,
  modelId: string,
  passportNo: string,
  residentId: string,
  runDurationHours: number,
): Promise<AgentAnalysis> {
  const agentDir = join(dataDir, 'agents', sanitizeModelId(modelId));
  const perceptionFile = join(agentDir, 'perception.jsonl.gz');
  const eventsFile = join(agentDir, 'events.jsonl');

  const analysis: AgentAnalysis = {
    model_id: modelId,
    passport_no: passportNo,
    resident_id: residentId,
    first_perception_ts: 0,
    last_perception_ts: 0,
    death_ts: null,
    death_cause: null,
    hours_alive: 0,
    avg_hunger: 0,
    avg_thirst: 0,
    avg_energy: 0,
    avg_health: 0,
    avg_social: 0,
    avg_bladder: 0,
    total_wallet_high: 0,
    final_wallet: 0,
    conversations_heard: 0,
    directed_speech_received: 0,
    speech_acts: 0,
    need_critical_count: 0,
    need_recovered_count: 0,
    pain_received_count: 0,
    buildings_entered: new Set(),
    tick_count: 0,
  };

  // Accumulators for averaging
  let sumHunger = 0, sumThirst = 0, sumEnergy = 0, sumHealth = 0, sumSocial = 0, sumBladder = 0;

  // Parse perception JSONL
  if (existsSync(perceptionFile)) {
    await parseGzippedJsonl(perceptionFile, (line: string) => {
      try {
        const record = JSON.parse(line) as { ts: number; msg: ServerMessage };
        const { ts, msg } = record;

        if (msg.type === 'perception') {
          const p = msg.data as PerceptionUpdate;
          analysis.tick_count++;

          if (analysis.first_perception_ts === 0) {
            analysis.first_perception_ts = ts;
          }
          analysis.last_perception_ts = ts;

          // Accumulate needs
          sumHunger += p.self.hunger;
          sumThirst += p.self.thirst;
          sumEnergy += p.self.energy;
          sumHealth += p.self.health;
          sumSocial += p.self.social;
          sumBladder += p.self.bladder;

          // Wallet tracking
          if (p.self.wallet > analysis.total_wallet_high) {
            analysis.total_wallet_high = p.self.wallet;
          }
          analysis.final_wallet = p.self.wallet;

          // Social tracking from audible messages
          if (p.audible && p.audible.length > 0) {
            analysis.conversations_heard += p.audible.length;
            for (const aud of p.audible) {
              if (aud.to === p.self.id) {
                analysis.directed_speech_received++;
              }
              if (aud.from === p.self.id) {
                analysis.speech_acts++;
              }
            }
          }

          // Building tracking
          if (p.self.current_building) {
            analysis.buildings_entered.add(p.self.current_building);
          }
        } else if (msg.type === 'death') {
          analysis.death_ts = ts;
          analysis.death_cause = (msg as { cause?: string }).cause || 'unknown';
        }
      } catch {
        // Skip malformed lines
      }
    });
  }

  // Parse events.jsonl for event counts
  if (existsSync(eventsFile)) {
    const eventsContent = readFileSync(eventsFile, 'utf-8');
    for (const line of eventsContent.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line) as { event_type: string; data: Record<string, unknown> };
        switch (event.event_type) {
          case 'need_critical':
            analysis.need_critical_count++;
            break;
          case 'need_recovered':
            analysis.need_recovered_count++;
            break;
          case 'pain_received':
            analysis.pain_received_count++;
            break;
        }
      } catch {
        // Skip
      }
    }
  }

  // Compute averages
  if (analysis.tick_count > 0) {
    analysis.avg_hunger = sumHunger / analysis.tick_count;
    analysis.avg_thirst = sumThirst / analysis.tick_count;
    analysis.avg_energy = sumEnergy / analysis.tick_count;
    analysis.avg_health = sumHealth / analysis.tick_count;
    analysis.avg_social = sumSocial / analysis.tick_count;
    analysis.avg_bladder = sumBladder / analysis.tick_count;
  }

  // Compute hours alive
  if (analysis.first_perception_ts > 0) {
    const endTs = analysis.death_ts || analysis.last_perception_ts;
    analysis.hours_alive = (endTs - analysis.first_perception_ts) / 3_600_000;
  }

  return analysis;
}

/** Parse all agents in a run */
export async function analyzeRun(
  dataDir: string,
  runDurationHours: number,
): Promise<AgentAnalysis[]> {
  const stateFile = join(dataDir, 'run-state.json');
  if (!existsSync(stateFile)) {
    throw new Error(`run-state.json not found in ${dataDir}`);
  }

  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
    agents: Array<{
      model_id: string;
      passport_no: string;
      resident_id: string;
    }>;
  };

  const results: AgentAnalysis[] = [];
  for (const agent of state.agents) {
    console.log(`[Analyzer] Processing ${agent.model_id}...`);
    const analysis = await analyzeAgent(
      dataDir,
      agent.model_id,
      agent.passport_no,
      agent.resident_id,
      runDurationHours,
    );
    console.log(`  ${analysis.tick_count} perception ticks, ${analysis.hours_alive.toFixed(2)}h alive`);
    results.push(analysis);
  }

  return results;
}

/** Stream-parse a gzipped JSONL file line by line */
async function parseGzippedJsonl(
  filePath: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const stream = createReadStream(filePath).pipe(gunzip);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', onLine);
    rl.on('close', resolve);
    rl.on('error', reject);
    gunzip.on('error', reject);
  });
}
