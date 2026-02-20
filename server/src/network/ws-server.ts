import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { verifyToken } from '../auth/jwt.js';
import { type World, type ResidentEntity, computeCondition } from '../simulation/world.js';
import type { ClientMessage, ServerMessage } from '@otra/shared';
import { WALK_SPEED, RUN_SPEED, TILE_SIZE, ENERGY_COST_SPEAK, ENERGY_COST_SHOUT, STARTING_HOUR, ARREST_RANGE, ARREST_BOUNTY, ENERGY_COST_ARREST, LOITER_SENTENCE_GAME_HOURS, FORAGE_RANGE, ENERGY_COST_FORAGE, REFERRAL_MATURITY_MS, WAKE_COOLDOWN_MS, WAKE_MIN_ENERGY } from '@otra/shared';
import {
  logEvent, getResident, getRecentEventsForResident,
  markResidentDeparted, markBodyProcessed, updateCarryingBody,
  getOpenPetitions, addInventoryItem,
  updateCarryingSuspect, updatePrisonState,
  getClaimsForResident,
  getReferralStats, getClaimableReferrals, claimReferrals,
} from '../db/queries.js';
import { buyItem, SHOP_CATALOG, getShopItem } from '../economy/shop.js';
import { collectUbi } from '../economy/ubi.js';
import { consumeItem } from '../economy/consume.js';
import { applyForJob, quitJob, listAvailableJobs } from '../economy/jobs.js';
import { writePetition, voteOnPetition } from '../civic/petitions.js';
import { enterBuilding, exitBuilding, useToilet } from '../buildings/building-actions.js';
import { findPath } from '../simulation/pathfinding.js';
import { sendWebhook } from './webhooks.js';
import { linkGithub, claimIssue, claimPr } from '../github/github-guild.js';
import { getChangelogVersion, getLatestChangelogEntry } from './http-routes.js';
import { v4 as uuid } from 'uuid';
import {
  ENERGY_COST_COLLECT_BODY, BODY_COLLECT_RANGE, BODY_BOUNTY,
  GIVE_RANGE, ENERGY_COST_GIVE,
} from '@otra/shared';

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
        employment: resident.employment ? { job: resident.employment.job, on_shift: resident.employment.onShift } : null,
        agent_framework: resident.agentFramework ?? undefined,
      },
      map_url: '/api/map',
      world_time: this.world.worldTime + STARTING_HOUR * 3600,
    });

    // Send system announcement if there's a new version
    const latestEntry = getLatestChangelogEntry();
    if (latestEntry) {
      const version = getChangelogVersion();
      this.send(ws, {
        type: 'system_announcement',
        title: latestEntry.title,
        message: latestEntry.changes.join('; '),
        version,
      });
      resident.pendingNotifications.push(
        `System update v${version}: ${latestEntry.title}. See /developer.html for details.`
      );
    }

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
      // Release suspect if officer disconnects while carrying one
      if (resident.carryingSuspectId) {
        const suspect = this.world.residents.get(resident.carryingSuspectId);
        if (suspect) {
          suspect.arrestedBy = null;
          suspect.pendingNotifications.push('The officer escorting you disconnected. You are free.');
          updatePrisonState(suspect.id, null, null);
        }
        resident.carryingSuspectId = null;
        updateCarryingSuspect(resident.id, null);
      }

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
        employment: resident.employment ? { job: resident.employment.job, on_shift: resident.employment.onShift } : null,
        agent_framework: resident.agentFramework ?? undefined,
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

  private async handleAction(resident: ResidentEntity, msg: ClientMessage): Promise<void> {
    // Request ID deduplication
    const requestId = ('request_id' in msg ? msg.request_id : undefined) || '';
    if (requestId) {
      const now = Date.now();
      // Clean expired entries (>30s old)
      for (const [id, ts] of resident.recentRequestIds) {
        if (now - ts > 30_000) resident.recentRequestIds.delete(id);
      }
      // Reject duplicate
      if (resident.recentRequestIds.has(requestId)) {
        this.sendActionResult(resident, msg, true, 'duplicate_request');
        return;
      }
      // Record this request
      resident.recentRequestIds.set(requestId, now);
    }

    if (resident.isDead) {
      this.sendActionResult(resident, msg, false, 'resident_dead');
      return;
    }

    // Imprisoned residents can only speak and inspect
    if (resident.arrestedBy || resident.prisonSentenceEnd) {
      if (msg.type !== 'inspect' && msg.type !== 'speak') {
        this.sendActionResult(resident, msg, false, 'imprisoned');
        return;
      }
    }

    switch (msg.type) {
      case 'move': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.needs.energy <= 0) {
          this.sendActionResult(resident, msg, false, 'exhausted', { energy_current: resident.needs.energy });
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
          this.sendActionResult(resident, msg, false, 'exhausted', { energy_current: resident.needs.energy });
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
          this.sendActionResult(resident, msg, false,
            'invalid_params: move_to requires either {"target":"building-id"} or {"x":number,"y":number} in params');
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
        const directedTo = msg.params?.to || null;
        if (text.length === 0 || text.length > 280) {
          this.sendActionResult(resident, msg, false, 'invalid_text');
          return;
        }
        // Validate directed target exists if specified
        if (directedTo && !this.world.residents.has(directedTo)) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return;
        }
        const cost = volume === 'shout' ? ENERGY_COST_SHOUT : ENERGY_COST_SPEAK;
        if (resident.needs.energy < cost) {
          this.sendActionResult(resident, msg, false, 'insufficient_energy', { energy_needed: cost, energy_current: resident.needs.energy });
          return;
        }
        resident.needs.energy -= cost;
        resident.pendingSpeech.push({ text, volume, time: Date.now(), directedTo });
        logEvent('speak', resident.id, directedTo, null, resident.x, resident.y, { text, volume, to: directedTo });
        this.sendActionResult(resident, msg, true);
        break;
      }

      case 'sleep': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'already_sleeping');
          return;
        }
        if (resident.needs.energy >= 90) {
          this.sendActionResult(resident, msg, false, 'not_tired', { energy_current: resident.needs.energy });
          return;
        }
        // Cancel active pathfinding
        resident.pathWaypoints = null;
        resident.pathTargetBuilding = null;
        resident.pathBlockedTicks = 0;

        resident.isSleeping = true;
        resident.sleepStartedAt = Date.now();
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
        // Prevent sleep-wake thrashing: minimum 30s of sleep
        const sleepDuration = Date.now() - resident.sleepStartedAt;
        if (sleepDuration < WAKE_COOLDOWN_MS) {
          this.sendActionResult(resident, msg, false, 'too_soon', { retry_after_ms: WAKE_COOLDOWN_MS - sleepDuration });
          return;
        }
        // Prevent waking at near-zero energy (would just re-collapse)
        if (resident.needs.energy < WAKE_MIN_ENERGY) {
          this.sendActionResult(resident, msg, false, 'too_tired', { energy_needed: WAKE_MIN_ENERGY, energy_current: resident.needs.energy });
          return;
        }
        resident.isSleeping = false;
        resident.sleepStartedAt = 0;
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

        // Webhook: notify about available shifts when entering a building
        if (enterResult.success && resident.webhookUrl && !resident.employment) {
          const jobs = listAvailableJobs();
          const buildingJobs = jobs.filter(j => j.building_id === buildingId && j.openings > 0);
          for (const job of buildingJobs) {
            sendWebhook(resident, 'shift_available', {
              building_id: buildingId,
              job_id: job.id,
              job_title: job.title,
              wage: job.wage,
              shift_hours: job.shift_hours,
              openings: job.openings,
              description: job.description,
            });
          }
        }
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
        this.sendActionResult(resident, msg, buyResult.success, buyResult.message,
          buyResult.success ? {
            item: buyResult.item,
            wallet: resident.wallet,
            inventory: resident.inventory,
          } : undefined);
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
        this.sendActionResult(resident, msg, ubiResult.success, ubiResult.message,
          ubiResult.success
            ? { amount: ubiResult.amount, wallet: ubiResult.newBalance }
            : { cooldown_remaining: ubiResult.cooldownRemaining });
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
        this.sendActionResult(resident, msg, eatResult.success, eatResult.message,
          eatResult.success ? { effects: eatResult.effects, inventory: resident.inventory } : undefined);
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
        this.sendActionResult(resident, msg, drinkResult.success, drinkResult.message,
          drinkResult.success ? { effects: drinkResult.effects, inventory: resident.inventory } : undefined);
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
              agent_framework: targetRow.agent_framework ?? undefined,
              bio: targetRow.bio || undefined,
              condition: target.isDead ? undefined : computeCondition(target),
              inventory_count: target.inventory.reduce((sum, i) => sum + i.quantity, 0),
              current_building: target.currentBuilding,
              employment: target.employment ? { job: target.employment.job, on_shift: target.employment.onShift } : null,
              law_breaking: target.lawBreaking.length > 0 ? target.lawBreaking : undefined,
              is_imprisoned: target.prisonSentenceEnd !== null ? true : undefined,
              recent_events: recentEvents,
            },
          });
        }
        break;
      }

      case 'trade': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        const tradeTargetId = msg.params?.target_id;
        const offerQuid = msg.params?.offer_quid ?? 0;
        const requestQuid = msg.params?.request_quid ?? 0;

        if (!tradeTargetId) {
          this.sendActionResult(resident, msg, false, 'missing_target_id');
          return;
        }
        if (requestQuid !== 0) {
          this.sendActionResult(resident, msg, false, 'request_quid must be 0 (requesting QUID from others is not yet supported)');
          return;
        }
        if (offerQuid <= 0 || !Number.isInteger(offerQuid)) {
          this.sendActionResult(resident, msg, false, 'offer_quid must be a positive integer');
          return;
        }
        if (resident.wallet < offerQuid) {
          this.sendActionResult(resident, msg, false, `Not enough QUID (need ${offerQuid}, have ${resident.wallet})`);
          return;
        }

        const tradeTarget = this.world.residents.get(tradeTargetId);
        if (!tradeTarget) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return;
        }
        if (tradeTarget.isDead) {
          this.sendActionResult(resident, msg, false, 'target_is_dead');
          return;
        }

        // Must be nearby (within 100px)
        const tdx = tradeTarget.x - resident.x;
        const tdy = tradeTarget.y - resident.y;
        const tradeDist = Math.sqrt(tdx * tdx + tdy * tdy);
        if (tradeDist > 100) {
          this.sendActionResult(resident, msg, false, 'target_too_far');
          return;
        }

        // Execute transfer
        resident.wallet -= offerQuid;
        tradeTarget.wallet += offerQuid;

        logEvent('trade', resident.id, tradeTargetId, null, resident.x, resident.y, {
          offer_quid: offerQuid, sender_wallet: resident.wallet, receiver_wallet: tradeTarget.wallet,
        });

        // Notify sender
        this.sendActionResult(resident, msg, true, `Gave ${offerQuid} QUID to ${tradeTarget.preferredName}`, {
          offer_quid: offerQuid,
          wallet: resident.wallet,
          target_id: tradeTargetId,
          target_name: tradeTarget.preferredName,
        });

        // Notify receiver via their pending notifications
        tradeTarget.pendingNotifications.push(`Received ${offerQuid} QUID from ${resident.preferredName}.`);
        sendWebhook(tradeTarget, 'trade_received', {
          amount: offerQuid,
          from_id: resident.id,
          from_name: resident.preferredName,
          wallet: tradeTarget.wallet,
        });
        break;
      }

      case 'give': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        const giveTargetId = msg.params?.target_id;
        const giveItemId = msg.params?.item_id;
        const giveQuantity = msg.params?.quantity ?? 1;

        if (!giveTargetId) {
          this.sendActionResult(resident, msg, false, 'missing_target_id');
          return;
        }
        if (!giveItemId) {
          this.sendActionResult(resident, msg, false, 'missing_item_id');
          return;
        }
        if (giveQuantity < 1 || !Number.isInteger(giveQuantity)) {
          this.sendActionResult(resident, msg, false, 'quantity must be a positive integer');
          return;
        }

        // Find item in sender's inventory
        const giveItem = resident.inventory.find(i => i.id === giveItemId);
        if (!giveItem) {
          this.sendActionResult(resident, msg, false, 'item_not_found');
          return;
        }
        if (giveItem.quantity < giveQuantity) {
          this.sendActionResult(resident, msg, false, `Not enough items (have ${giveItem.quantity}, giving ${giveQuantity})`);
          return;
        }

        const giveTarget = this.world.residents.get(giveTargetId);
        if (!giveTarget) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return;
        }
        if (giveTarget.isDead) {
          this.sendActionResult(resident, msg, false, 'target_is_dead');
          return;
        }

        // Must be nearby
        const gdx = giveTarget.x - resident.x;
        const gdy = giveTarget.y - resident.y;
        const giveDist = Math.sqrt(gdx * gdx + gdy * gdy);
        if (giveDist > GIVE_RANGE) {
          this.sendActionResult(resident, msg, false, 'target_too_far');
          return;
        }

        // Deduct energy
        resident.needs.energy = Math.max(0, resident.needs.energy - ENERGY_COST_GIVE);

        // Remove/decrement from sender's in-memory inventory
        const itemType = giveItem.type;
        giveItem.quantity -= giveQuantity;
        if (giveItem.quantity <= 0) {
          resident.inventory = resident.inventory.filter(i => i.id !== giveItemId);
        }

        // Add to receiver's in-memory inventory (stack if same type)
        const existingTargetItem = giveTarget.inventory.find(i => i.type === itemType);
        if (existingTargetItem) {
          existingTargetItem.quantity += giveQuantity;
        } else {
          giveTarget.inventory.push({
            id: uuid(),
            type: itemType,
            quantity: giveQuantity,
          });
        }

        // Persist to DB
        addInventoryItem(giveTarget.id, itemType, giveQuantity, -1);

        // Get a human-readable name for the item
        const shopItemDef = getShopItem(itemType);
        const itemName = shopItemDef?.name || itemType;

        logEvent('give', resident.id, giveTargetId, null, resident.x, resident.y, {
          item_type: itemType,
          item_name: itemName,
          quantity: giveQuantity,
        });

        // Notify sender
        this.sendActionResult(resident, msg, true, `Gave ${giveQuantity}x ${itemName} to ${giveTarget.preferredName}`, {
          item_type: itemType,
          quantity: giveQuantity,
          target_id: giveTargetId,
          target_name: giveTarget.preferredName,
          inventory: resident.inventory,
        });

        // Notify receiver
        giveTarget.pendingNotifications.push(`Received ${giveQuantity}x ${itemName} from ${resident.preferredName}.`);
        sendWebhook(giveTarget, 'gift_received', {
          item_type: itemType,
          item_name: itemName,
          quantity: giveQuantity,
          from_id: resident.id,
          from_name: resident.preferredName,
          inventory: giveTarget.inventory,
        });
        break;
      }

      // === Employment ===

      case 'apply_job': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentBuilding !== 'council-hall') {
          this.sendActionResult(resident, msg, false, 'Must be inside Council Hall to apply for a job');
          return;
        }
        const jobId = msg.params?.job_id;
        if (!jobId) {
          const jobs = listAvailableJobs();
          this.sendActionResult(resident, msg, false, 'missing job_id. Send list_jobs to see available positions.', {
            available_jobs: jobs,
          });
          return;
        }
        const applyResult = applyForJob(resident, jobId);
        this.sendActionResult(resident, msg, applyResult.success, applyResult.message,
          applyResult.success && applyResult.job
            ? { job_id: applyResult.job.id, job_title: applyResult.job.title, wage: applyResult.job.wage_per_shift, building_id: applyResult.job.building_id }
            : applyResult.available_jobs ? { available_jobs: applyResult.available_jobs } : undefined);
        break;
      }

      case 'quit_job': {
        // Release suspect if quitting officer is carrying one
        if (resident.carryingSuspectId) {
          const suspect = this.world.residents.get(resident.carryingSuspectId);
          if (suspect) {
            suspect.arrestedBy = null;
            suspect.pendingNotifications.push('The officer escorting you has quit. You are free.');
            updatePrisonState(suspect.id, null, null);
          }
          resident.carryingSuspectId = null;
          updateCarryingSuspect(resident.id, null);
        }
        const quitResult = quitJob(resident);
        this.sendActionResult(resident, msg, quitResult.success, quitResult.message);
        break;
      }

      case 'list_jobs': {
        const jobs = listAvailableJobs();
        this.sendActionResult(resident, msg, true, undefined, { jobs });
        break;
      }

      // === Petitions ===

      case 'write_petition': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentBuilding !== 'council-hall') {
          this.sendActionResult(resident, msg, false, 'Must be inside Council Hall to write a petition');
          return;
        }
        const category = msg.params?.category;
        const description = msg.params?.description;
        if (!category || !description) {
          this.sendActionResult(resident, msg, false, 'missing category or description');
          return;
        }
        const petitionResult = writePetition(resident, category, description);
        this.sendActionResult(resident, msg, petitionResult.success, petitionResult.message,
          petitionResult.success && petitionResult.petition
            ? { petition_id: petitionResult.petition.id, category, description }
            : undefined);
        break;
      }

      case 'vote_petition': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentBuilding !== 'council-hall') {
          this.sendActionResult(resident, msg, false, 'Must be inside Council Hall to vote');
          return;
        }
        const petitionId = msg.params?.petition_id;
        if (!petitionId) {
          this.sendActionResult(resident, msg, false, 'missing petition_id');
          return;
        }
        const voteValue = msg.params?.vote || 'for';
        const voteResult = voteOnPetition(resident, petitionId, voteValue);
        this.sendActionResult(resident, msg, voteResult.success, voteResult.message);
        break;
      }

      case 'list_petitions': {
        const openPetitions = getOpenPetitions();
        this.sendActionResult(resident, msg, true, undefined, { petitions: openPetitions });
        break;
      }

      // === Departure ===

      case 'depart': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentBuilding !== 'train-station') {
          this.sendActionResult(resident, msg, false, 'Must be inside the Train Station to depart');
          return;
        }

        // Mark as departed
        markResidentDeparted(resident.id);
        logEvent('depart', resident.id, null, 'train-station', resident.x, resident.y, {
          name: resident.preferredName, passport_no: resident.passportNo,
        });

        // Send final action result before closing
        this.sendActionResult(resident, msg, true, `${resident.preferredName} has departed Otra City. Safe travels.`);

        // Send webhook
        sendWebhook(resident, 'depart', { x: resident.x, y: resident.y });

        // Remove from world and close connection
        resident.isDead = true; // prevents further processing
        this.world.residents.delete(resident.id);
        if (resident.ws) {
          resident.ws.close(1000, 'Departed');
          resident.ws = null;
        }
        this.connections.delete(resident.id);

        console.log(`[World] ${resident.preferredName} (${resident.passportNo}) departed Otra City`);
        break;
      }

      // === Body Collection ===

      case 'collect_body': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.carryingBodyId) {
          this.sendActionResult(resident, msg, false, 'Already carrying a body. Go to the mortuary to process it.');
          return;
        }
        if (resident.needs.energy < ENERGY_COST_COLLECT_BODY) {
          this.sendActionResult(resident, msg, false, 'Not enough energy to collect a body', { energy_needed: ENERGY_COST_COLLECT_BODY, energy_current: resident.needs.energy });
          return;
        }

        const bodyId = msg.params?.body_id;
        if (!bodyId) {
          this.sendActionResult(resident, msg, false, 'missing body_id');
          return;
        }

        const body = this.world.residents.get(bodyId);
        if (!body || !body.isDead) {
          this.sendActionResult(resident, msg, false, 'body_not_found');
          return;
        }

        // Check distance
        const bdx = body.x - resident.x;
        const bdy = body.y - resident.y;
        const bodyDist = Math.sqrt(bdx * bdx + bdy * bdy);
        if (bodyDist > BODY_COLLECT_RANGE) {
          this.sendActionResult(resident, msg, false, 'Too far from body');
          return;
        }

        // Pick up the body
        resident.needs.energy -= ENERGY_COST_COLLECT_BODY;
        resident.carryingBodyId = bodyId;
        updateCarryingBody(resident.id, bodyId);

        // Remove body from visible world (move it off-map)
        body.x = -9999;
        body.y = -9999;

        logEvent('collect_body', resident.id, bodyId, null, resident.x, resident.y, {
          body_name: body.preferredName,
        });
        this.sendActionResult(resident, msg, true,
          `Collected the body of ${body.preferredName}. Take it to the Council Mortuary.`, {
          body_id: bodyId,
          body_name: body.preferredName,
        });
        break;
      }

      case 'process_body': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentBuilding !== 'council-mortuary') {
          this.sendActionResult(resident, msg, false, 'Must be inside the Council Mortuary');
          return;
        }
        if (!resident.carryingBodyId) {
          this.sendActionResult(resident, msg, false, 'Not carrying a body');
          return;
        }

        const processedBodyId = resident.carryingBodyId;
        const processedBody = this.world.residents.get(processedBodyId);

        // Process the body
        markBodyProcessed(processedBodyId);
        resident.carryingBodyId = null;
        updateCarryingBody(resident.id, null);

        // Pay bounty
        resident.wallet += BODY_BOUNTY;

        // Remove body from world
        if (processedBody) {
          this.world.residents.delete(processedBodyId);
        }

        logEvent('process_body', resident.id, processedBodyId, 'council-mortuary', resident.x, resident.y, {
          bounty: BODY_BOUNTY, wallet: resident.wallet,
          body_name: processedBody?.preferredName ?? 'unknown',
        });

        this.sendActionResult(resident, msg, true,
          `Body processed. Received ${BODY_BOUNTY} QUID bounty.`, {
          bounty: BODY_BOUNTY,
          wallet: resident.wallet,
          body_id: processedBodyId,
        });

        resident.pendingNotifications.push(`Processed body at mortuary. Earned ${BODY_BOUNTY} QUID.`);
        break;
      }

      // === Law Enforcement ===

      case 'arrest': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentJobId !== 'police-officer') {
          this.sendActionResult(resident, msg, false, 'Only police officers can arrest');
          return;
        }
        if (resident.carryingSuspectId) {
          this.sendActionResult(resident, msg, false, 'Already escorting a suspect. Book them at the Police Station first.');
          return;
        }
        if (resident.needs.energy < ENERGY_COST_ARREST) {
          this.sendActionResult(resident, msg, false, 'Not enough energy to arrest', { energy_needed: ENERGY_COST_ARREST, energy_current: resident.needs.energy });
          return;
        }

        const arrestTargetId = msg.params?.target_id;
        if (!arrestTargetId) {
          this.sendActionResult(resident, msg, false, 'missing target_id');
          return;
        }

        const suspect = this.world.residents.get(arrestTargetId);
        if (!suspect) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return;
        }
        if (suspect.isDead) {
          this.sendActionResult(resident, msg, false, 'target_is_dead');
          return;
        }
        if (suspect.lawBreaking.length === 0) {
          this.sendActionResult(resident, msg, false, 'Target is not breaking any laws');
          return;
        }
        if (suspect.arrestedBy) {
          this.sendActionResult(resident, msg, false, 'Target is already arrested');
          return;
        }

        // Check distance
        const adx = suspect.x - resident.x;
        const ady = suspect.y - resident.y;
        const arrestDist = Math.sqrt(adx * adx + ady * ady);
        if (arrestDist > ARREST_RANGE) {
          this.sendActionResult(resident, msg, false, 'Target too far away');
          return;
        }

        // If the suspect is a police officer carrying someone, release their suspect first
        if (suspect.carryingSuspectId) {
          const suspectsSuspect = this.world.residents.get(suspect.carryingSuspectId);
          if (suspectsSuspect) {
            suspectsSuspect.arrestedBy = null;
            suspectsSuspect.pendingNotifications.push('The officer escorting you was arrested. You are free.');
            updatePrisonState(suspectsSuspect.id, null, null);
          }
          suspect.carryingSuspectId = null;
          updateCarryingSuspect(suspect.id, null);
        }

        // Execute arrest
        resident.needs.energy -= ENERGY_COST_ARREST;
        resident.carryingSuspectId = suspect.id;
        suspect.arrestedBy = resident.id;
        suspect.velocityX = 0;
        suspect.velocityY = 0;
        suspect.speed = 'stop';
        suspect.pathWaypoints = null;
        suspect.pathTargetBuilding = null;
        suspect.pathBlockedTicks = 0;

        // Persist
        updateCarryingSuspect(resident.id, suspect.id);
        updatePrisonState(suspect.id, resident.id, null);

        logEvent('arrest', resident.id, suspect.id, null, resident.x, resident.y, {
          suspect_name: suspect.preferredName,
          offenses: suspect.lawBreaking,
        });

        this.sendActionResult(resident, msg, true,
          `Arrested ${suspect.preferredName}. Take them to the Police Station to book.`, {
          suspect_id: suspect.id,
          suspect_name: suspect.preferredName,
          offenses: suspect.lawBreaking,
        });

        suspect.pendingNotifications.push(`You have been arrested by ${resident.preferredName}.`);
        sendWebhook(suspect, 'arrested', {
          officer_id: resident.id,
          officer_name: resident.preferredName,
          offenses: suspect.lawBreaking,
        });
        sendWebhook(resident, 'arrest', {
          suspect_id: suspect.id,
          suspect_name: suspect.preferredName,
          offenses: suspect.lawBreaking,
        });
        break;
      }

      case 'book_suspect': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.currentBuilding !== 'police-station') {
          this.sendActionResult(resident, msg, false, 'Must be inside the Police Station');
          return;
        }
        if (!resident.carryingSuspectId) {
          this.sendActionResult(resident, msg, false, 'Not escorting a suspect');
          return;
        }

        const bookedSuspect = this.world.residents.get(resident.carryingSuspectId);
        if (!bookedSuspect || bookedSuspect.isDead) {
          // Suspect gone — clear state
          resident.carryingSuspectId = null;
          updateCarryingSuspect(resident.id, null);
          this.sendActionResult(resident, msg, false, 'Suspect no longer available');
          return;
        }

        // Determine sentence (based on offenses)
        const sentenceGameHours = LOITER_SENTENCE_GAME_HOURS; // 2 game-hours for loitering
        const sentenceGameSeconds = sentenceGameHours * 3600;
        const sentenceEnd = this.world.worldTime + sentenceGameSeconds;

        // Book the suspect into prison
        bookedSuspect.prisonSentenceEnd = sentenceEnd;
        bookedSuspect.currentBuilding = 'police-station';

        // Clear officer's carry state
        resident.carryingSuspectId = null;
        updateCarryingSuspect(resident.id, null);

        // Pay officer bounty
        resident.wallet += ARREST_BOUNTY;

        // Persist
        updatePrisonState(bookedSuspect.id, resident.id, sentenceEnd);

        logEvent('book_suspect', resident.id, bookedSuspect.id, 'police-station', resident.x, resident.y, {
          suspect_name: bookedSuspect.preferredName,
          sentence_game_hours: sentenceGameHours,
          bounty: ARREST_BOUNTY,
        });

        this.sendActionResult(resident, msg, true,
          `Booked ${bookedSuspect.preferredName}. Sentence: ${sentenceGameHours} game hours. Earned ${ARREST_BOUNTY} QUID bounty.`, {
          suspect_id: bookedSuspect.id,
          suspect_name: bookedSuspect.preferredName,
          sentence_game_hours: sentenceGameHours,
          bounty: ARREST_BOUNTY,
          wallet: resident.wallet,
        });

        bookedSuspect.pendingNotifications.push(
          `You have been booked into prison for ${sentenceGameHours} game hours. Offenses: ${bookedSuspect.lawBreaking.join(', ')}.`
        );
        sendWebhook(bookedSuspect, 'imprisoned', {
          officer_id: resident.id,
          officer_name: resident.preferredName,
          sentence_game_hours: sentenceGameHours,
          offenses: bookedSuspect.lawBreaking,
        });
        sendWebhook(resident, 'book_suspect', {
          suspect_id: bookedSuspect.id,
          suspect_name: bookedSuspect.preferredName,
          bounty: ARREST_BOUNTY,
          wallet: resident.wallet,
        });

        resident.pendingNotifications.push(`Booked ${bookedSuspect.preferredName} into prison. Earned ${ARREST_BOUNTY} QUID.`);
        break;
      }

      // === Foraging ===

      case 'forage': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'sleeping');
          return;
        }
        if (resident.needs.energy < ENERGY_COST_FORAGE) {
          this.sendActionResult(resident, msg, false, 'Not enough energy to forage', { energy_needed: ENERGY_COST_FORAGE, energy_current: resident.needs.energy });
          return;
        }

        const nodeId = msg.params?.node_id;
        if (!nodeId) {
          this.sendActionResult(resident, msg, false, 'missing node_id');
          return;
        }

        const node = this.world.forageableNodes.get(nodeId);
        if (!node) {
          this.sendActionResult(resident, msg, false, 'node_not_found');
          return;
        }

        // Check distance
        const fdx = node.x - resident.x;
        const fdy = node.y - resident.y;
        const forageDist = Math.sqrt(fdx * fdx + fdy * fdy);
        if (forageDist > FORAGE_RANGE) {
          this.sendActionResult(resident, msg, false, 'Too far from resource node');
          return;
        }

        if (node.usesRemaining <= 0) {
          this.sendActionResult(resident, msg, false, 'This resource is depleted. Try another one.');
          return;
        }

        // Execute forage
        resident.needs.energy = Math.max(0, resident.needs.energy - ENERGY_COST_FORAGE);
        node.usesRemaining--;

        // Mark depleted if exhausted
        if (node.usesRemaining <= 0) {
          node.depletedAt = this.world.worldTime;
        }

        // Determine item to give
        const forageItemType = node.type === 'berry_bush' ? 'wild_berries' : 'spring_water';
        const forageItemName = node.type === 'berry_bush' ? 'Wild Berries' : 'Spring Water';

        // Add to inventory (stack if existing)
        const existingForageItem = resident.inventory.find(i => i.type === forageItemType);
        let forageItemId: string;
        if (existingForageItem) {
          existingForageItem.quantity += 1;
          forageItemId = existingForageItem.id;
        } else {
          forageItemId = uuid();
          resident.inventory.push({
            id: forageItemId,
            type: forageItemType,
            quantity: 1,
          });
        }

        // Persist to DB
        addInventoryItem(resident.id, forageItemType, 1, -1);

        logEvent('forage', resident.id, null, null, resident.x, resident.y, {
          node_id: nodeId, resource_type: node.type, item_type: forageItemType,
          uses_remaining: node.usesRemaining,
        });

        this.sendActionResult(resident, msg, true,
          `Foraged 1x ${forageItemName}. ${node.usesRemaining}/${node.maxUses} uses remaining.`, {
          item: { id: forageItemId, type: forageItemType, quantity: 1 },
          node_uses_remaining: node.usesRemaining,
          inventory: resident.inventory,
        });

        sendWebhook(resident, 'forage', {
          node_id: nodeId,
          resource_type: node.type,
          item_type: forageItemType,
          item_name: forageItemName,
          uses_remaining: node.usesRemaining,
          max_uses: node.maxUses,
          x: resident.x,
          y: resident.y,
        });
        break;
      }

      // === GitHub Guild ===

      case 'link_github': {
        if (resident.currentBuilding !== 'github-guild') {
          this.sendActionResult(resident, msg, false, 'Must be inside the GitHub Guild');
          return;
        }
        const username = msg.params?.github_username;
        if (!username || typeof username !== 'string') {
          this.sendActionResult(resident, msg, false, 'missing github_username');
          return;
        }
        const linkResult = await linkGithub(resident, username);
        if (linkResult.ok) {
          logEvent('link_github', resident.id, null, null, resident.x, resident.y, {
            github_username: username,
          });
          sendWebhook(resident, 'link_github', { github_username: username });
        }
        this.sendActionResult(resident, msg, linkResult.ok, linkResult.message);
        break;
      }

      case 'claim_issue': {
        if (resident.currentBuilding !== 'github-guild') {
          this.sendActionResult(resident, msg, false, 'Must be inside the GitHub Guild');
          return;
        }
        const issueNum = msg.params?.issue_number;
        if (!issueNum || typeof issueNum !== 'number') {
          this.sendActionResult(resident, msg, false, 'missing issue_number');
          return;
        }
        const issueResult = await claimIssue(resident, issueNum, this.world.worldTime);
        if (issueResult.ok) {
          logEvent('claim_issue', resident.id, null, null, resident.x, resident.y, {
            issue_number: issueResult.github_number,
            reward: issueResult.reward,
            tier: issueResult.tier,
            wallet: resident.wallet,
          });
          sendWebhook(resident, 'claim_issue', {
            issue_number: issueResult.github_number,
            reward: issueResult.reward,
            tier: issueResult.tier,
            wallet: resident.wallet,
          });
          resident.pendingNotifications.push(`Earned ${issueResult.reward} QUID for issue #${issueResult.github_number}!`);
        }
        this.sendActionResult(resident, msg, issueResult.ok, issueResult.message, issueResult.ok ? {
          reward: issueResult.reward,
          tier: issueResult.tier,
          github_number: issueResult.github_number,
          wallet: resident.wallet,
        } : undefined);
        break;
      }

      case 'claim_pr': {
        if (resident.currentBuilding !== 'github-guild') {
          this.sendActionResult(resident, msg, false, 'Must be inside the GitHub Guild');
          return;
        }
        const prNum = msg.params?.pr_number;
        if (!prNum || typeof prNum !== 'number') {
          this.sendActionResult(resident, msg, false, 'missing pr_number');
          return;
        }
        const prResult = await claimPr(resident, prNum, this.world.worldTime);
        if (prResult.ok) {
          logEvent('claim_pr', resident.id, null, null, resident.x, resident.y, {
            pr_number: prResult.github_number,
            reward: prResult.reward,
            tier: prResult.tier,
            wallet: resident.wallet,
          });
          sendWebhook(resident, 'claim_pr', {
            pr_number: prResult.github_number,
            reward: prResult.reward,
            tier: prResult.tier,
            wallet: resident.wallet,
          });
          resident.pendingNotifications.push(`Earned ${prResult.reward} QUID for PR #${prResult.github_number} (${prResult.tier})!`);
        }
        this.sendActionResult(resident, msg, prResult.ok, prResult.message, prResult.ok ? {
          reward: prResult.reward,
          tier: prResult.tier,
          github_number: prResult.github_number,
          wallet: resident.wallet,
        } : undefined);
        break;
      }

      case 'list_claims': {
        if (resident.currentBuilding !== 'github-guild') {
          this.sendActionResult(resident, msg, false, 'Must be inside the GitHub Guild');
          return;
        }
        const claims = getClaimsForResident(resident.id);
        this.sendActionResult(resident, msg, true, `You have ${claims.length} claim(s).`, {
          claims: claims.map(c => ({
            type: c.claim_type,
            number: c.github_number,
            tier: c.reward_tier,
            reward: c.reward_amount,
            claimed_at: c.claimed_at,
          })),
          github_username: resident.githubUsername,
        });
        break;
      }

      case 'get_referral_link': {
        if (resident.currentBuilding !== 'tourist-info') {
          this.sendActionResult(resident, msg, false, 'Must be inside Tourist Information');
          return;
        }
        const refStats = getReferralStats(resident.id, REFERRAL_MATURITY_MS);
        this.sendActionResult(resident, msg, true, 'Here is your referral link.', {
          link: `https://otra.city/quick-start?ref=${resident.passportNo}`,
          stats: refStats,
        });
        break;
      }

      case 'claim_referrals': {
        if (resident.currentBuilding !== 'tourist-info') {
          this.sendActionResult(resident, msg, false, 'Must be inside Tourist Information');
          return;
        }
        const claimable = getClaimableReferrals(resident.id, REFERRAL_MATURITY_MS);
        if (claimable.length === 0) {
          const refInfo = getReferralStats(resident.id, REFERRAL_MATURITY_MS);
          if (refInfo.maturing > 0) {
            this.sendActionResult(resident, msg, false, `No claimable referrals yet. ${refInfo.maturing} referral(s) still maturing (new residents must survive 1 day).`);
          } else {
            this.sendActionResult(resident, msg, false, 'No referrals to claim. Share your referral link to invite new residents!');
          }
          return;
        }
        const ids = claimable.map(r => r.id);
        const result = claimReferrals(ids, Date.now());
        resident.wallet += result.total;
        logEvent('referral_claimed', resident.id, null, 'tourist-info', resident.x, resident.y, {
          count: result.count,
          total: result.total,
          wallet: resident.wallet,
        });
        sendWebhook(resident, 'referral_claimed', {
          count: result.count,
          total: result.total,
          wallet: resident.wallet,
        });
        resident.pendingNotifications.push(`Claimed ${result.count} referral reward${result.count !== 1 ? 's' : ''} — earned Ɋ${result.total}!`);
        this.sendActionResult(resident, msg, true, `Claimed ${result.count} referral(s).`, {
          claimed_count: result.count,
          reward_total: result.total,
          wallet: resident.wallet,
        });
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

      // Send any pending pain messages to the connected agent
      for (const pain of resident.pendingPainMessages) {
        this.send(ws, {
          type: 'pain',
          message: pain.message,
          source: pain.source,
          intensity: pain.intensity,
          needs: pain.needs,
        });
      }

      // Also send full-world perception to any spectators watching this resident
      const spectatorSet = this.spectators.get(id);
      if (spectatorSet) {
        const spectatorPerception = this.world.computeSpectatorPerception(resident, tick);
        const spectatorMsg: ServerMessage = { type: 'perception', data: spectatorPerception };
        for (const spectatorWs of spectatorSet) {
          this.send(spectatorWs, spectatorMsg);
        }
      }
    }

    // Also broadcast for residents who have spectators but no player connection
    for (const [id, spectatorSet] of this.spectators) {
      if (this.connections.has(id)) continue; // already handled above
      const resident = this.world.residents.get(id);
      if (!resident || resident.isDead) continue;

      const spectatorPerception = this.world.computeSpectatorPerception(resident, tick);
      const spectatorMsg: ServerMessage = { type: 'perception', data: spectatorPerception };
      for (const spectatorWs of spectatorSet) {
        this.send(spectatorWs, spectatorMsg);
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
    reason?: string,
    data?: Record<string, unknown>,
  ): void {
    if (!resident.ws) return;
    const requestId = ('request_id' in msg ? msg.request_id : undefined) || '';
    this.send(resident.ws, {
      type: 'action_result',
      request_id: requestId,
      status: success ? 'ok' : 'error',
      reason: reason,
      data: data,
    });
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}
