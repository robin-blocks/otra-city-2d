import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import type { PerceptionUpdate, VisibleResident } from '@otra/shared';

export interface ReplayFrame {
  world_time: number;
  self: {
    x: number; y: number; facing: number; status: string;
    hunger: number; thirst: number; energy: number;
    bladder: number; health: number; social: number;
    wallet: number; current_building: string | null;
    is_sleeping: boolean;
    inventory: Array<{ type: string; quantity: number }>;
  };
  residents: Array<{
    id: string; name: string; x: number; y: number;
    facing: number; action: string;
    appearance: { skin_tone: number; hair_style: number; hair_color: number };
    condition: string; framework: string | null; is_dead: boolean;
  }>;
  speech: Array<{
    speaker_id: string; speaker_name: string; text: string; volume: string;
    to_id?: string; to_name?: string;
  }>;
}

/**
 * Extract compact replay frames from a gzipped perception JSONL file.
 * Returns the number of frames extracted.
 */
export function extractReplayFrames(runDir: string, modelId: string): number {
  const agentDir = join(runDir, 'agents', modelId);
  const percFile = join(agentDir, 'perception.jsonl.gz');

  if (!existsSync(percFile)) {
    console.error(`[Extractor] perception.jsonl.gz not found for ${modelId}`);
    return 0;
  }

  console.log(`[Extractor] Reading ${percFile}...`);
  const compressed = readFileSync(percFile);
  const raw = gunzipSync(compressed).toString('utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  console.log(`[Extractor] ${lines.length} lines to process`);

  // Parse perception messages and extract frames, dedup by world_time
  const frameMap = new Map<number, ReplayFrame>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { ts: number; msg: { type: string; data?: PerceptionUpdate } };
      if (entry.msg.type !== 'perception' || !entry.msg.data) continue;

      const perc = entry.msg.data;
      const wt = perc.world_time;

      const frame: ReplayFrame = {
        world_time: wt,
        self: {
          x: perc.self.x,
          y: perc.self.y,
          facing: perc.self.facing,
          status: perc.self.status,
          hunger: Math.round(perc.self.hunger * 10) / 10,
          thirst: Math.round(perc.self.thirst * 10) / 10,
          energy: Math.round(perc.self.energy * 10) / 10,
          bladder: Math.round(perc.self.bladder * 10) / 10,
          health: Math.round(perc.self.health * 10) / 10,
          social: Math.round(perc.self.social * 10) / 10,
          wallet: perc.self.wallet,
          current_building: perc.self.current_building,
          is_sleeping: perc.self.is_sleeping,
          inventory: perc.self.inventory.map(i => ({ type: i.type, quantity: i.quantity })),
        },
        residents: perc.visible
          .filter((v): v is VisibleResident => v.type === 'resident')
          .map(v => ({
            id: v.id,
            name: v.name,
            x: v.x,
            y: v.y,
            facing: v.facing,
            action: v.action,
            appearance: {
              skin_tone: v.appearance.skin_tone,
              hair_style: v.appearance.hair_style,
              hair_color: v.appearance.hair_color,
            },
            condition: v.condition ?? 'healthy',
            framework: v.agent_framework ?? null,
            is_dead: v.is_dead,
          })),
        speech: perc.audible.map(a => ({
          speaker_id: a.from,
          speaker_name: a.from_name,
          text: a.text,
          volume: a.volume,
          ...(a.to ? { to_id: a.to } : {}),
          ...(a.to_name ? { to_name: a.to_name } : {}),
        })),
      };

      // Keep last frame per world_time (dedup)
      frameMap.set(wt, frame);
    } catch {
      // Skip unparseable lines
    }
  }

  // Sort by world_time
  const frames = Array.from(frameMap.values()).sort((a, b) => a.world_time - b.world_time);

  const outFile = join(agentDir, 'replay-frames.json');
  writeFileSync(outFile, JSON.stringify(frames));
  console.log(`[Extractor] Wrote ${frames.length} frames to ${outFile}`);

  return frames.length;
}

/**
 * Extract replay frames for all agents in a run.
 */
export function extractAllReplayFrames(runDir: string): void {
  const agentsDir = join(runDir, 'agents');
  if (!existsSync(agentsDir)) {
    console.error(`[Extractor] agents/ directory not found in ${runDir}`);
    return;
  }

  const agents = readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  console.log(`[Extractor] Found ${agents.length} agents: ${agents.join(', ')}`);

  for (const agent of agents) {
    const count = extractReplayFrames(runDir, agent);
    console.log(`[Extractor] ${agent}: ${count} frames`);
  }
}
