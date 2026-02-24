import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { RunResults } from '../harness/results-writer.js';
import type { ReplayFrame } from '../replay/extractor.js';

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
      } else if (url.pathname.match(/^\/api\/runs\/[^/]+\/agents$/)) {
        const runId = url.pathname.split('/')[3];
        handleGetAgents(res, dataDir, runId);
      } else if (url.pathname.match(/^\/api\/runs\/[^/]+\/agents\/[^/]+\/replay$/)) {
        const parts = url.pathname.split('/');
        const runId = parts[3];
        const modelId = parts[5];
        const from = parseInt(url.searchParams.get('from') || '0', 10);
        const to = parseInt(url.searchParams.get('to') || '300', 10);
        handleGetReplay(res, dataDir, runId, modelId, from, to);
      } else if (url.pathname.match(/^\/api\/runs\/[^/]+\/agents\/[^/]+\/events$/)) {
        const parts = url.pathname.split('/');
        const runId = parts[3];
        const modelId = parts[5];
        handleGetAgentEvents(res, dataDir, runId, modelId);
      } else if (url.pathname.match(/^\/api\/runs\/[^/]+\/map$/)) {
        const runId = url.pathname.split('/')[3];
        handleGetMap(res, dataDir, runId);
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
    console.log(`  GET /api/runs                          — list all runs`);
    console.log(`  GET /api/runs/:id                      — manifest + results for a run`);
    console.log(`  GET /api/runs/:id/leaderboard           — sorted leaderboard`);
    console.log(`  GET /api/runs/:id/agents                — list agents in a run`);
    console.log(`  GET /api/runs/:id/agents/:model/replay  — replay frames (windowed)`);
    console.log(`  GET /api/runs/:id/agents/:model/events  — agent events`);
    console.log(`  GET /api/runs/:id/map                   — map data`);
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

function handleGetAgents(res: ServerResponse, dataDir: string, runId: string): void {
  const agentsDir = join(resolve(dataDir), runId, 'agents');
  if (!existsSync(agentsDir)) {
    json(res, 404, { error: `Agents not found for run ${runId}` });
    return;
  }

  const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const agents = agentDirs.map(dir => {
    const passport = readJsonSafe<{
      model_id: string;
      display_name: string;
      passport_no: string;
      resident_id: string;
    }>(join(agentsDir, dir, 'passport.json'));

    return {
      model_id: dir,
      display_name: passport?.display_name ?? dir,
      passport_no: passport?.passport_no ?? '',
      resident_id: passport?.resident_id ?? '',
      has_replay: existsSync(join(agentsDir, dir, 'replay-frames.json')),
    };
  });

  json(res, 200, { agents });
}

// Cache of loaded replay frames per agent to avoid repeated disk reads
const replayCache = new Map<string, ReplayFrame[]>();

function handleGetReplay(
  res: ServerResponse, dataDir: string, runId: string, modelId: string,
  from: number, to: number,
): void {
  const cacheKey = `${runId}/${modelId}`;
  let frames = replayCache.get(cacheKey);

  if (!frames) {
    const framesFile = join(resolve(dataDir), runId, 'agents', modelId, 'replay-frames.json');
    if (!existsSync(framesFile)) {
      json(res, 404, { error: `Replay frames not found for ${modelId}. Run 'otra-bench extract-replay' first.` });
      return;
    }

    try {
      frames = JSON.parse(readFileSync(framesFile, 'utf-8')) as ReplayFrame[];
      replayCache.set(cacheKey, frames);
    } catch {
      json(res, 500, { error: 'Failed to parse replay frames' });
      return;
    }
  }

  const totalWorldTime = frames.length > 0
    ? frames[frames.length - 1].world_time - frames[0].world_time
    : 0;

  const startTime = frames.length > 0 ? frames[0].world_time : 0;

  // Window filter: from/to are relative offsets from the start
  const absFrom = startTime + from;
  const absTo = startTime + to;
  const window = frames.filter(f => f.world_time >= absFrom && f.world_time <= absTo);

  json(res, 200, {
    frames: window,
    total_world_time: totalWorldTime,
    start_time: startTime,
  });
}

function handleGetAgentEvents(res: ServerResponse, dataDir: string, runId: string, modelId: string): void {
  const eventsFile = join(resolve(dataDir), runId, 'agents', modelId, 'events.jsonl');
  if (!existsSync(eventsFile)) {
    json(res, 200, { events: [] });
    return;
  }

  try {
    const raw = readFileSync(eventsFile, 'utf-8');
    const events = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    json(res, 200, { events });
  } catch {
    json(res, 500, { error: 'Failed to parse events' });
  }
}

function handleGetMap(res: ServerResponse, dataDir: string, runId: string): void {
  const mapFile = join(resolve(dataDir), runId, 'map.json');
  if (!existsSync(mapFile)) {
    json(res, 404, { error: `Map not found for run ${runId}` });
    return;
  }

  // Serve raw JSON directly
  const data = readFileSync(mapFile, 'utf-8');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(data);
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
