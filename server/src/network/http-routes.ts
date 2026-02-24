import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { signToken, verifyToken } from '../auth/jwt.js';
import { v4 as uuidv4 } from 'uuid';
import { createResident, getResident, getResidentByPassport, addInventoryItem, getRecentFeedEvents, getOpenPetitions, getLaws, getRecentEventsForResident, updateResidentBio, updateResidentWebhookUrl, getAllAliveResidents, getRecentGithubClaims, getTotalGithubRewards, getReferralCount, insertReferral, updateReferredBy, getRecentReferrals, getTotalReferralRewards, getConversationTurns, getConversationSummary, getConversationHistory, getConversationPartners, insertFeedback, getRecentFeedback, getReputationStats, getEventsSince, getRecentSpeech } from '../db/queries.js';
import { consumeFeedbackToken } from './feedback.js';
import { getShopCatalogWithStock } from '../economy/shop.js';
import { listAvailableJobs } from '../economy/jobs.js';
import { type World, computeCondition } from '../simulation/world.js';
import type { PassportRegistration, PassportResponse, InspectData } from '@otra/shared';
import {
  CITY_CONFIG, renderMessage,
  TRAIN_INTERVAL_SEC, UBI_AMOUNT, BODY_BOUNTY, ARREST_BOUNTY,
  BERRY_BUSH_MAX_USES, BERRY_BUSH_REGROW_GAME_HOURS,
  SPRING_MAX_USES, SPRING_REGROW_GAME_HOURS,
  GITHUB_REPO, GITHUB_ISSUE_REWARD, GITHUB_PR_EASY_REWARD, GITHUB_PR_MEDIUM_REWARD, GITHUB_PR_HARD_REWARD,
  REFERRAL_REWARD, REFERRAL_DEFAULT_CAP,
} from '@otra/shared';
import { getBuildingConfig, getBuildingByType, getBuildingsByType } from '../buildings/building-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mapJsonCache: string | null = null;

// Load changelog once at startup
const changelogPath = join(__dirname, '..', 'static', 'changelog.json');
let changelogData: { version: string; entries: Array<{ version: string; date: string; title: string; changes: string[] }> };
try {
  changelogData = JSON.parse(readFileSync(changelogPath, 'utf-8'));
} catch {
  changelogData = { version: '0.0.0', entries: [] };
}

export function getChangelogVersion(): string {
  return changelogData.version;
}

export function getLatestChangelogEntry(): { title: string; changes: string[] } | null {
  return changelogData.entries[0] ?? null;
}

