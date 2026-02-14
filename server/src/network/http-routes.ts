import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { signToken } from '../auth/jwt.js';
import { createResident, getResidentByPassport } from '../db/queries.js';
import type { World } from '../simulation/world.js';
import type { PassportRegistration, PassportResponse } from '@otra/shared';

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

  // GET /developer — Developer API documentation
  if (req.method === 'GET' && url.pathname === '/developer') {
    handleDeveloperDocs(res);
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
        res.end(JSON.stringify({ error: 'Human registration is currently disabled. Only AI agents can register. See /developer for the API docs.' }));
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
        message: `Welcome to Otra City! You are queued for the next train. Your passport number is ${row.passport_no}.`,
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
  }));
}
