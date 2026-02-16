import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { signToken } from '../auth/jwt.js';
import { createResident, getResident, getResidentByPassport, addInventoryItem, getRecentFeedEvents, getOpenPetitions, getLaws } from '../db/queries.js';
import { getShopCatalogWithStock } from '../economy/shop.js';
import { listAvailableJobs } from '../economy/jobs.js';
import type { World } from '../simulation/world.js';
import type { PassportRegistration, PassportResponse } from '@otra/shared';
import {
  TRAIN_INTERVAL_SEC, UBI_AMOUNT, BODY_BOUNTY, ARREST_BOUNTY,
  BERRY_BUSH_MAX_USES, BERRY_BUSH_REGROW_GAME_HOURS,
  SPRING_MAX_USES, SPRING_REGROW_GAME_HOURS,
} from '@otra/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mapJsonCache: string | null = null;

export function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  world: World,
): boolean {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
      residents: world.residents.size,
      alive: Array.from(world.residents.values()).filter(r => !r.isDead).length,
      worldTime: Math.floor(world.worldTime),
      trainQueue: world.trainQueue.length,
    }));
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

  // GET /api/buildings — Building info for spectator panels
  if (req.method === 'GET' && url.pathname === '/api/buildings') {
    const catalog = getShopCatalogWithStock();
    const petitions = getOpenPetitions();
    const jobs = listAvailableJobs();
    const interval = process.env.NODE_ENV === 'production' ? TRAIN_INTERVAL_SEC : 30;
    const nextTrain = Math.max(0, interval - world.trainTimer);
    const uncollectedBodies = Array.from(world.residents.values())
      .filter(r => r.isDead).length;

    const buildings: Record<string, unknown> = {
      'council-supplies': {
        name: 'Council Supplies',
        items: catalog.map(i => ({ name: i.name, price: i.price, stock: i.stock, description: i.description })),
      },
      'council-hall': {
        name: 'Council Hall',
        petitions: petitions.map(p => ({
          category: p.category, description: p.description,
          votes_for: p.votes_for, votes_against: p.votes_against,
        })),
        jobs: jobs.map(j => ({
          title: j.title, wage: j.wage, shift_hours: j.shift_hours,
          openings: j.openings, description: j.description,
        })),
      },
      'bank': {
        name: 'Otra City Bank',
        ubi_amount: UBI_AMOUNT,
        ubi_status: UBI_AMOUNT === 0 ? 'discontinued' : 'active',
        ubi_cooldown_hours: 24,
        alive_residents: Array.from(world.residents.values()).filter(r => !r.isDead).length,
      },
      'council-toilet': { name: 'Council Toilet' },
      'train-station': {
        name: 'Train Station',
        next_train_seconds: Math.round(nextTrain),
        queue_size: world.trainQueue.length,
      },
      'council-mortuary': {
        name: 'Council Mortuary',
        bounty_per_body: BODY_BOUNTY,
        uncollected_bodies: uncollectedBodies,
      },
      'police-station': {
        name: 'Police Station',
        laws: getLaws().map(l => ({ name: l.name, description: l.description, sentence_hours: l.sentence_game_hours })),
        arrest_bounty: ARREST_BOUNTY,
        current_prisoners: Array.from(world.residents.values()).filter(r => r.prisonSentenceEnd !== null && !r.isDead).length,
        wanted_count: Array.from(world.residents.values()).filter(r => r.lawBreaking.length > 0 && !r.isDead).length,
      },
      'foraging': {
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
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' });
    res.end(JSON.stringify({ buildings }));
    return true;
  }

  return false; // not handled
}

function handlePassportRegistration(
  req: IncomingMessage,
  res: ServerResponse,
  world: World,
): void {
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
        message: `Welcome to Otra City! You are queued for the next train. Your passport number is ${row.passport_no}. You arrive hungry and with little money. Explore the wilderness to forage for food and water to survive.`,
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
      return `${actor} arrived in Otra City`;
    case 'depart':
      return `${actor} departed Otra City`;
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
      return `${actor} filed a petition: "${data.category || '?'}"`;
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
