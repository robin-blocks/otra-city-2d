import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { verifyToken } from '../auth/jwt.js';
import type { World, ResidentEntity } from '../simulation/world.js';
import type { ClientMessage, ServerMessage } from '@otra/shared';
import { WALK_SPEED, RUN_SPEED, TILE_SIZE, ENERGY_COST_SPEAK, ENERGY_COST_SHOUT, STARTING_HOUR } from '@otra/shared';
import { logEvent, getResident, getRecentEventsForResident } from '../db/queries.js';
import { buyItem, SHOP_CATALOG } from '../economy/shop.js';
import { collectUbi } from '../economy/ubi.js';
import { consumeItem } from '../economy/consume.js';
import { enterBuilding, exitBuilding, useToilet } from '../buildings/building-actions.js';
import { findPath } from '../simulation/pathfinding.js';

export class WsServer {
  private wss: WebSocketServer;
  private connections = new Map<string, WebSocket>(); // residentId -> ws
  private spectators = new Map<string, Set<WebSocket>>(); // residentId -> spectator sockets
  private world: World;

  constructor(httpServer: Server, world: World) {
    this.world = world;
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    console.log('[WS] WebSocket server ready on /ws');
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Spectator mode: no auth required, read-only
    const spectateId = url.searchParams.get('spectate');
    if (spectateId) {
      this.bindSpectator(ws, spectateId);
      return;
    }

    // Auth: expect token as query param or first message
    const token = url.searchParams.get('token');

    if (token) {
      this.authenticateAndBind(ws, token);
    } else {
      // Wait for auth message
      ws.once('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          if (msg.type === 'auth' && 'token' in msg) {
            this.authenticateAndBind(ws, msg.token);
          } else {
            this.sendError(ws, 'auth_required', 'First message must be auth with token');
            ws.close(4001, 'Unauthorized');
          }
        } catch {
          this.sendError(ws, 'invalid_message', 'Invalid JSON');
          ws.close(4002, 'Invalid message');
        }
      });
    }
  }

  private authenticateAndBind(ws: WebSocket, token: string): void {
    const payload = verifyToken(token);
    if (!payload) {
      this.sendError(ws, 'invalid_token', 'Token is invalid or expired');
      ws.close(4001, 'Unauthorized');
      return;
    }

    let resident = this.world.residents.get(payload.residentId);
    if (!resident) {
      // Resident not in world — check DB
      const row = getResident(payload.residentId);
      if (!row || row.status !== 'ALIVE') {
        this.sendError(ws, 'resident_dead', 'This resident is deceased');
        ws.close(4003, 'Resident is dead');
        return;
      }

      // Load from DB into world and queue for train
      resident = this.world.addResidentFromRow(row);
      this.world.queueForTrain(resident.id);

      // Resident is now in the world (dev mode spawns immediately)
      // Fall through to the normal bind flow below
    }

    if (resident.isDead) {
      this.sendError(ws, 'resident_dead', 'This resident is deceased');
      ws.close(4003, 'Resident is dead');
      return;
    }

    // Bind WebSocket to resident
    resident.ws = ws;
    this.connections.set(resident.id, ws);

    // Send welcome message
    this.send(ws, {
      type: 'welcome',
      resident: {
        id: resident.id,
        passport: {
          passport_no: resident.passportNo,
          full_name: resident.fullName,
          preferred_name: resident.preferredName,
          date_of_birth: '',
          place_of_origin: '',
          date_of_arrival: '',
          type: resident.type,
          status: 'ALIVE',
          height_cm: 170,
          build: resident.build,
          hair_style: resident.hairStyle,
          hair_color: resident.hairColor,
          eye_color: 0,
          skin_tone: resident.skinTone,
          distinguishing_feature: '',
        },
        x: resident.x,
        y: resident.y,
        facing: resident.facing,
        needs: { ...resident.needs },
        wallet: resident.wallet,
        inventory: [...resident.inventory],
        status: 'idle',
        is_sleeping: resident.isSleeping,
        is_dead: false,
        current_building: resident.currentBuilding,
        employment: null,
      },
      map_url: '/api/map',
      world_time: this.world.worldTime + STARTING_HOUR * 3600,
    });

    console.log(`[WS] ${resident.preferredName} (${resident.passportNo}) connected`);

    // Handle messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleAction(resident, msg);
      } catch {
        this.sendError(ws, 'invalid_message', 'Invalid JSON');
      }
    });

    ws.on('close', () => {
      resident.ws = null;
      this.connections.delete(resident.id);
      console.log(`[WS] ${resident.preferredName} disconnected`);
    });
  }

  private bindSpectator(ws: WebSocket, residentId: string): void {
    const resident = this.world.residents.get(residentId);
    if (!resident) {
      this.sendError(ws, 'target_not_found', 'Resident not found in world');
      ws.close(4004, 'Resident not found');
      return;
    }

    // Add to spectators set
    let spectatorSet = this.spectators.get(residentId);
    if (!spectatorSet) {
      spectatorSet = new Set();
      this.spectators.set(residentId, spectatorSet);
    }
    spectatorSet.add(ws);

    // Send welcome with the target resident's current state
    this.send(ws, {
      type: 'welcome',
      resident: {
        id: resident.id,
        passport: {
          passport_no: resident.passportNo,
          full_name: resident.fullName,
          preferred_name: resident.preferredName,
          date_of_birth: '',
          place_of_origin: '',
          date_of_arrival: '',
          type: resident.type,
          status: 'ALIVE',
          height_cm: 170,
          build: resident.build,
          hair_style: resident.hairStyle,
          hair_color: resident.hairColor,
          eye_color: 0,
          skin_tone: resident.skinTone,
          distinguishing_feature: '',
        },
        x: resident.x,
        y: resident.y,
        facing: resident.facing,
        needs: { ...resident.needs },
        wallet: resident.wallet,
        inventory: [...resident.inventory],
        status: 'idle',
        is_sleeping: resident.isSleeping,
        is_dead: resident.isDead,
        current_building: resident.currentBuilding,
        employment: null,
      },
      map_url: '/api/map',
      world_time: this.world.worldTime + STARTING_HOUR * 3600,
    });

    console.log(`[WS] Spectator connected to ${resident.preferredName} (${resident.passportNo})`);

    // Ignore all incoming messages (read-only)
    ws.on('message', () => {});

    ws.on('close', () => {
      spectatorSet!.delete(ws);
      if (spectatorSet!.size === 0) {
        this.spectators.delete(residentId);
      }
      console.log(`[WS] Spectator disconnected from ${resident.preferredName}`);
    });
  }

  private handleAction(resident: ResidentEntity, msg: ClientMessage): void {
    if (resident.isDead) {
      this.sendActionResult(resident, msg, false, 'resident_dead');
      return;
    }

    switch (msg.type) {
      case 'move': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.needs.energy <= 0) {
          this.sendActionResult(resident, msg, false, 'exhausted');
          return;
        }
        // Cancel active pathfinding
        resident.pathWaypoints = null;
        resident.pathTargetBuilding = null;
        resident.pathBlockedTicks = 0;

        const dirRad = ((msg.params?.direction ?? 0) * Math.PI) / 180;
        const speed = msg.params?.speed === 'run' ? RUN_SPEED : WALK_SPEED;
        resident.velocityX = Math.cos(dirRad) * speed;
        resident.velocityY = Math.sin(dirRad) * speed;
        resident.facing = msg.params?.direction ?? 0;
        resident.speed = msg.params?.speed === 'run' ? 'run' : 'walk';
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'stop': {
        // Cancel active pathfinding
        resident.pathWaypoints = null;
        resident.pathTargetBuilding = null;
        resident.pathBlockedTicks = 0;

        resident.velocityX = 0;
        resident.velocityY = 0;
        resident.speed = 'stop';
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'face': {
        if (!resident.isSleeping) {
          resident.facing = msg.params?.direction ?? resident.facing;
        }
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'move_to': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.needs.energy <= 0) {
          this.sendActionResult(resident, msg, false, 'exhausted');
          return;
        }

        // If inside a building, auto-exit first
        if (resident.currentBuilding) {
          const exitResult = exitBuilding(resident, this.world);
          if (!exitResult.success) {
            this.sendActionResult(resident, msg, false, `Cannot exit building: ${exitResult.message}`);
            return;
          }
        }

        // Resolve target coordinates
        let targetX: number;
        let targetY: number;
        let targetBuildingId: string | null = null;
        const params = msg.params as { target?: string; x?: number; y?: number } | undefined;

        if (params && 'target' in params && typeof params.target === 'string') {
          // Building target — resolve to door approach tile
          const building = this.world.map.data.buildings.find(b => b.id === params.target);
          if (!building) {
            this.sendActionResult(resident, msg, false, 'building_not_found');
            return;
          }
          if (building.doors.length === 0) {
            this.sendActionResult(resident, msg, false, 'building_has_no_door');
            return;
          }
          const door = building.doors[0];
          // Approach tile: one tile in front of door based on facing direction
          const approachOffsets: Record<string, { dx: number; dy: number }> = {
            north: { dx: 0, dy: -1 },
            south: { dx: 0, dy: 1 },
            east: { dx: 1, dy: 0 },
            west: { dx: -1, dy: 0 },
          };
          const offset = approachOffsets[door.facing] || { dx: 0, dy: 1 };
          targetX = (door.tileX + offset.dx) * TILE_SIZE + TILE_SIZE / 2;
          targetY = (door.tileY + offset.dy) * TILE_SIZE + TILE_SIZE / 2;
          targetBuildingId = building.id;
        } else if (params && typeof params.x === 'number' && typeof params.y === 'number') {
          targetX = params.x;
          targetY = params.y;
        } else {
          this.sendActionResult(resident, msg, false, 'missing_target');
          return;
        }

        // Compute A* path
        const path = findPath(this.world.map, resident.x, resident.y, targetX, targetY);
        if (!path) {
          this.sendActionResult(resident, msg, false, 'no_path_found');
          return;
        }

        // Set path state on resident
        resident.pathWaypoints = path;
        resident.pathIndex = 0;
        resident.pathTargetBuilding = targetBuildingId;
        resident.pathBlockedTicks = 0;

        logEvent('move_to', resident.id, null, targetBuildingId, resident.x, resident.y, {
          target_x: targetX, target_y: targetY, waypoint_count: path.length,
        });
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'speak': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        const text = msg.params?.text || '';
        const volume = msg.params?.volume || 'normal';
        if (text.length === 0 || text.length > 280) {
          this.sendActionResult(resident, msg, false, 'invalid_text');
          return;
        }
        const cost = volume === 'shout' ? ENERGY_COST_SHOUT : ENERGY_COST_SPEAK;
        if (resident.needs.energy < cost) {
          this.sendActionResult(resident, msg, false, 'insufficient_energy');
          return;
        }
        resident.needs.energy -= cost;
        resident.pendingSpeech.push({ text, volume, time: Date.now() });
        logEvent('speak', resident.id, null, null, resident.x, resident.y, { text, volume });
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'sleep': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'already_sleeping');
          return;
        }
        if (resident.needs.energy >= 90) {
          this.sendActionResult(resident, msg, false, 'not_tired');
          return;
        }
        // Cancel active pathfinding
        resident.pathWaypoints = null;
        resident.pathTargetBuilding = null;
        resident.pathBlockedTicks = 0;

        resident.isSleeping = true;
        resident.velocityX = 0;
        resident.velocityY = 0;
        resident.speed = 'stop';
        logEvent('sleep', resident.id, null, null, resident.x, resident.y, {});
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'wake': {
        if (!resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'not_sleeping');
          return;
        }
        resident.isSleeping = false;
        logEvent('wake', resident.id, null, null, resident.x, resident.y, {});
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'enter_building': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        const buildingId = msg.params?.building_id;
        if (!buildingId) {
          this.sendActionResult(resident, msg, false, 'missing_building_id');
          return;
        }
        const enterResult = enterBuilding(resident, buildingId, this.world);
        logEvent('enter_building', resident.id, null, buildingId, resident.x, resident.y, { success: enterResult.success });
        this.sendActionResult(resident, msg, enterResult.success, enterResult.message);
        break;
      }

      case 'exit_building': {
        const exitResult = exitBuilding(resident, this.world);
        logEvent('exit_building', resident.id, null, resident.currentBuilding, resident.x, resident.y, { success: exitResult.success });
        this.sendActionResult(resident, msg, exitResult.success, exitResult.message);
        break;
      }

      case 'buy': {
        if (!resident.currentBuilding || resident.currentBuilding !== 'council-supplies') {
          this.sendActionResult(resident, msg, false, 'Must be inside Council Supplies');
          return;
        }
        const itemType = msg.params?.item_type;
        const quantity = msg.params?.quantity ?? 1;
        if (!itemType) {
          this.sendActionResult(resident, msg, false, 'missing_item_type');
          return;
        }
        const buyResult = buyItem(resident, itemType, quantity);
        if (buyResult.success) {
          logEvent('buy', resident.id, null, 'council-supplies', resident.x, resident.y, {
            item_type: itemType, quantity, cost: (SHOP_CATALOG.find(i => i.item_type === itemType)?.price ?? 0) * quantity,
          });
        }
        this.sendActionResult(resident, msg, buyResult.success, buyResult.message);
        break;
      }

      case 'collect_ubi': {
        if (!resident.currentBuilding || resident.currentBuilding !== 'bank') {
          this.sendActionResult(resident, msg, false, 'Must be inside Otra City Bank');
          return;
        }
        const ubiResult = collectUbi(resident);
        if (ubiResult.success) {
          logEvent('collect_ubi', resident.id, null, 'bank', resident.x, resident.y, {
            amount: ubiResult.amount, new_balance: ubiResult.newBalance,
          });
        }
        this.sendActionResult(resident, msg, ubiResult.success, ubiResult.message);
        break;
      }

      case 'use_toilet': {
        const toiletResult = useToilet(resident);
        if (toiletResult.success) {
          logEvent('use_toilet', resident.id, null, 'council-toilet', resident.x, resident.y, {});
        }
        this.sendActionResult(resident, msg, toiletResult.success, toiletResult.message);
        break;
      }

      case 'eat': {
        const eatItemId = msg.params?.item_id;
        if (!eatItemId) {
          this.sendActionResult(resident, msg, false, 'missing_item_id');
          return;
        }
        const eatResult = consumeItem(resident, eatItemId, 'eat');
        if (eatResult.success) {
          logEvent('eat', resident.id, null, null, resident.x, resident.y, {
            item_id: eatItemId, effects: eatResult.effects,
          });
        }
        this.sendActionResult(resident, msg, eatResult.success, eatResult.message);
        break;
      }

      case 'drink': {
        const drinkItemId = msg.params?.item_id;
        if (!drinkItemId) {
          this.sendActionResult(resident, msg, false, 'missing_item_id');
          return;
        }
        const drinkResult = consumeItem(resident, drinkItemId, 'drink');
        if (drinkResult.success) {
          logEvent('drink', resident.id, null, null, resident.x, resident.y, {
            item_id: drinkItemId, effects: drinkResult.effects,
          });
        }
        this.sendActionResult(resident, msg, drinkResult.success, drinkResult.message);
        break;
      }

      case 'inspect': {
        const targetId = msg.params?.target_id;
        if (!targetId) {
          this.sendActionResult(resident, msg, false, 'missing_target_id');
          return;
        }

        const target = this.world.residents.get(targetId);
        if (!target) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return;
        }

        const targetRow = getResident(targetId);
        if (!targetRow) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return;
        }

        const eventRows = getRecentEventsForResident(targetId, 10);
        const recentEvents = eventRows.map(e => ({
          timestamp: e.timestamp,
          type: e.type,
          data: JSON.parse(e.data_json) as Record<string, unknown>,
        }));

        const requestId = ('request_id' in msg ? msg.request_id : undefined) || '';
        if (resident.ws) {
          this.send(resident.ws, {
            type: 'inspect_result',
            request_id: requestId,
            data: {
              id: targetRow.id,
              passport_no: targetRow.passport_no,
              full_name: targetRow.full_name,
              preferred_name: targetRow.preferred_name,
              place_of_origin: targetRow.place_of_origin,
              type: targetRow.type as 'AGENT' | 'HUMAN',
              status: targetRow.status,
              date_of_arrival: targetRow.date_of_arrival,
              wallet: target.wallet,
              recent_events: recentEvents,
            },
          });
        }
        break;
      }

      default:
        this.sendActionResult(resident, msg, false, 'unknown_action');
    }
  }

  /** Broadcast perception to all connected residents and their spectators */
  broadcastPerceptions(tick: number): void {
    for (const [id, ws] of this.connections) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const resident = this.world.residents.get(id);
      if (!resident || resident.isDead) continue;

      const perception = this.world.computePerception(resident, tick);
      const msg: ServerMessage = { type: 'perception', data: perception };
      this.send(ws, msg);

      // Also send to any spectators watching this resident
      const spectatorSet = this.spectators.get(id);
      if (spectatorSet) {
        for (const spectatorWs of spectatorSet) {
          this.send(spectatorWs, msg);
        }
      }
    }

    // Also broadcast for residents who have spectators but no player connection
    for (const [id, spectatorSet] of this.spectators) {
      if (this.connections.has(id)) continue; // already handled above
      const resident = this.world.residents.get(id);
      if (!resident || resident.isDead) continue;

      const perception = this.world.computePerception(resident, tick);
      const msg: ServerMessage = { type: 'perception', data: perception };
      for (const spectatorWs of spectatorSet) {
        this.send(spectatorWs, msg);
      }
    }
  }

  /** Send to specific WebSocket */
  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Send error to WebSocket */
  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: 'error', code, message });
  }

  /** Send action result */
  private sendActionResult(
    resident: ResidentEntity,
    msg: ClientMessage,
    success: boolean,
    reason?: string
  ): void {
    if (!resident.ws) return;
    const requestId = ('request_id' in msg ? msg.request_id : undefined) || '';
    this.send(resident.ws, {
      type: 'action_result',
      request_id: requestId,
      status: success ? 'ok' : 'error',
      reason: reason,
    });
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}