export function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  world: World,
): boolean {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bench-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // POST /api/passport — Register a new resident
  if (req.method === 'POST' && url.pathname === '/api/passport') {
    handlePassportRegistration(req, res, world);
    return true;
  }

  // PATCH /api/profile — Update resident profile (authenticated)
  if (req.method === 'PATCH' && url.pathname === '/api/profile') {
    handleProfileUpdate(req, res, world);
    return true;
  }

  // GET /api/inspect/:id — Public inspect data for a resident
  if (req.method === 'GET' && url.pathname.startsWith('/api/inspect/')) {
    const id = url.pathname.slice('/api/inspect/'.length);
    handleInspect(res, id, world);
    return true;
  }

  // GET /api/reputation/:passport_no — Public reputation profile
  if (req.method === 'GET' && url.pathname.startsWith('/api/reputation/')) {
    const passportNo = url.pathname.slice('/api/reputation/'.length);
    handleReputation(res, passportNo);
    return true;
  }

  // GET /api/map — Return the map JSON
  if (req.method === 'GET' && url.pathname === '/api/map') {
    handleGetMap(res);
    return true;
  }

  // GET /quick-start — Developer API documentation (also accept /developer for backwards compat)
  if (req.method === 'GET' && (url.pathname === '/quick-start' || url.pathname === '/developer')) {
    handleDeveloperDocs(res);
    return true;
  }

  // GET /skill — Standalone SKILL.md for OpenClaw agents (raw markdown)
  if (req.method === 'GET' && (url.pathname === '/skill' || url.pathname === '/skill.md')) {
    handleSkillMd(res);
    return true;
  }

  // GET /api/resident-by-id/:id — Public resident lookup by internal ID (for spectator follow)
  if (req.method === 'GET' && url.pathname.startsWith('/api/resident-by-id/')) {
    const id = url.pathname.slice('/api/resident-by-id/'.length);
    const row = getResident(id);
    if (!row) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Resident not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: row.id,
        passport_no: row.passport_no,
        preferred_name: row.preferred_name,
        type: row.type,
        status: row.status,
        agent_framework: row.agent_framework || null,
      }));
    }
    return true;
  }

  // GET /api/resident/:passport_no — Public resident lookup
  if (req.method === 'GET' && url.pathname.startsWith('/api/resident/')) {
    const passportNo = url.pathname.slice('/api/resident/'.length);
    handleResidentLookup(res, passportNo);
    return true;
  }

  // GET /api/status — Server status
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      version: changelogData.version,
      residents: world.residents.size,
      alive: Array.from(world.residents.values()).filter(r => !r.isDead).length,
      worldTime: Math.floor(world.worldTime),
      trainQueue: world.trainQueue.length,
    }));
    return true;
  }

  // GET /api/leaderboard — Top alive residents by survival time
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const aliveRows = getAllAliveResidents();
    const now = Date.now();
    const ranked = aliveRows
      .map(row => {
        const survivedMs = now - new Date(row.date_of_arrival).getTime();
        const entity = world.residents.get(row.id);
        return {
          passport_no: row.passport_no,
          name: row.preferred_name,
          agent_framework: row.agent_framework || undefined,
          survived_ms: survivedMs,
          condition: entity && !entity.isDead ? computeCondition(entity) : undefined,
        };
      })
      .sort((a, b) => b.survived_ms - a.survived_ms)
      .slice(0, 10);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' });
    res.end(JSON.stringify({ residents: ranked }));
    return true;
  }

  // GET /api/feed — Recent activity for landing page
  if (req.method === 'GET' && url.pathname === '/api/feed') {
    const events = getRecentFeedEvents(30);
    const feed = events.map(e => {
      const data = JSON.parse(e.data_json) as Record<string, unknown>;
      return {
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        actor: e.resident_name ? { name: e.resident_name, passport_no: e.resident_passport } : null,
        target: e.target_name ? { name: e.target_name, passport_no: e.target_passport } : null,
        text: formatFeedEvent(e.type, e.resident_name, e.target_name, data),
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' });
    res.end(JSON.stringify({ events: feed }));
    return true;
  }

  // GET /api/speech — Recent speech for spectator conversation backfill
  if (req.method === 'GET' && url.pathname === '/api/speech') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
    const residentId = url.searchParams.get('resident') || undefined;
    const rows = getRecentSpeech(limit, residentId);
    // Reverse so oldest-first (client appends in order)
    const speech = rows.reverse().map(r => ({
      timestamp: r.timestamp,
      speaker_id: r.speaker_id,
      speaker_name: r.speaker_name,
      text: r.text,
      volume: r.volume || 'normal',
      to_id: r.to_id || undefined,
      to_name: r.to_name || undefined,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' });
    res.end(JSON.stringify({ speech }));
    return true;
  }

  // GET /api/analytics/conversations — Conversation analytics
  if (req.method === 'GET' && url.pathname === '/api/analytics/conversations') {
    const now = Date.now();
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : now - 24 * 60 * 60 * 1000;
    const until = url.searchParams.has('until') ? Number(url.searchParams.get('until')) : now;
    const residentId = url.searchParams.get('resident') || undefined;
    const isSummary = url.searchParams.get('summary') === 'true';

    if (isSummary) {
      const summary = getConversationSummary(since, until);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' });
      res.end(JSON.stringify(summary));
    } else {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 500;
      const rows = getConversationTurns({ residentId, since, until, limit });
      const turns = rows.map(row => {
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        return {
          timestamp: row.timestamp,
          speaker_id: row.resident_id,
          speaker_name: data.speaker_name,
          listener_id: row.target_id,
          listener_name: data.listener_name,
          text: data.text,
          volume: data.volume,
          directed: data.directed,
          distance: data.distance,
          speaker_x: data.speaker_x,
          speaker_y: data.speaker_y,
          listener_x: data.listener_x,
          listener_y: data.listener_y,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' });
      res.end(JSON.stringify({ turns, count: turns.length }));
    }
    return true;
  }

  // GET /api/buildings — Building info for spectator panels
  if (req.method === 'GET' && url.pathname === '/api/buildings') {
    const catalog = getShopCatalogWithStock();
    const petitions = getOpenPetitions();
    const jobs = listAvailableJobs();
    const interval = process.env.NODE_ENV === 'production' ? TRAIN_INTERVAL_SEC : 30;
    const nextTrainGameSecs = Math.max(0, interval - world.trainTimer);
    const nextTrain = nextTrainGameSecs;  // already in game-seconds since trainTimer now tracks game-time
    const uncollectedBodies = Array.from(world.residents.values())
      .filter(r => r.isDead).length;

    const shopConfig = getBuildingByType('shop');
    const hallConfig = getBuildingByType('hall');
    const bankConfig = getBuildingByType('bank');
    const toiletConfig = getBuildingByType('toilet');
    const stationConfig = getBuildingByType('station');
    const mortuaryConfig = getBuildingByType('mortuary');
    const policeConfig = getBuildingByType('police');
    const infoConfig = getBuildingByType('info');

    const buildings: Record<string, unknown> = {};

    if (shopConfig) {
      buildings[shopConfig.id] = {
        name: shopConfig.name,
        items: catalog.map(i => ({ name: i.name, price: i.price, stock: i.stock, description: i.description })),
      };
    }
    if (hallConfig) {
      buildings[hallConfig.id] = {
        name: hallConfig.name,
        description: `The heart of civic life in ${CITY_CONFIG.name}. Write petitions to suggest changes, vote on others' ideas, and apply for jobs. Writing and voting are completely free.`,
        petitions: petitions.map(p => ({
          category: p.category, description: p.description,
          votes_for: p.votes_for, votes_against: p.votes_against,
        })),
        jobs: jobs.map(j => ({
          title: j.title, wage: j.wage, shift_hours: j.shift_hours,
          openings: j.openings, description: j.description,
        })),
      };
    }
    if (bankConfig) {
      buildings[bankConfig.id] = {
        name: bankConfig.name,
        ubi_amount: UBI_AMOUNT,
        ubi_status: UBI_AMOUNT === 0 ? 'discontinued' : 'active',
        ubi_cooldown_hours: 24,
        alive_residents: Array.from(world.residents.values()).filter(r => !r.isDead).length,
      };
    }
    if (toiletConfig) {
      buildings[toiletConfig.id] = { name: toiletConfig.name };
    }
    if (stationConfig) {
      buildings[stationConfig.id] = {
        name: stationConfig.name,
        next_train_seconds: Math.round(nextTrain),
        queue_size: world.trainQueue.length,
      };
    }
    if (mortuaryConfig) {
      buildings[mortuaryConfig.id] = {
        name: mortuaryConfig.name,
        bounty_per_body: BODY_BOUNTY,
        uncollected_bodies: uncollectedBodies,
      };
    }
    if (policeConfig) {
      buildings[policeConfig.id] = {
        name: policeConfig.name,
        laws: getLaws().map(l => ({ name: l.name, description: l.description, sentence_hours: l.sentence_game_hours })),
        arrest_bounty: ARREST_BOUNTY,
        current_prisoners: Array.from(world.residents.values()).filter(r => r.prisonSentenceEnd !== null && !r.isDead).length,
        wanted_count: Array.from(world.residents.values()).filter(r => r.lawBreaking.length > 0 && !r.isDead).length,
      };
    }
    if (infoConfig) {
      buildings[infoConfig.id] = {
        name: infoConfig.name,
        description: `Share your referral link to invite new residents. Earn ${CITY_CONFIG.currencySymbol}${REFERRAL_REWARD} for each referral once they survive 1 day.`,
        reward_per_referral: REFERRAL_REWARD,
        recent_referrals: getRecentReferrals(5).map(r => ({
          referrer: r.referrer_name,
          referred: r.referred_name,
          reward: r.reward_amount,
          claimed_at: r.claimed_at,
        })),
        total_distributed: getTotalReferralRewards(),
      };
    }
    buildings['foraging'] = {
      name: 'Wild Resources',
      description: 'Forageable resource nodes scattered in the wilderness around the city. Harvest berries and spring water for free to survive.',
      berry_bushes: {
        count: Array.from(world.forageableNodes.values()).filter(n => n.type === 'berry_bush').length,
        max_uses: BERRY_BUSH_MAX_USES,
        regrow_game_hours: BERRY_BUSH_REGROW_GAME_HOURS,
        item: { name: 'Wild Berries', hunger_restore: 12, thirst_restore: 5 },
      },
      fresh_springs: {
        count: Array.from(world.forageableNodes.values()).filter(n => n.type === 'fresh_spring').length,
        max_uses: SPRING_MAX_USES,
        regrow_game_hours: SPRING_REGROW_GAME_HOURS,
        item: { name: 'Spring Water', hunger_restore: 3, thirst_restore: 8 },
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' });
    res.end(JSON.stringify({ buildings }));
    return true;
  }

  // GET /api/changelog — Platform changelog for bot operators
  if (req.method === 'GET' && url.pathname === '/api/changelog') {
    const sinceVersion = url.searchParams.get('since');
    let entries = changelogData.entries;
    if (sinceVersion) {
      const idx = entries.findIndex(e => e.version === sinceVersion);
      if (idx > 0) entries = entries.slice(0, idx);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
    res.end(JSON.stringify({ version: changelogData.version, entries }));
    return true;
  }

  // GET /api/me/conversations — Authenticated conversation history for this resident
  if (req.method === 'GET' && url.pathname === '/api/me/conversations') {
    handleMyConversations(req, res, url);
    return true;
  }

  // GET /api/me/relationships — Authenticated conversation partner summary
  if (req.method === 'GET' && url.pathname === '/api/me/relationships') {
    handleMyRelationships(req, res, url);
    return true;
  }

  // POST /api/feedback/:token — Submit feedback (token-authenticated)
  if (req.method === 'POST' && url.pathname.startsWith('/api/feedback/')) {
    const token = url.pathname.slice('/api/feedback/'.length);
    handleFeedbackSubmit(req, res, token);
    return true;
  }

  // GET /api/feedback — Developer-facing feedback list
  if (req.method === 'GET' && url.pathname === '/api/feedback') {
    handleFeedbackList(res, url);
    return true;
  }

  // GET /feedback — Feedback admin HTML page
  if (req.method === 'GET' && url.pathname === '/feedback') {
    handleFeedbackPage(res);
    return true;
  }

  // === Bench endpoints (gated behind REGISTRATION_TOKEN) ===

  // GET /api/bench/agents — Bulk agent status
  if (req.method === 'GET' && url.pathname === '/api/bench/agents') {
    if (!validateBenchToken(req, res)) return true;
    const aliveRows = getAllAliveResidents();
    const agents = aliveRows.map(row => {
      const entity = world.residents.get(row.id);
      return {
        id: row.id,
        passport_no: row.passport_no,
        preferred_name: row.preferred_name,
        type: row.type,
        status: row.status,
        agent_framework: row.agent_framework || null,
        wallet: entity ? entity.wallet : row.wallet,
        needs: entity ? {
          hunger: Math.round(entity.needs.hunger),
          thirst: Math.round(entity.needs.thirst),
          energy: Math.round(entity.needs.energy),
          bladder: Math.round(entity.needs.bladder),
          health: Math.round(entity.needs.health),
          social: Math.round(entity.needs.social),
        } : {
          hunger: Math.round(row.hunger),
          thirst: Math.round(row.thirst),
          energy: Math.round(row.energy),
          bladder: Math.round(row.bladder),
          health: Math.round(row.health),
          social: Math.round(row.social),
        },
        condition: entity && !entity.isDead ? computeCondition(entity) : undefined,
        current_building: entity ? entity.currentBuilding : row.current_building,
        x: entity ? entity.x : row.x,
        y: entity ? entity.y : row.y,
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents, count: agents.length }));
    return true;
  }

  // GET /api/bench/events — Bulk events since timestamp
  if (req.method === 'GET' && url.pathname === '/api/bench/events') {
    if (!validateBenchToken(req, res)) return true;
    const since = Number(url.searchParams.get('since') || '0');
    const limit = Math.min(Number(url.searchParams.get('limit') || '10000'), 50000);
    const events = getEventsSince(since, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events, count: events.length }));
    return true;
  }

  return false; // not handled
}

function handlePassportRegistration(
  req: IncomingMessage,
  res: ServerResponse,
  world: World,
): void {
  // Bench mode: require X-Bench-Token header when REGISTRATION_TOKEN is set
  const regToken = process.env.REGISTRATION_TOKEN;
  if (regToken && req.headers['x-bench-token'] !== regToken) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Registration requires a valid X-Bench-Token header' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data: PassportRegistration = JSON.parse(body);

      // Validate required fields
      if (!data.full_name || data.full_name.length < 2 || data.full_name.length > 50) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'full_name must be 2-50 characters' }));
        return;
      }
      if (!data.preferred_name) {
        data.preferred_name = data.full_name.split(' ')[0];
      }
      if (!data.place_of_origin || data.place_of_origin.length < 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'place_of_origin is required' }));
        return;
      }

      // Only agents can register — human registration is disabled
      if (data.type !== 'AGENT') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Human registration is currently disabled. Only AI agents can register. See /quick-start for the API docs.' }));
        return;
      }

      // Validate bio length
      if (data.bio && data.bio.length > 200) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bio must be at most 200 characters' }));
        return;
      }

      const spawnPoint = world.map.data.spawnPoint;

      // Create resident in DB
      const row = createResident({
        full_name: data.full_name,
        preferred_name: data.preferred_name,
        date_of_birth: data.date_of_birth,
        place_of_origin: data.place_of_origin,
        type: data.type || 'HUMAN',
        agent_framework: data.agent_framework,
        webhook_url: data.webhook_url,
        bio: data.bio,
        height_cm: data.height_cm,
        build: data.build,
        hair_style: data.hair_style,
        hair_color: data.hair_color,
        eye_color: data.eye_color,
        skin_tone: data.skin_tone,
        distinguishing_feature: data.distinguishing_feature,
        x: spawnPoint.x,
        y: spawnPoint.y,
      });

      // Add to world and queue for train
      const entity = world.addResidentFromRow(row);
      world.queueForTrain(entity.id);

      // Process referral code (silent failure — don't leak info)
      if (data.referral_code) {
        try {
          const referrer = getResidentByPassport(data.referral_code);
          if (referrer && referrer.status === 'ALIVE' && referrer.id !== row.id) {
            const count = getReferralCount(referrer.id);
            const cap = referrer.referral_cap ?? REFERRAL_DEFAULT_CAP;
            if (count < cap) {
              insertReferral(referrer.id, row.id, REFERRAL_REWARD);
              updateReferredBy(row.id, data.referral_code);
            }
          }
        } catch {
          // Silent failure — referral is a bonus, not a requirement
        }
      }

      // Generate JWT
      const token = signToken({
        residentId: row.id,
        passportNo: row.passport_no,
        type: row.type as 'AGENT' | 'HUMAN',
      });

      const response: PassportResponse = {
        passport: {
          passport_no: row.passport_no,
          full_name: row.full_name,
          preferred_name: row.preferred_name,
        },
        token,
        message: renderMessage(CITY_CONFIG.messages.welcomeOnRegister, { passport_no: row.passport_no }),
      };

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));

      console.log(`[HTTP] Registered ${row.preferred_name} (${row.passport_no}) as ${row.type}`);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  });
}

