import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PassportResponse } from '@otra/shared';
import type { RunManifest, ModelConfig, AgentState } from './config.js';
import { resolveApiKey } from './config.js';

const processes = new Map<string, ChildProcess>();

export async function registerAgent(
  manifest: RunManifest,
  model: ModelConfig,
): Promise<AgentState> {
  const url = `${manifest.otra_city_instance}/api/passport`;
  const body = {
    full_name: model.agent_name,
    preferred_name: model.agent_name,
    place_of_origin: `Bench/${model.display_name}`,
    type: 'AGENT',
    agent_framework: `OpenClaw/${model.display_name}`,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bench-Token': manifest.registration_token,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Registration failed for ${model.display_name}: ${res.status} ${err}`);
  }

  const data: PassportResponse = await res.json() as PassportResponse;
  const tmpDir = mkdtempSync(join(tmpdir(), `bench-${model.model_id.replace(/\//g, '-')}-`));

  return {
    model_id: model.model_id,
    display_name: model.display_name,
    agent_name: model.agent_name,
    passport_no: data.passport.passport_no,
    resident_id: '', // Will be resolved from inspect
    token: data.token,
    tmp_dir: tmpDir,
    status: 'registered',
  };
}

/** Resolve the resident ID by looking up the passport via the API */
export async function resolveResidentId(
  instanceUrl: string,
  passportNo: string,
): Promise<string> {
  const res = await fetch(`${instanceUrl}/api/resident/${passportNo}`);
  if (!res.ok) {
    throw new Error(`Failed to look up resident for ${passportNo}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

export function generateOpenClawConfig(
  manifest: RunManifest,
  model: ModelConfig,
  agent: AgentState,
): void {
  const apiKey = resolveApiKey(manifest.openrouter_api_key_ref);
  const skillUrl = manifest.skill_md_url || `${manifest.otra_city_instance}/skill.md`;

  // Write openclaw.json config
  const config = {
    env: {
      OPENROUTER_API_KEY: apiKey,
    },
    agents: {
      defaults: {
        model: {
          primary: `openrouter/${model.model_id}`,
        },
        tokenLimits: {
          maxInputTokens: 100000,
          maxOutputTokens: 4096,
          maxTokensPerDay: model.max_tokens_per_day,
        },
      },
    },
  };

  writeFileSync(join(agent.tmp_dir, 'openclaw.json'), JSON.stringify(config, null, 2));

  // Fetch and write SKILL.md
  // Done synchronously since we need it before starting the agent
  // The orchestrator should call fetchSkillMd first, then pass it in
  // For now, write a placeholder that gets replaced
  const skillDir = join(agent.tmp_dir, 'skills', 'otra-city');
  mkdirSync(skillDir, { recursive: true });

  // Write a connection script / env that tells openclaw where to connect
  const envContent = [
    `OTRA_CITY_URL=${manifest.otra_city_instance}`,
    `OTRA_CITY_TOKEN=${agent.token}`,
    `OTRA_CITY_PASSPORT=${agent.passport_no}`,
  ].join('\n');
  writeFileSync(join(agent.tmp_dir, '.env'), envContent);
}

/** Fetch SKILL.md from the instance and write it to the agent's temp dir */
export async function fetchAndWriteSkillMd(
  instanceUrl: string,
  agentTmpDir: string,
): Promise<string> {
  const res = await fetch(`${instanceUrl}/skill.md`);
  if (!res.ok) {
    throw new Error(`Failed to fetch SKILL.md: ${res.status}`);
  }
  const content = await res.text();
  const skillDir = join(agentTmpDir, 'skills', 'otra-city');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);
  return content;
}

export function startAgent(
  agent: AgentState,
  command: string = 'npx openclaw',
  dataDir: string,
): ChildProcess {
  const [cmd, ...args] = command.split(' ');
  const proc = spawn(cmd, args, {
    cwd: agent.tmp_dir,
    env: {
      ...process.env,
      OTRA_CITY_URL: process.env.OTRA_CITY_URL || '',
      OTRA_CITY_TOKEN: agent.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  processes.set(agent.model_id, proc);
  agent.pid = proc.pid;
  agent.status = 'running';

  // Log stdout/stderr to files
  const agentDir = join(dataDir, 'agents', sanitizeModelId(agent.model_id));
  mkdirSync(agentDir, { recursive: true });

  const stdoutLog = createWriteStream(join(agentDir, 'stdout.log'), { flags: 'a' });
  const stderrLog = createWriteStream(join(agentDir, 'stderr.log'), { flags: 'a' });

  proc.stdout?.pipe(stdoutLog);
  proc.stderr?.pipe(stderrLog);

  proc.on('exit', (code) => {
    agent.status = 'stopped';
    console.log(`[AgentManager] ${agent.display_name} (PID ${agent.pid}) exited with code ${code}`);
    processes.delete(agent.model_id);
  });

  console.log(`[AgentManager] Started ${agent.display_name} (PID ${proc.pid})`);
  return proc;
}

export function stopAgent(modelId: string): void {
  const proc = processes.get(modelId);
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    // Force kill after 5 seconds if still alive
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }
  processes.delete(modelId);
}

export function stopAll(): void {
  for (const [modelId] of processes) {
    stopAgent(modelId);
  }
}

export function sanitizeModelId(modelId: string): string {
  return modelId.replace(/\//g, '-');
}
