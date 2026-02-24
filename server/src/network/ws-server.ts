import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { verifyToken } from '../auth/jwt.js';
import { type World, type ResidentEntity, computeCondition } from '../simulation/world.js';
import type { ClientMessage, ServerMessage, BuildingType } from '@otra/shared';
import { CITY_CONFIG, renderMessage, WALK_SPEED, RUN_SPEED, TILE_SIZE, ENERGY_COST_SPEAK, ENERGY_COST_SHOUT, STARTING_HOUR, ARREST_RANGE, ARREST_BOUNTY, ENERGY_COST_ARREST, LOITER_SENTENCE_GAME_HOURS, FORAGE_RANGE, ENERGY_COST_FORAGE, REFERRAL_MATURITY_MS, WAKE_COOLDOWN_MS, WAKE_MIN_ENERGY, SPEECH_TURN_TIMEOUT_MS, SPEECH_COOLDOWN_MS, SPEECH_DUPLICATE_WINDOW_MS, SPEECH_DUPLICATE_HISTORY, SPEECH_TTL_TICKS } from '@otra/shared';
import {
  logEvent, getResident, getRecentEventsForResident,
  markResidentDeparted, markBodyProcessed, updateCarryingBody,
  getOpenPetitions, addInventoryItem,
  updateCarryingSuspect, updatePrisonState,
  getReferralStats, getClaimableReferrals, claimReferrals,
  getReputationStats, insertFeedback,
} from '../db/queries.js';
import { buyItem, getShopItem, canBuyItemAtBuilding, isMapItem } from '../economy/shop.js';
import { collectUbi } from '../economy/ubi.js';
import { consumeItem } from '../economy/consume.js';
import { applyForJob, quitJob, listAvailableJobs } from '../economy/jobs.js';
import { writePetition, voteOnPetition } from '../civic/petitions.js';
import { enterBuilding, exitBuilding, useToilet } from '../buildings/building-actions.js';
import { getBuildingType, getBuildingByType } from '../buildings/building-registry.js';
import { findPath } from '../simulation/pathfinding.js';
import { sendWebhook } from './webhooks.js';
import { consumeFeedbackToken } from './feedback.js';
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

  private requireAwake(resident: ResidentEntity, msg: ClientMessage): boolean {
    if (resident.isSleeping) {
      this.sendActionResult(resident, msg, false, 'sleeping');
      return false;
    }
    return true;
  }

  private requireBuildingType(
    resident: ResidentEntity,
    msg: ClientMessage,
    buildingType: BuildingType,
    fallbackName: string,
    purpose?: string
  ): boolean {
    if (!resident.currentBuilding || getBuildingType(resident.currentBuilding) !== buildingType) {
      const building = getBuildingByType(buildingType);
      const suffix = purpose ? ` ${purpose}` : '';
      this.sendActionResult(resident, msg, false, `Must be inside ${building?.name ?? fallbackName}${suffix}`);
      return false;
    }
    return true;
  }

  private handleMovementAndSpeechActions(resident: ResidentEntity, msg: ClientMessage): boolean {
    switch (msg.type) {
      case 'move': {
        if (!this.requireAwake(resident, msg)) return true;
        if (resident.needs.energy <= 0) {
          this.sendActionResult(resident, msg, false, 'exhausted', { energy_current: resident.needs.energy });
          return true;
        }
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
        return true;
      }
      case 'stop': {
        resident.pathWaypoints = null;
        resident.pathTargetBuilding = null;
        resident.pathBlockedTicks = 0;
        resident.velocityX = 0;
        resident.velocityY = 0;
        resident.speed = 'stop';
        this.sendActionResult(resident, msg, true);
        return true;
      }
      case 'face': {
        if (!resident.isSleeping) {
          resident.facing = msg.params?.direction ?? resident.facing;
        }
        this.sendActionResult(resident, msg, true);
        return true;
      }
      case 'move_to': {
        if (!this.requireAwake(resident, msg)) return true;
        if (resident.needs.energy <= 0) {
          this.sendActionResult(resident, msg, false, 'exhausted', { energy_current: resident.needs.energy });
          return true;
        }
        if (resident.currentBuilding) {
          const exitResult = exitBuilding(resident, this.world);
          if (!exitResult.success) {
            this.sendActionResult(resident, msg, false, `Cannot exit building: ${exitResult.message}`);
            return true;
          }
        }

        let targetX: number;
        let targetY: number;
        let targetBuildingId: string | null = null;
        const params = msg.params as { target?: string; x?: number; y?: number } | undefined;

        if (params && 'target' in params && typeof params.target === 'string') {
          const building = this.world.map.data.buildings.find(b => b.id === params.target);
          if (!building) {
            this.sendActionResult(resident, msg, false, 'building_not_found');
            return true;
          }
          if (building.doors.length === 0) {
            this.sendActionResult(resident, msg, false, 'building_has_no_door');
            return true;
          }
          const door = building.doors[0];
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
          return true;
        }

        const path = findPath(this.world.map, resident.x, resident.y, targetX, targetY);
        if (!path) {
          this.sendActionResult(resident, msg, false, 'no_path_found');
          return true;
        }

        resident.pathWaypoints = path;
        resident.pathIndex = 0;
        resident.pathTargetBuilding = targetBuildingId;
        resident.pathBlockedTicks = 0;
        logEvent('move_to', resident.id, null, targetBuildingId, resident.x, resident.y, {
          target_x: targetX, target_y: targetY, waypoint_count: path.length,
        });
        this.sendActionResult(resident, msg, true);
        return true;
      }
      case 'speak': {
        if (!this.requireAwake(resident, msg)) return true;
        const text = msg.params?.text || '';
        const volume = msg.params?.volume || 'normal';
        const directedTo = msg.params?.to || null;
        if (text.length === 0 || text.length > 280) {
          this.sendActionResult(resident, msg, false, 'invalid_text');
          return true;
        }
        const now = Date.now();
        const sinceLast = now - resident.lastSpeechTime;
        if (sinceLast < SPEECH_COOLDOWN_MS) {
          this.sendActionResult(resident, msg, false, 'speech_cooldown', {
            wait_ms: SPEECH_COOLDOWN_MS - sinceLast,
          });
          return true;
        }
        const normalizedText = text.trim().toLowerCase();
        resident.recentSpeechTexts = resident.recentSpeechTexts.filter(
          s => now - s.time < SPEECH_DUPLICATE_WINDOW_MS
        );
        if (resident.recentSpeechTexts.some(s => s.text === normalizedText)) {
          this.sendActionResult(resident, msg, false, 'duplicate_speech', {
            window_seconds: Math.round(SPEECH_DUPLICATE_WINDOW_MS / 1000),
          });
          return true;
        }
        if (directedTo && !this.world.residents.has(directedTo)) {
          this.sendActionResult(resident, msg, false, 'target_not_found');
          return true;
        }
        if (directedTo) {
          const awaitingSince = resident.awaitingReplyFrom.get(directedTo);
          if (awaitingSince !== undefined) {
            const elapsed = Date.now() - awaitingSince;
            if (elapsed < SPEECH_TURN_TIMEOUT_MS) {
              const target = this.world.residents.get(directedTo);
              this.sendActionResult(resident, msg, false, 'awaiting_reply', {
                target_id: directedTo,
                target_name: target?.preferredName ?? 'unknown',
                wait_ms: SPEECH_TURN_TIMEOUT_MS - elapsed,
              });
              return true;
            }
            resident.awaitingReplyFrom.delete(directedTo);
          }
        }
        const cost = volume === 'shout' ? ENERGY_COST_SHOUT : ENERGY_COST_SPEAK;
        if (resident.needs.energy < cost) {
          this.sendActionResult(resident, msg, false, 'insufficient_energy', { energy_needed: cost, energy_current: resident.needs.energy });
          return true;
        }
        resident.needs.energy -= cost;
        resident.pendingSpeech.push({ id: uuid(), text, volume, time: now, directedTo, ticksRemaining: SPEECH_TTL_TICKS });
        logEvent('speak', resident.id, directedTo, null, resident.x, resident.y, { text, volume, to: directedTo });
        resident.lastSpeechTime = now;
        resident.recentSpeechTexts.push({ text: normalizedText, time: now });
        if (resident.recentSpeechTexts.length > SPEECH_DUPLICATE_HISTORY) {
          resident.recentSpeechTexts.shift();
        }
        if (directedTo) {
          resident.awaitingReplyFrom.set(directedTo, now);
        }
        this.sendActionResult(resident, msg, true);
        return true;
      }
      case 'sleep': {
        if (resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'already_sleeping');
          return true;
        }
        if (resident.needs.energy >= 90) {
          this.sendActionResult(resident, msg, false, 'not_tired', { energy_current: resident.needs.energy });
          return true;
        }
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
        return true;
      }
      case 'wake': {
        if (!resident.isSleeping) {
          this.sendActionResult(resident, msg, false, 'not_sleeping');
          return true;
        }
        const sleepDuration = Date.now() - resident.sleepStartedAt;
        if (sleepDuration < WAKE_COOLDOWN_MS) {
          this.sendActionResult(resident, msg, false, 'too_soon', { retry_after_ms: WAKE_COOLDOWN_MS - sleepDuration });
          return true;
        }
        if (resident.needs.energy < WAKE_MIN_ENERGY) {
          this.sendActionResult(resident, msg, false, 'too_tired', { energy_needed: WAKE_MIN_ENERGY, energy_current: resident.needs.energy });
          return true;
        }
        resident.isSleeping = false;
        resident.sleepStartedAt = 0;
        logEvent('wake', resident.id, null, null, resident.x, resident.y, {});
        this.sendActionResult(resident, msg, true);
        return true;
      }
      case 'enter_building': {
        if (!this.requireAwake(resident, msg)) return true;
        const buildingId = msg.params?.building_id;
        if (!buildingId) {
          this.sendActionResult(resident, msg, false, 'missing_building_id');
          return true;
        }
        const enterResult = enterBuilding(resident, buildingId, this.world);
        logEvent('enter_building', resident.id, null, buildingId, resident.x, resident.y, { success: enterResult.success });
        this.sendActionResult(resident, msg, enterResult.success, enterResult.message);
        if (enterResult.success && (resident.webhookUrl || resident.ws) && !resident.employment) {
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
        return true;
      }
      case 'exit_building': {
        const exitResult = exitBuilding(resident, this.world);
        logEvent('exit_building', resident.id, null, resident.currentBuilding, resident.x, resident.y, { success: exitResult.success });
        this.sendActionResult(resident, msg, exitResult.success, exitResult.message);
        return true;
      }
      default:
        return false;
    }
  }

  private handleEconomyActions(resident: ResidentEntity, msg: ClientMessage): boolean {
    switch (msg.type) {
      case 'buy': {
        const itemType = msg.params?.item_type;
        const quantity = msg.params?.quantity ?? 1;
        if (!itemType) {
          this.sendActionResult(resident, msg, false, 'missing_item_type');
          return true;
        }
        const buildingType = resident.currentBuilding ? getBuildingType(resident.currentBuilding) : null;
        if (!canBuyItemAtBuilding(itemType, buildingType)) {
          const requiredBuilding = isMapItem(itemType)
            ? (getBuildingByType('info')?.name ?? 'Tourist Information')
            : (getBuildingByType('shop')?.name ?? 'a shop');
          this.sendActionResult(resident, msg, false, `Must be inside ${requiredBuilding}`);
          return true;
        }
        const buyResult = buyItem(resident, itemType, quantity);
        if (buyResult.success) {
          const itemPrice = getShopItem(itemType)?.price ?? 0;
          logEvent('buy', resident.id, null, resident.currentBuilding, resident.x, resident.y, {
            item_type: itemType, quantity, cost: itemPrice * quantity,
          });
        }
        this.sendActionResult(resident, msg, buyResult.success, buyResult.message,
          buyResult.success ? {
            item: buyResult.item,
            wallet: resident.wallet,
            inventory: resident.inventory,
          } : undefined);
        return true;
      }
      case 'collect_ubi': {
        if (!this.requireBuildingType(resident, msg, 'bank', 'the bank')) return true;
        const ubiResult = collectUbi(resident);
        if (ubiResult.success) {
          logEvent('collect_ubi', resident.id, null, resident.currentBuilding, resident.x, resident.y, {
            amount: ubiResult.amount, new_balance: ubiResult.newBalance,
          });
        }
        this.sendActionResult(resident, msg, ubiResult.success, ubiResult.message,
          ubiResult.success
            ? { amount: ubiResult.amount, wallet: ubiResult.newBalance }
            : { cooldown_remaining: ubiResult.cooldownRemaining });
        return true;
      }
      case 'use_toilet': {
        const toiletResult = useToilet(resident);
        if (toiletResult.success) {
          logEvent('use_toilet', resident.id, null, resident.currentBuilding, resident.x, resident.y, {});
        }
        this.sendActionResult(resident, msg, toiletResult.success, toiletResult.message);
        return true;
      }
      case 'eat':
      case 'drink':
      case 'consume': {
        const itemId = msg.params?.item_id;
        if (!itemId) {
          this.sendActionResult(resident, msg, false, 'missing_item_id');
          return true;
        }
        const consumeMode = msg.type === 'drink' ? 'drink' : 'eat';
        const result = consumeItem(resident, itemId, consumeMode);
        if (result.success) {
          logEvent(msg.type, resident.id, null, null, resident.x, resident.y, {
            item_id: itemId, effects: result.effects,
          });
        }
        this.sendActionResult(resident, msg, result.success, result.message,
          result.success ? { effects: result.effects, inventory: resident.inventory } : undefined);
        return true;
      }
      default:
        return false;
    }
  }

  private handleTourismAndFeedbackActions(resident: ResidentEntity, msg: ClientMessage): boolean {
    switch (msg.type) {
      case 'get_referral_link': {
        if (!this.requireBuildingType(resident, msg, 'info', 'Tourist Information')) return true;
        const refStats = getReferralStats(resident.id, REFERRAL_MATURITY_MS);
        this.sendActionResult(resident, msg, true, 'Here is your referral link.', {
          link: `https://${CITY_CONFIG.domain}/quick-start?ref=${resident.passportNo}`,
          stats: refStats,
        });
        return true;
      }
      case 'claim_referrals': {
        if (!this.requireBuildingType(resident, msg, 'info', 'Tourist Information')) return true;
        const claimable = getClaimableReferrals(resident.id, REFERRAL_MATURITY_MS);
        if (claimable.length === 0) {
          const refInfo = getReferralStats(resident.id, REFERRAL_MATURITY_MS);
          if (refInfo.maturing > 0) {
            this.sendActionResult(resident, msg, false, `No claimable referrals yet. ${refInfo.maturing} referral(s) still maturing (new residents must survive 1 day).`);
          } else {
            this.sendActionResult(resident, msg, false, 'No referrals to claim. Share your referral link to invite new residents!');
          }
          return true;
        }
        const ids = claimable.map(r => r.id);
        const result = claimReferrals(ids, Date.now());
        resident.wallet += result.total;
        logEvent('referral_claimed', resident.id, null, resident.currentBuilding, resident.x, resident.y, {
          count: result.count,
          total: result.total,
          wallet: resident.wallet,
        });
        sendWebhook(resident, 'referral_claimed', {
          count: result.count,
          total: result.total,
          wallet: resident.wallet,
        });
        resident.pendingNotifications.push(`Claimed ${result.count} referral reward${result.count !== 1 ? 's' : ''} — earned ${CITY_CONFIG.currencySymbol}${result.total}!`);
        this.sendActionResult(resident, msg, true, `Claimed ${result.count} referral(s).`, {
          claimed_count: result.count,
          reward_total: result.total,
          wallet: resident.wallet,
        });
        return true;
      }
      case 'submit_feedback': {
        const feedbackText = (msg as { params?: { text?: string } }).params?.text;
        if (!feedbackText || typeof feedbackText !== 'string' || feedbackText.length < 1 || feedbackText.length > 10000) {
          this.sendActionResult(resident, msg, false, 'text must be 1-10000 characters');
          return true;
        }
        if (!resident.pendingFeedbackToken) {
          this.sendActionResult(resident, msg, false, 'no_pending_feedback');
          return true;
        }
        const tokenData = consumeFeedbackToken(resident.pendingFeedbackToken);
        if (!tokenData) {
          resident.pendingFeedbackPrompt = null;
          resident.pendingFeedbackToken = null;
          this.sendActionResult(resident, msg, false, 'feedback_expired');
          return true;
        }
        const feedbackId = crypto.randomUUID();
        insertFeedback(feedbackId, tokenData.residentId, tokenData.trigger, tokenData.triggerContext, null, feedbackText, null);
        resident.pendingFeedbackPrompt = null;
        resident.pendingFeedbackToken = null;
        logEvent('submit_feedback', resident.id, null, null, resident.x, resident.y, {
          trigger: tokenData.trigger, text_length: feedbackText.length,
        });
        console.log(`[Feedback] ${resident.preferredName} submitted ${tokenData.trigger} feedback`);
        this.sendActionResult(resident, msg, true, 'Thank you for your feedback.');
        return true;
      }
      default:
        return false;
    }
  }

  private handleSocialActions(resident: ResidentEntity, msg: ClientMessage): void {
    switch (msg.type) {
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

        const repStats = getReputationStats(targetId);

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
              reputation: repStats ? {
                economic: repStats.economic,
                social: repStats.social,
                civic: repStats.civic,
                criminal: repStats.criminal,
              } : undefined,
            },
          });
        }
        return;
      }

      case 'trade': {
        if (!this.requireAwake(resident, msg)) return;
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

        const tdx = tradeTarget.x - resident.x;
        const tdy = tradeTarget.y - resident.y;
        const tradeDist = Math.sqrt(tdx * tdx + tdy * tdy);
        if (tradeDist > 100) {
          this.sendActionResult(resident, msg, false, 'target_too_far');
          return;
        }

        resident.wallet -= offerQuid;
        tradeTarget.wallet += offerQuid;

        logEvent('trade', resident.id, tradeTargetId, null, resident.x, resident.y, {
          offer_quid: offerQuid, sender_wallet: resident.wallet, receiver_wallet: tradeTarget.wallet,
        });

        this.sendActionResult(resident, msg, true, `Gave ${offerQuid} QUID to ${tradeTarget.preferredName}`, {
          offer_quid: offerQuid,
          wallet: resident.wallet,
          target_id: tradeTargetId,
          target_name: tradeTarget.preferredName,
        });

        tradeTarget.pendingNotifications.push(`Received ${offerQuid} QUID from ${resident.preferredName}.`);
        sendWebhook(tradeTarget, 'trade_received', {
          amount: offerQuid,
          from_id: resident.id,
          from_name: resident.preferredName,
          wallet: tradeTarget.wallet,
        });
        return;
      }

      case 'give': {
        if (!this.requireAwake(resident, msg)) return;
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

        const gdx = giveTarget.x - resident.x;
        const gdy = giveTarget.y - resident.y;
        const giveDist = Math.sqrt(gdx * gdx + gdy * gdy);
        if (giveDist > GIVE_RANGE) {
          this.sendActionResult(resident, msg, false, 'target_too_far');
          return;
        }

        resident.needs.energy = Math.max(0, resident.needs.energy - ENERGY_COST_GIVE);

        const itemType = giveItem.type;
        giveItem.quantity -= giveQuantity;
        if (giveItem.quantity <= 0) {
          resident.inventory = resident.inventory.filter(i => i.id !== giveItemId);
        }

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

        addInventoryItem(giveTarget.id, itemType, giveQuantity, -1);

        const shopItemDef = getShopItem(itemType);
        const itemName = shopItemDef?.name || itemType;

        logEvent('give', resident.id, giveTargetId, null, resident.x, resident.y, {
          item_type: itemType,
          item_name: itemName,
          quantity: giveQuantity,
        });

        this.sendActionResult(resident, msg, true, `Gave ${giveQuantity}x ${itemName} to ${giveTarget.preferredName}`, {
          item_type: itemType,
          quantity: giveQuantity,
          target_id: giveTargetId,
          target_name: giveTarget.preferredName,
          inventory: resident.inventory,
        });

        giveTarget.pendingNotifications.push(`Received ${giveQuantity}x ${itemName} from ${resident.preferredName}.`);
        sendWebhook(giveTarget, 'gift_received', {
          item_type: itemType,
          item_name: itemName,
          quantity: giveQuantity,
          from_id: resident.id,
          from_name: resident.preferredName,
          inventory: giveTarget.inventory,
        });
        return;
      }
    }
  }

  private handleCivicActions(resident: ResidentEntity, msg: ClientMessage): void {
    switch (msg.type) {
      case 'apply_job': {
        if (!this.requireAwake(resident, msg)) return;
        if (!this.requireBuildingType(resident, msg, 'hall', 'the hall', 'to apply for a job')) return;
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
        return;
      }

      case 'quit_job': {
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
        return;
      }

      case 'list_jobs': {
        const jobs = listAvailableJobs();
        this.sendActionResult(resident, msg, true, undefined, { jobs });
        return;
      }

      case 'write_petition': {
        if (!this.requireAwake(resident, msg)) return;
        if (!this.requireBuildingType(resident, msg, 'hall', 'the hall', 'to write a petition')) return;
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
        return;
      }

      case 'vote_petition': {
        if (!this.requireAwake(resident, msg)) return;
        if (!this.requireBuildingType(resident, msg, 'hall', 'the hall', 'to vote')) return;
        const petitionId = msg.params?.petition_id;
        if (!petitionId) {
          this.sendActionResult(resident, msg, false, 'missing petition_id');
          return;
        }
        const voteValue = msg.params?.vote || 'for';
        const voteResult = voteOnPetition(resident, petitionId, voteValue);
        this.sendActionResult(resident, msg, voteResult.success, voteResult.message);
        return;
      }

      case 'list_petitions': {
        const openPetitions = getOpenPetitions();
        this.sendActionResult(resident, msg, true, undefined, { petitions: openPetitions });
        return;
      }

      case 'depart': {
        if (!this.requireAwake(resident, msg)) return;
        if (!this.requireBuildingType(resident, msg, 'station', 'the station', 'to depart')) return;

        markResidentDeparted(resident.id);
        logEvent('depart', resident.id, null, resident.currentBuilding, resident.x, resident.y, {
          name: resident.preferredName, passport_no: resident.passportNo,
        });

        this.sendActionResult(resident, msg, true, renderMessage(CITY_CONFIG.messages.departAction, { actor: resident.preferredName }));
        sendWebhook(resident, 'depart', { x: resident.x, y: resident.y });

        resident.isDead = true;
        this.world.residents.delete(resident.id);
        if (resident.ws) {
          resident.ws.close(1000, 'Departed');
          resident.ws = null;
        }
        this.connections.delete(resident.id);

        console.log(`[World] ${resident.preferredName} (${resident.passportNo}) departed ${CITY_CONFIG.name}`);
        return;
      }
    }
  }

  private handleSafetyActions(resident: ResidentEntity, msg: ClientMessage): void {
    switch (msg.type) {
      case 'collect_body': {
        if (!this.requireAwake(resident, msg)) return;
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

        const bdx = body.x - resident.x;
        const bdy = body.y - resident.y;
        const bodyDist = Math.sqrt(bdx * bdx + bdy * bdy);
        if (bodyDist > BODY_COLLECT_RANGE) {
          this.sendActionResult(resident, msg, false, 'Too far from body');
          return;
        }

        resident.needs.energy -= ENERGY_COST_COLLECT_BODY;
        resident.carryingBodyId = bodyId;
        updateCarryingBody(resident.id, bodyId);

        body.x = -9999;
        body.y = -9999;

        logEvent('collect_body', resident.id, bodyId, null, resident.x, resident.y, {
          body_name: body.preferredName,
        });
        const mortuaryBuilding = getBuildingByType('mortuary');
        this.sendActionResult(resident, msg, true,
          `Collected the body of ${body.preferredName}. Take it to ${mortuaryBuilding?.name ?? 'the mortuary'}.`, {
          body_id: bodyId,
          body_name: body.preferredName,
        });
        return;
      }

      case 'process_body': {
        if (!this.requireAwake(resident, msg)) return;
        if (!this.requireBuildingType(resident, msg, 'mortuary', 'the mortuary')) return;
        if (!resident.carryingBodyId) {
          this.sendActionResult(resident, msg, false, 'Not carrying a body');
          return;
        }

        const processedBodyId = resident.carryingBodyId;
        const processedBody = this.world.residents.get(processedBodyId);

        markBodyProcessed(processedBodyId);
        resident.carryingBodyId = null;
        updateCarryingBody(resident.id, null);

        resident.wallet += BODY_BOUNTY;

        if (processedBody) {
          this.world.residents.delete(processedBodyId);
        }

        logEvent('process_body', resident.id, processedBodyId, resident.currentBuilding, resident.x, resident.y, {
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
        return;
      }

      case 'arrest': {
        if (!this.requireAwake(resident, msg)) return;
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

        const adx = suspect.x - resident.x;
        const ady = suspect.y - resident.y;
        const arrestDist = Math.sqrt(adx * adx + ady * ady);
        if (arrestDist > ARREST_RANGE) {
          this.sendActionResult(resident, msg, false, 'Target too far away');
          return;
        }

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

        resident.needs.energy -= ENERGY_COST_ARREST;
        resident.carryingSuspectId = suspect.id;
        suspect.arrestedBy = resident.id;
        suspect.velocityX = 0;
        suspect.velocityY = 0;
        suspect.speed = 'stop';
        suspect.pathWaypoints = null;
        suspect.pathTargetBuilding = null;
        suspect.pathBlockedTicks = 0;

        updateCarryingSuspect(resident.id, suspect.id);
        updatePrisonState(suspect.id, resident.id, null);

        logEvent('arrest', resident.id, suspect.id, null, resident.x, resident.y, {
          suspect_name: suspect.preferredName,
          offenses: suspect.lawBreaking,
        });

        const policeBuilding = getBuildingByType('police');
        this.sendActionResult(resident, msg, true,
          `Arrested ${suspect.preferredName}. Take them to ${policeBuilding?.name ?? 'the police station'} to book.`, {
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
        return;
      }

      case 'book_suspect': {
        if (!this.requireAwake(resident, msg)) return;
        if (!this.requireBuildingType(resident, msg, 'police', 'the police station')) return;
        if (!resident.carryingSuspectId) {
          this.sendActionResult(resident, msg, false, 'Not escorting a suspect');
          return;
        }

        const bookedSuspect = this.world.residents.get(resident.carryingSuspectId);
        if (!bookedSuspect || bookedSuspect.isDead) {
          resident.carryingSuspectId = null;
          updateCarryingSuspect(resident.id, null);
          this.sendActionResult(resident, msg, false, 'Suspect no longer available');
          return;
        }

        const sentenceGameHours = LOITER_SENTENCE_GAME_HOURS;
        const sentenceGameSeconds = sentenceGameHours * 3600;
        const sentenceEnd = this.world.worldTime + sentenceGameSeconds;

        bookedSuspect.prisonSentenceEnd = sentenceEnd;
        bookedSuspect.currentBuilding = resident.currentBuilding;

        resident.carryingSuspectId = null;
        updateCarryingSuspect(resident.id, null);

        resident.wallet += ARREST_BOUNTY;

        updatePrisonState(bookedSuspect.id, resident.id, sentenceEnd);

        logEvent('book_suspect', resident.id, bookedSuspect.id, resident.currentBuilding, resident.x, resident.y, {
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
        return;
      }
    }
  }

  private handleForageActions(resident: ResidentEntity, msg: ClientMessage): void {
    if (msg.type !== 'forage') return;
    if (!this.requireAwake(resident, msg)) return;
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

    resident.needs.energy = Math.max(0, resident.needs.energy - ENERGY_COST_FORAGE);
    node.usesRemaining--;

    if (node.usesRemaining <= 0) {
      node.depletedAt = this.world.worldTime;
    }

    const forageItemType = node.type === 'berry_bush' ? 'wild_berries' : 'spring_water';
    const forageItemName = node.type === 'berry_bush' ? 'Wild Berries' : 'Spring Water';

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

    // Imprisoned residents can only speak, inspect, and submit feedback
    if (resident.arrestedBy || resident.prisonSentenceEnd) {
      if (msg.type !== 'inspect' && msg.type !== 'speak' && msg.type !== 'submit_feedback') {
        this.sendActionResult(resident, msg, false, 'imprisoned');
        return;
      }
    }

    if (this.handleMovementAndSpeechActions(resident, msg)) return;
    if (this.handleEconomyActions(resident, msg)) return;
    if (this.handleTourismAndFeedbackActions(resident, msg)) return;

    if (msg.type === 'inspect' || msg.type === 'trade' || msg.type === 'give') {
      this.handleSocialActions(resident, msg);
      return;
    }
    if (msg.type === 'apply_job' || msg.type === 'quit_job' || msg.type === 'list_jobs' || msg.type === 'write_petition' || msg.type === 'vote_petition' || msg.type === 'list_petitions' || msg.type === 'depart') {
      this.handleCivicActions(resident, msg);
      return;
    }
    if (msg.type === 'collect_body' || msg.type === 'process_body' || msg.type === 'arrest' || msg.type === 'book_suspect') {
      this.handleSafetyActions(resident, msg);
      return;
    }
    if (msg.type === 'forage') {
      this.handleForageActions(resident, msg);
      return;
    }

    this.sendActionResult(resident, msg, false, 'unknown_action');
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
      if (!resident) continue;

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