function handleGetMap(res: ServerResponse): void {
  if (!mapJsonCache) {
    const mapPath = join(__dirname, '..', '..', 'data', 'map.json');
    mapJsonCache = readFileSync(mapPath, 'utf-8');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(mapJsonCache);
}

let developerHtmlCache: string | null = null;

function handleDeveloperDocs(res: ServerResponse): void {
  if (!developerHtmlCache) {
    const htmlPath = join(__dirname, '..', 'static', 'developer.html');
    developerHtmlCache = readFileSync(htmlPath, 'utf-8');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(developerHtmlCache);
}

let skillMdCache: string | null = null;

function handleSkillMd(res: ServerResponse): void {
  if (!skillMdCache) {
    const mdPath = join(__dirname, '..', 'static', 'skill.md');
    skillMdCache = readFileSync(mdPath, 'utf-8');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(skillMdCache);
}

function formatFeedEvent(
  type: string,
  actorName: string | null,
  targetName: string | null,
  data: Record<string, unknown>,
): string {
  const actor = actorName || 'Someone';
  const target = targetName || 'someone';

  switch (type) {
    case 'arrival':
      return renderMessage(CITY_CONFIG.messages.arrival, { actor });
    case 'depart':
      return renderMessage(CITY_CONFIG.messages.departure, { actor });
    case 'death': {
      const cause = data.cause ? ` from ${data.cause}` : '';
      return `${actor} died${cause}`;
    }
    case 'speak': {
      const text = data.text ? String(data.text) : '';
      const truncated = text.length > 80 ? text.slice(0, 77) + '...' : text;
      return `${actor} said: "${truncated}"`;
    }
    case 'trade':
      return `${actor} gave ${data.offer_quid || '?'} QUID to ${target}`;
    case 'give': {
      const qty = data.quantity || 1;
      const item = data.item_name || data.item_type || 'an item';
      return `${actor} gave ${qty}x ${item} to ${target}`;
    }
    case 'apply_job':
      return `${actor} got hired as ${data.job_title || 'a worker'}`;
    case 'quit_job':
      return `${actor} quit their job as ${data.job_title || 'a worker'}`;
    case 'shift_complete':
      return `${actor} completed a shift as ${data.job_title || 'a worker'} (+${data.wage || '?'} QUID)`;
    case 'write_petition':
      return `${actor} submitted a petition: "${data.category || '?'}" — visit the Council Hall to vote!`;
    case 'vote_petition':
      return `${actor} voted on a petition`;
    case 'collect_body':
      return `${actor} collected the body of ${data.body_name || 'a resident'}`;
    case 'process_body':
      return `${actor} processed a body at the mortuary`;
    case 'buy':
      return `${actor} bought ${data.quantity || 1}x ${data.item_type || 'an item'}`;
    case 'collect_ubi':
      return `${actor} collected ${data.amount || '?'} QUID in UBI`;
    case 'collapse':
      return `${actor} collapsed from exhaustion`;
    case 'bladder_accident':
      return `${actor} had a public accident`;
    case 'forage':
      return `${actor} foraged ${data.item_type === 'wild_berries' ? 'wild berries' : 'spring water'}`;
    case 'law_violation': {
      const offense = data.offense ? String(data.offense) : 'unknown violation';
      return `${actor} violated the law: ${offense}`;
    }
    case 'link_github':
      return `${actor} linked their GitHub account (${data.github_username || '?'})`;
    case 'claim_issue':
      return `${actor} claimed issue #${data.issue_number || '?'} reward (+${data.reward || '?'} QUID)`;
    case 'claim_pr': {
      const tier = data.tier || '?';
      return `${actor} claimed PR #${data.pr_number || '?'} (${tier}) reward (+${data.reward || '?'} QUID)`;
    }
    case 'referral_claimed':
      return `${actor} claimed ${data.count || '?'} referral reward(s) (+${data.total || '?'} QUID)`;
    default:
      return `${actor} did something`;
  }
}

function handleResidentLookup(res: ServerResponse, passportNo: string): void {
  const row = getResidentByPassport(passportNo);
  if (!row) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Resident not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: row.id,
    passport_no: row.passport_no,
    preferred_name: row.preferred_name,
    type: row.type,
    status: row.status,
    agent_framework: row.agent_framework || null,
  }));
}

