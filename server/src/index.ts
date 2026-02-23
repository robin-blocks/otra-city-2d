import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, closeDatabase } from './db/database.js';
import { TileMap } from './simulation/map.js';
import { World } from './simulation/world.js';
import { GameLoop } from './simulation/game-loop.js';
import { WsServer } from './network/ws-server.js';
import { handleHttpRequest } from './network/http-routes.js';
import { CITY_CONFIG, renderMessage } from '@otra/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3456', 10);

// Static file serving for production
const CLIENT_DIST = process.env.CLIENT_DIST || join(__dirname, '..', '..', 'client-dist');
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStaticFile(req: import('http').IncomingMessage, res: import('http').ServerResponse): boolean {
  if (!existsSync(CLIENT_DIST)) return false;

  const url = new URL(req.url || '/', `http://localhost`);
  let filePath = join(CLIENT_DIST, url.pathname);

  // Default to index.html for root or HTML5 history fallback
  if (url.pathname === '/' || url.pathname === '') {
    filePath = join(CLIENT_DIST, 'index.html');
  }

  try {
    const stat = statSync(filePath);
    if (stat.isFile()) {
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return true;
    }
  } catch {
    // File doesn't exist, fall through
  }

  // For non-file, non-API paths, serve index.html (SPA fallback)
  try {
    const indexPath = join(CLIENT_DIST, 'index.html');
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
      return true;
    }
  } catch {
    // No index.html available
  }

  return false;
}

async function main() {
  console.log(renderMessage(CITY_CONFIG.messages.serverBanner));
  console.log(`Starting on port ${PORT}...`);

  // 1. Initialize database
  initDatabase();

  // 2. Load map
  const map = TileMap.loadFromFile();
  console.log(`[Map] Loaded: ${map.data.width}x${map.data.height} tiles, ${map.data.buildings.length} buildings`);

  // 3. Create world
  const world = new World(map);
  world.loadResidentsFromDb();

  // 4. Create HTTP server
  const httpServer = createServer((req, res) => {
    const handled = handleHttpRequest(req, res, world);
    if (!handled) {
      // Serve static files from client build (in production) or return 404
      const served = serveStaticFile(req, res);
      if (!served) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    }
  });

  // 5. Create WebSocket server
  const wsServer = new WsServer(httpServer, world);

  // 6. Start game loop
  const gameLoop = new GameLoop(world, (tick) => {
    wsServer.broadcastPerceptions(tick);
  });
  gameLoop.start();

  // 7. Start listening
  httpServer.listen(PORT, () => {
    console.log(`[HTTP] Listening on http://localhost:${PORT}`);
    console.log(`[WS]   WebSocket at ws://localhost:${PORT}/ws`);
    console.log(`[API]  POST /api/passport — Register a resident`);
    console.log(`[API]  GET  /api/map — Get the map data`);
    console.log(`[API]  GET  /api/status — Server status`);
    console.log('');
    console.log(`${CITY_CONFIG.name} is running. Waiting for residents...`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Server] Shutting down...');
    gameLoop.stop();
    world.saveToDb();
    closeDatabase();
    httpServer.close(() => {
      console.log('[Server] Goodbye.');
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
