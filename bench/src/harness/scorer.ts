import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentAnalysis } from './perception-analyzer.js';
import { sanitizeModelId } from './agent-manager.js';

/** Sub-scores for a single agent */
export interface AgentSubScores {
  survival: number;           // 0-100
  resource_management: number; // 0-100
  social_intelligence: number; // 0-100
  civic_engagement: number;    // 0-100
  resilience: number;          // 0-100
}

/** Full scoring result for a single agent */
export interface AgentScore {
  model_id: string;
  display_name: string;
  passport_no: string;
  otra_score: number;           // weighted composite 0-100
  sub_scores: AgentSubScores;
  details: {
    // Survival
    hours_alive: number;
    survived_full_run: boolean;
    // Resource
    avg_needs: number;
    wallet_high: number;
    final_wallet: number;
    // Social
    conversations_heard: number;
    directed_speech_received: number;
    speech_acts: number;
    avg_social_need: number;
    // Civic
    buildings_explored: number;
    events_from_server: WorldEventCounts;
    // Resilience
    critical_count: number;
    recovered_count: number;
    pain_count: number;
  };
}

interface WorldEventCounts {
  petitions_written: number;
  votes_cast: number;
  shifts_completed: number;
  purchases: number;
  forages: number;
  jobs_applied: number;
}

// Weights from spec Section 6.1
const WEIGHTS = {
  survival: 0.30,
  resource_management: 0.20,
  social_intelligence: 0.20,
  civic_engagement: 0.15,
  resilience: 0.15,
};

export function scoreAgents(
  analyses: AgentAnalysis[],
  runDurationHours: number,
  dataDir: string,
  modelDisplayNames: Map<string, string>,
): AgentScore[] {
  // Load world events to count per-agent server events
  const worldEvents = loadWorldEvents(dataDir);

  return analyses.map(a => {
    const serverEvents = countWorldEventsForAgent(worldEvents, a.resident_id);
    const sub = computeSubScores(a, runDurationHours, serverEvents);

    const otraScore =
      sub.survival * WEIGHTS.survival +
      sub.resource_management * WEIGHTS.resource_management +
      sub.social_intelligence * WEIGHTS.social_intelligence +
      sub.civic_engagement * WEIGHTS.civic_engagement +
      sub.resilience * WEIGHTS.resilience;

    return {
      model_id: a.model_id,
      display_name: modelDisplayNames.get(a.model_id) || a.model_id,
      passport_no: a.passport_no,
      otra_score: Math.round(otraScore * 10) / 10,
      sub_scores: {
        survival: Math.round(sub.survival * 10) / 10,
        resource_management: Math.round(sub.resource_management * 10) / 10,
        social_intelligence: Math.round(sub.social_intelligence * 10) / 10,
        civic_engagement: Math.round(sub.civic_engagement * 10) / 10,
        resilience: Math.round(sub.resilience * 10) / 10,
      },
      details: {
        hours_alive: Math.round(a.hours_alive * 100) / 100,
        survived_full_run: a.death_ts === null,
        avg_needs: Math.round(((a.avg_hunger + a.avg_thirst + a.avg_energy) / 3) * 10) / 10,
        wallet_high: a.total_wallet_high,
        final_wallet: a.final_wallet,
        conversations_heard: a.conversations_heard,
        directed_speech_received: a.directed_speech_received,
        speech_acts: a.speech_acts,
        avg_social_need: Math.round(a.avg_social * 10) / 10,
        buildings_explored: a.buildings_entered.size,
        events_from_server: serverEvents,
        critical_count: a.need_critical_count,
        recovered_count: a.need_recovered_count,
        pain_count: a.pain_received_count,
      },
    };
  });
}

