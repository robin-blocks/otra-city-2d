const BASE = '/api';

export interface RunSummary {
  run_id: string;
  started_at: number | null;
  ended_at: number | null;
  duration_hours: number | null;
  shutdown_reason: string | null;
  total_cost_usd: number | null;
  has_results: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  model_id: string;
  display_name: string;
  otra_score: number;
  survived: boolean;
  hours_alive: number;
}

export interface AgentResult {
  model_id: string;
  display_name: string;
  passport_no: string;
  otra_score: number;
  sub_scores: {
    survival: number;
    resource_management: number;
    social_intelligence: number;
    civic_engagement: number;
    resilience: number;
  };
  details: {
    hours_alive: number;
    survived_full_run: boolean;
    avg_needs: number;
    wallet_high: number;
    final_wallet: number;
    conversations_heard: number;
    directed_speech_received: number;
    speech_acts: number;
    avg_social_need: number;
    buildings_explored: number;
    critical_count: number;
    recovered_count: number;
    pain_count: number;
  };
  cost_metrics: {
    cost_per_24h_usd: number | null;
    cost_per_score_point_usd: number | null;
  };
}

export interface RunDetail {
  run_id: string;
  manifest: {
    run_id: string;
    run_type: string;
    duration_hours: number;
    models: Array<{ model_id: string; display_name: string }>;
  } | null;
  results: {
    run_id: string;
    scored_at: string;
    run_duration_hours: number;
    total_cost_usd: number;
    agents: AgentResult[];
    leaderboard: LeaderboardEntry[];
  } | null;
  summary: {
    run_id: string;
    started_at: number;
    ended_at: number;
    duration_ms: number;
    shutdown_reason: string;
    total_cost_usd: number;
  } | null;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function listRuns(): Promise<RunSummary[]> {
  const data = await fetchJson<{ runs: RunSummary[] }>('/runs');
  return data.runs;
}

export async function getRun(runId: string): Promise<RunDetail> {
  return fetchJson<RunDetail>(`/runs/${runId}`);
}

export async function getLeaderboard(runId: string): Promise<{ leaderboard: LeaderboardEntry[]; run_duration_hours: number; total_cost_usd: number }> {
  return fetchJson(`/runs/${runId}/leaderboard`);
}
