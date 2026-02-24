import { readFileSync } from 'fs';

export interface ModelConfig {
  model_id: string;           // OpenRouter model ID, e.g. "anthropic/claude-sonnet-4-5"
  display_name: string;       // Human-readable, e.g. "Claude Sonnet 4.5"
  agent_name: string;         // In-game name, e.g. "Bench-Sonnet"
  max_tokens_per_day: number; // Token cap for OpenClaw config
}

export interface RunManifest {
  run_id: string;
  run_type: 'test' | 'full';
  duration_hours: number;
  otra_city_instance: string;           // e.g. "http://localhost:3457"
  registration_token: string;           // X-Bench-Token value
  skill_md_url?: string;                // URL to fetch SKILL.md (defaults to instance /skill.md)
  openrouter_api_key_ref: string;       // "env:OPENROUTER_API_KEY" or literal key
  spending_limit_usd: number;
  per_model_limit_usd: number;
  models: ModelConfig[];
  // Optional overrides
  openclaw_command?: string;            // Override the openclaw command (default: "npx openclaw")
  poll_interval_ms?: number;            // Agent status poll interval (default: 30000)
  cost_poll_interval_ms?: number;       // Cost check interval (default: 60000)
}

export interface RunState {
  run_id: string;
  started_at: number;
  data_dir: string;
  agents: AgentState[];
}

export interface AgentState {
  model_id: string;
  display_name: string;
  agent_name: string;
  passport_no: string;
  resident_id: string;
  token: string;
  tmp_dir: string;
  pid?: number;
  status: 'registered' | 'running' | 'stopped' | 'dead';
}

export function loadManifest(path: string): RunManifest {
  const raw = readFileSync(path, 'utf-8');
  const manifest: RunManifest = JSON.parse(raw);
  validateManifest(manifest);
  return manifest;
}

export function resolveApiKey(ref: string): string {
  if (ref.startsWith('env:')) {
    const envVar = ref.slice(4);
    const value = process.env[envVar];
    if (!value) {
      throw new Error(`Environment variable ${envVar} is not set (referenced by openrouter_api_key_ref)`);
    }
    return value;
  }
  return ref;
}

function validateManifest(m: RunManifest): void {
  if (!m.run_id || typeof m.run_id !== 'string') {
    throw new Error('run_id is required');
  }
  if (!m.duration_hours || m.duration_hours <= 0) {
    throw new Error('duration_hours must be positive');
  }
  if (!m.otra_city_instance || !m.otra_city_instance.startsWith('http')) {
    throw new Error('otra_city_instance must be a valid URL');
  }
  if (!m.registration_token) {
    throw new Error('registration_token is required');
  }
  if (!m.openrouter_api_key_ref) {
    throw new Error('openrouter_api_key_ref is required');
  }
  if (!m.spending_limit_usd || m.spending_limit_usd <= 0) {
    throw new Error('spending_limit_usd must be positive');
  }
  if (!m.per_model_limit_usd || m.per_model_limit_usd <= 0) {
    throw new Error('per_model_limit_usd must be positive');
  }
  if (!Array.isArray(m.models) || m.models.length === 0) {
    throw new Error('At least one model is required');
  }
  for (const model of m.models) {
    if (!model.model_id) throw new Error(`model_id is required for all models`);
    if (!model.display_name) throw new Error(`display_name is required for ${model.model_id}`);
    if (!model.agent_name) throw new Error(`agent_name is required for ${model.model_id}`);
    if (!model.max_tokens_per_day || model.max_tokens_per_day <= 0) {
      throw new Error(`max_tokens_per_day must be positive for ${model.model_id}`);
    }
  }
}