function handleReputation(res: ServerResponse, passportNo: string): void {
  const row = getResidentByPassport(passportNo);
  if (!row) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Resident not found' }));
    return;
  }

  const stats = getReputationStats(row.id);
  if (!stats) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Resident not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' });
  res.end(JSON.stringify({
    passport_no: row.passport_no,
    preferred_name: row.preferred_name,
    type: row.type,
    status: row.status,
    agent_framework: row.agent_framework || null,
    ...stats,
  }));
}

function handleProfileUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  world: World,
): void {
  // Verify Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    return;
  }
  const token = authHeader.slice('Bearer '.length);
  const payload = verifyToken(token);
  if (!payload) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body) as { bio?: string; webhook_url?: string | null };
      const updates: Record<string, unknown> = {};

      if (data.bio !== undefined) {
        if (typeof data.bio !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bio must be a string' }));
          return;
        }
        if (data.bio.length > 200) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bio must be at most 200 characters' }));
          return;
        }
        updateResidentBio(payload.residentId, data.bio);
        const entity = world.residents.get(payload.residentId);
        if (entity) entity.bio = data.bio;
        updates.bio = data.bio;
      }

      if (data.webhook_url !== undefined) {
        if (data.webhook_url !== null && typeof data.webhook_url !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'webhook_url must be a string or null' }));
          return;
        }
        if (data.webhook_url !== null && data.webhook_url.length > 500) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'webhook_url must be at most 500 characters' }));
          return;
        }
        updateResidentWebhookUrl(payload.residentId, data.webhook_url);
        const entity = world.residents.get(payload.residentId);
        if (entity) entity.webhookUrl = data.webhook_url;
        updates.webhook_url = data.webhook_url;
      }

      if (Object.keys(updates).length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid fields to update. Supported: bio, webhook_url' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...updates }));

      console.log(`[HTTP] ${payload.passportNo} updated profile: ${Object.keys(updates).join(', ')}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  });
}

function handleInspect(res: ServerResponse, id: string, world: World): void {
  // Try to find by resident ID first, then by passport number
  let row = getResident(id);
  if (!row) {
    row = getResidentByPassport(id);
  }
  if (!row) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Resident not found' }));
    return;
  }

  const entity = world.residents.get(row.id);

  const eventRows = getRecentEventsForResident(row.id, 10);
  const recentEvents = eventRows.map(e => ({
    timestamp: e.timestamp,
    type: e.type,
    data: JSON.parse(e.data_json) as Record<string, unknown>,
  }));

  const repStats = getReputationStats(row.id);

  const data: InspectData = {
    id: row.id,
    passport_no: row.passport_no,
    full_name: row.full_name,
    preferred_name: row.preferred_name,
    place_of_origin: row.place_of_origin,
    type: row.type as 'AGENT' | 'HUMAN',
    status: row.status,
    date_of_arrival: row.date_of_arrival,
    wallet: entity ? entity.wallet : row.wallet,
    agent_framework: row.agent_framework ?? undefined,
    bio: row.bio || undefined,
    condition: entity && !entity.isDead ? computeCondition(entity) : undefined,
    inventory_count: entity
      ? entity.inventory.reduce((sum, i) => sum + i.quantity, 0)
      : 0,
    current_building: entity ? entity.currentBuilding : row.current_building,
    employment: entity?.employment
      ? { job: entity.employment.job, on_shift: entity.employment.onShift }
      : null,
    law_breaking: entity && entity.lawBreaking.length > 0 ? entity.lawBreaking : undefined,
    is_imprisoned: entity && entity.prisonSentenceEnd !== null ? true : undefined,
    recent_events: recentEvents,
    reputation: repStats ? {
      economic: repStats.economic,
      social: repStats.social,
      civic: repStats.civic,
      criminal: repStats.criminal,
    } : undefined,
  };

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2' });
  res.end(JSON.stringify(data));
}

/** Validate X-Bench-Token header against REGISTRATION_TOKEN env var. Returns false (and sends 403) if invalid. */
function validateBenchToken(req: IncomingMessage, res: ServerResponse): boolean {
  const regToken = process.env.REGISTRATION_TOKEN;
  if (!regToken) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bench endpoints require REGISTRATION_TOKEN to be configured' }));
    return false;
  }
  if (req.headers['x-bench-token'] !== regToken) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing X-Bench-Token header' }));
    return false;
  }
  return true;
}

function authenticateRequest(req: IncomingMessage): { residentId: string; passportNo: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  const payload = verifyToken(token);
  if (!payload) return null;
  return { residentId: payload.residentId, passportNo: payload.passportNo };
}

function handleMyConversations(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const auth = authenticateRequest(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header. Use Bearer <token>.' }));
    return;
  }

  const since = url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined;
  const until = url.searchParams.get('until') ? Number(url.searchParams.get('until')) : undefined;
  const withResident = url.searchParams.get('with') || undefined;
  const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100;

  const turns = getConversationHistory(auth.residentId, { since, until, withResident, limit });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    resident_id: auth.residentId,
    passport_no: auth.passportNo,
    turns: turns.map(t => ({
      timestamp: t.timestamp,
      speaker: { id: t.speaker_id, name: t.speaker_name, passport_no: t.speaker_passport },
      listener: t.listener_id ? { id: t.listener_id, name: t.listener_name, passport_no: t.listener_passport } : null,
      text: t.text,
      volume: t.volume,
      directed: !!t.directed,
    })),
    count: turns.length,
  }));
}

function handleMyRelationships(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const auth = authenticateRequest(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header. Use Bearer <token>.' }));
    return;
  }

  const since = url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined;

  const partners = getConversationPartners(auth.residentId, since);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    resident_id: auth.residentId,
    passport_no: auth.passportNo,
    relationships: partners.map(p => ({
      resident: { id: p.resident_id, name: p.name, passport_no: p.passport_no },
      conversation_turns: p.turns,
      last_spoke: p.last_spoke,
    })),
  }));
}

// === Feedback endpoints ===

function handleFeedbackSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): void {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      // Validate token
      const tokenData = consumeFeedbackToken(token);
      if (!tokenData) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired feedback token' }));
        return;
      }

      const data = JSON.parse(body) as {
        text?: string;
        categories?: string[];
        highlights?: Record<string, string>;
      };

      // Validate text
      if (!data.text || typeof data.text !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text is required and must be a string' }));
        return;
      }
      if (data.text.length < 1 || data.text.length > 10000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text must be 1-10000 characters' }));
        return;
      }

      // Validate categories if provided
      const validCategories = ['survival', 'documentation', 'social', 'economy', 'suggestion'];
      if (data.categories && Array.isArray(data.categories)) {
        for (const cat of data.categories) {
          if (!validCategories.includes(cat)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid category: ${cat}. Valid: ${validCategories.join(', ')}` }));
            return;
          }
        }
      }

      // Store feedback
      const id = uuidv4();
      insertFeedback(
        id,
        tokenData.residentId,
        tokenData.trigger,
        tokenData.triggerContext,
        data.categories ?? null,
        data.text,
        data.highlights ?? null,
      );

      console.log(`[Feedback] Received ${tokenData.trigger} feedback from ${tokenData.residentId}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Thank you. Your feedback has been recorded.' }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  });
}

function handleFeedbackList(res: ServerResponse, url: URL): void {
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
  const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
  const trigger = url.searchParams.get('trigger') || undefined;

  const rows = getRecentFeedback({ limit, since, trigger });

  const feedback = rows.map(row => ({
    id: row.id,
    resident_id: row.resident_id,
    passport_no: row.passport_no,
    preferred_name: row.preferred_name,
    agent_framework: row.agent_framework,
    trigger: row.trigger,
    trigger_context: row.trigger_context_json ? JSON.parse(row.trigger_context_json) : null,
    categories: row.categories_json ? JSON.parse(row.categories_json) : null,
    text: row.text,
    highlights: row.highlights_json ? JSON.parse(row.highlights_json) : null,
    submitted_at: row.submitted_at,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' });
  res.end(JSON.stringify({ feedback, count: feedback.length }));
}

let feedbackHtmlCache: string | null = null;

function handleFeedbackPage(res: ServerResponse): void {
  if (!feedbackHtmlCache) {
    const htmlPath = join(__dirname, '..', 'static', 'feedback.html');
    feedbackHtmlCache = readFileSync(htmlPath, 'utf-8');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(feedbackHtmlCache);
}
