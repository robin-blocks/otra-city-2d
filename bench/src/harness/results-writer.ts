import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentScore } from './scorer.js';

export interface RunResults {
  run_id: string;
  scored_at: string;           // ISO timestamp
  run_duration_hours: number;
  total_cost_usd: number;
  agents: AgentResult[];
  leaderboard: LeaderboardEntry[];
}

export interface AgentResult extends AgentScore {
  cost_metrics: {
    cost_per_24h_usd: number | null;
    cost_per_score_point_usd: number | null;
  };
}

export interface LeaderboardEntry {
  rank: number;
  model_id: string;
  display_name: string;
  otra_score: number;
  survived: boolean;
  hours_alive: number;
}

export function writeResults(
  dataDir: string,
  runId: string,
  runDurationHours: number,
  scores: AgentScore[],
): RunResults {
  // Read cost data if available
  const totalCost = readTotalCost(dataDir);

  // Build agent results with cost metrics
  const agents: AgentResult[] = scores.map(score => {
    // Cost per 24h: approximate from total cost split evenly
    // In practice, per-model cost tracking would be more accurate
    const perAgentCost = totalCost / scores.length;
    const costPer24h = score.details.hours_alive > 0
      ? (perAgentCost / score.details.hours_alive) * 24
      : null;
    const costPerPoint = score.otra_score > 0
      ? perAgentCost / score.otra_score
      : null;

    return {
      ...score,
      cost_metrics: {
        cost_per_24h_usd: costPer24h !== null ? Math.round(costPer24h * 100) / 100 : null,
        cost_per_score_point_usd: costPerPoint !== null ? Math.round(costPerPoint * 1000) / 1000 : null,
      },
    };
  });

  // Sort by Otra Score descending for leaderboard
  const sorted = [...agents].sort((a, b) => b.otra_score - a.otra_score);
  const leaderboard: LeaderboardEntry[] = sorted.map((a, i) => ({
    rank: i + 1,
    model_id: a.model_id,
    display_name: a.display_name,
    otra_score: a.otra_score,
    survived: a.details.survived_full_run,
    hours_alive: a.details.hours_alive,
  }));

  const results: RunResults = {
    run_id: runId,
    scored_at: new Date().toISOString(),
    run_duration_hours: runDurationHours,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    agents,
    leaderboard,
  };

  // Write results.json
  const resultsPath = join(dataDir, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`[ResultsWriter] Wrote ${resultsPath}`);

  // Print leaderboard to console
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  OTRA BENCH — ${runId}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Rank  Model                    Score  Status`);
  console.log(`  ${'─'.repeat(54)}`);
  for (const entry of leaderboard) {
    const status = entry.survived ? 'Alive' : `Dead (${entry.hours_alive.toFixed(1)}h)`;
    const name = entry.display_name.padEnd(24);
    console.log(`  #${entry.rank}    ${name} ${entry.otra_score.toString().padStart(5)}  ${status}`);
  }
  console.log(`${'='.repeat(60)}`);
  console.log(`  Cost: $${results.total_cost_usd} | Duration: ${runDurationHours}h\n`);

  return results;
}

function readTotalCost(dataDir: string): number {
  // Try summary.json first (written by orchestrator on shutdown)
  const summaryPath = join(dataDir, 'summary.json');
  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as {
        total_cost_usd?: number;
      };
      if (summary.total_cost_usd !== undefined) return summary.total_cost_usd;
    } catch { /* fall through */ }
  }

  // Try cost_log.jsonl — last entry has cumulative total
  const costLogPath = join(dataDir, 'cost_log.jsonl');
  if (existsSync(costLogPath)) {
    try {
      const lines = readFileSync(costLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]) as { total_cost_usd?: number };
        if (last.total_cost_usd !== undefined) return last.total_cost_usd;
      }
    } catch { /* fall through */ }
  }

  return 0;
}