function computeSubScores(
  a: AgentAnalysis,
  runDurationHours: number,
  serverEvents: WorldEventCounts,
): AgentSubScores {
  // --- Survival (0-100) ---
  // score = min(100, hours_alive / run_duration * 100)
  const survival = Math.min(100, (a.hours_alive / runDurationHours) * 100);

  // --- Resource Management (0-100) ---
  // avg_needs = mean of (avg_hunger, avg_thirst, avg_energy)
  const avgNeeds = (a.avg_hunger + a.avg_thirst + a.avg_energy) / 3;
  const needScore = avgNeeds; // already 0-100

  // QUID efficiency — approximate from wallet high vs final
  // In absence of full transaction log, use a simpler heuristic:
  // efficiency based on final wallet relative to starting money (10 QUID)
  const earned = Math.max(0, a.total_wallet_high - 10); // approximate earnings
  const spent = Math.max(1, a.total_wallet_high - a.final_wallet);
  const quidEfficiency = earned / spent;
  const efficiencyScore = Math.min(100, quidEfficiency * 50);

  const resource_management = needScore * 0.7 + efficiencyScore * 0.3;

  // --- Social Intelligence (0-100) ---
  // conversation_score = min(100, speech_acts * 5) — 20 speech acts = 100
  const conversationScore = Math.min(100, a.speech_acts * 5);

  // avg_social = mean social need level
  const socialHealthScore = a.avg_social;

  // directed_response_rate: approximate from speech_acts / directed_speech_received
  // If they received 10 directed messages and spoke 8 times, rate ~80%
  const responseRate = a.directed_speech_received > 0
    ? Math.min(1, a.speech_acts / a.directed_speech_received)
    : 0;
  const responseScore = responseRate * 100;

  const social_intelligence =
    conversationScore * 0.4 +
    socialHealthScore * 0.3 +
    responseScore * 0.3;

  // --- Civic Engagement (0-100) ---
  const petitionsScore = Math.min(100, serverEvents.petitions_written * 25);
  const votesScore = Math.min(100, serverEvents.votes_cast * 20);
  // Total buildings in a standard Otra City map: 8
  const buildingsScore = (a.buildings_entered.size / 8) * 100;
  const shiftsScore = Math.min(100, serverEvents.shifts_completed * 33);

  const civic_engagement = (petitionsScore + votesScore + buildingsScore + shiftsScore) / 4;

  // --- Resilience (0-100) ---
  // recovery_score = min(100, recoveries * 20) — 5 recoveries = 100
  const recoveryScore = Math.min(100, a.need_recovered_count * 20);

  // pain_response approximation: if they recovered from criticals, they responded
  // Use ratio of recoveries to critical events as a proxy
  const painResponseRate = a.need_critical_count > 0
    ? a.need_recovered_count / a.need_critical_count
    : 1; // no crises = max score
  const painResponseScore = Math.min(100, painResponseRate * 100);

  const resilience = recoveryScore * 0.5 + painResponseScore * 0.5;

  return {
    survival: clamp(survival),
    resource_management: clamp(resource_management),
    social_intelligence: clamp(social_intelligence),
    civic_engagement: clamp(civic_engagement),
    resilience: clamp(resilience),
  };
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

/** Load world events extracted from the Otra City server at end of run */
function loadWorldEvents(dataDir: string): WorldEvent[] {
  const worldEventsFile = join(dataDir, 'world', 'world_events.json');
  if (!existsSync(worldEventsFile)) return [];

  try {
    const data = JSON.parse(readFileSync(worldEventsFile, 'utf-8')) as {
      events: WorldEvent[];
    };
    return data.events || [];
  } catch {
    return [];
  }
}

interface WorldEvent {
  id: number;
  timestamp: number;
  type: string;
  resident_id: string | null;
  target_id: string | null;
  building_id: string | null;
  x: number | null;
  y: number | null;
  data_json: string;
}

function countWorldEventsForAgent(events: WorldEvent[], residentId: string): WorldEventCounts {
  const counts: WorldEventCounts = {
    petitions_written: 0,
    votes_cast: 0,
    shifts_completed: 0,
    purchases: 0,
    forages: 0,
    jobs_applied: 0,
  };

  for (const e of events) {
    if (e.resident_id !== residentId) continue;

    switch (e.type) {
      case 'write_petition': counts.petitions_written++; break;
      case 'vote_petition': counts.votes_cast++; break;
      case 'shift_complete': counts.shifts_completed++; break;
      case 'buy': counts.purchases++; break;
      case 'forage': counts.forages++; break;
      case 'apply_job': counts.jobs_applied++; break;
    }
  }

  return counts;
}
