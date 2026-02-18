import type { Needs, VisibleResident, VisibleForageable, Build } from '@otra/shared';
import {
  WALK_SPEED, RUN_SPEED, TILE_SIZE, RESIDENT_HITBOX,
  HUNGER_DECAY_PER_SEC, THIRST_DECAY_PER_SEC, ENERGY_PASSIVE_DECAY_PER_SEC,
  BLADDER_FILL_PER_SEC, HEALTH_DRAIN_HUNGER, HEALTH_DRAIN_THIRST,
  HEALTH_RECOVERY_PER_SEC, HEALTH_RECOVERY_THRESHOLD,
  SLEEP_ROUGH_RATE_PER_SEC, SLEEP_BAG_RATE_PER_SEC,
  TRAIN_INTERVAL_SEC, STARTING_QUID, FOV_ANGLE, FOV_RANGE, AMBIENT_RANGE,
  NIGHT_VISION_MULTIPLIER,
  NORMAL_VOICE_RANGE, WHISPER_RANGE, SHOUT_RANGE, WALL_SOUND_FACTOR,
  TIME_SCALE, STARTING_HOUR, GAME_DAY_SECONDS,
  PETITION_MAX_AGE_GAME_HOURS, BODY_COLLECT_RANGE,
  SHOP_RESTOCK_INTERVAL_GAME_HOURS, SOCIAL_PROXIMITY_RANGE, SOCIAL_DECAY_REDUCTION,
  LOITER_THRESHOLD_GAME_HOURS, LOITER_CHECK_DISTANCE, ARREST_RANGE, ARREST_BOUNTY,
  LOITER_SENTENCE_GAME_HOURS,
  FORAGE_RANGE, BERRY_BUSH_MAX_USES, BERRY_BUSH_REGROW_GAME_HOURS,
  SPRING_MAX_USES, SPRING_REGROW_GAME_HOURS,
  SOCIAL_CONVERSATION_RANGE, SOCIAL_CONVERSATION_DECAY_REDUCTION,
  SOCIAL_CONVERSATION_WINDOW, SOCIAL_CONVERSATION_ENERGY_RECOVERY,
} from '@otra/shared';
import type { WebSocket } from 'ws';
import { TileMap } from './map.js';
import { resolveMovement } from './collision.js';
import type { ResidentRow } from '../db/queries.js';
import {
  getAllAliveResidents, batchSaveResidents, saveWorldState,
  getWorldState, markResidentDead, logEvent, getInventory, batchSaveInventory,
  getJob, closeExpiredPetitions,
} from '../db/queries.js';
import type { PerceptionUpdate, AudibleMessage, VisibleEntity, VisibleBuilding } from '@otra/shared';
import { enterBuilding } from '../buildings/building-actions.js';
import { sendWebhook } from '../network/webhooks.js';
import { updateShift } from '../economy/jobs.js';
import { initShopStock, restockShop } from '../economy/shop.js';

export interface ForageableNodeState {
  id: string;
  type: 'berry_bush' | 'fresh_spring';
  x: number;  // pixel coords (center of tile)
  y: number;
  usesRemaining: number;
  maxUses: number;
  depletedAt: number | null;  // worldTime when depleted, null if available
  regrowGameSeconds: number;
}

export interface ResidentEntity {
  id: string;
  passportNo: string;
  fullName: string;
  preferredName: string;
  type: 'AGENT' | 'HUMAN';
  x: number;
  y: number;
  facing: number;         // degrees 0-359
  velocityX: number;
  velocityY: number;
  speed: 'walk' | 'run' | 'stop';
  needs: Needs;
  wallet: number;
  inventory: Array<{ id: string; type: string; quantity: number }>;
  isSleeping: boolean;
  isDead: boolean;
  currentBuilding: string | null;
  employment: { job: string; onShift: boolean } | null;
  currentJobId: string | null;
  shiftStartTime: number | null;  // accumulated game-seconds on current shift
  carryingBodyId: string | null;
  lastUbiCollection: number;
  // Appearance
  skinTone: number;
  hairStyle: number;
  hairColor: number;
  build: Build;
  // Webhook
  webhookUrl: string | null;
  // Agent identity
  agentFramework: string | null;
  bio: string;
  // GitHub Guild
  githubUsername: string | null;
  lastGithubClaimTime: number;
  // Runtime state
  ws: WebSocket | null;
  lastActionTime: number;
  // Speech tracking for perception
  pendingSpeech: Array<{ text: string; volume: 'whisper' | 'normal' | 'shout'; time: number; directedTo: string | null }>;
  // Pathfinding state
  pathWaypoints: Array<{ x: number; y: number }> | null;
  pathIndex: number;
  pathTargetBuilding: string | null;
  pathBlockedTicks: number;
  // Notifications for perception
  pendingNotifications: string[];
  // Social proximity (runtime only, not persisted)
  socialNearbyCount: number;
  socialCheckCounter: number;
  // Conversation tracking (runtime only, not persisted)
  lastConversationTime: number;
  lastSpeechWebhookTime: number;
  // Law enforcement
  lawBreaking: string[];
  arrestedBy: string | null;
  prisonSentenceEnd: number | null;
  carryingSuspectId: string | null;
  // Loitering detection (runtime only, not persisted)
  loiterX: number;
  loiterY: number;
  loiterTimer: number;
}

/** Compute visible condition for a resident based on their needs */
export function computeCondition(r: ResidentEntity): 'healthy' | 'struggling' | 'critical' {
  if (r.needs.health < 20 || r.needs.hunger <= 0 || r.needs.thirst <= 0) return 'critical';
  if (r.needs.hunger < 20 || r.needs.thirst < 20 || r.needs.energy < 10 || r.needs.health < 50) return 'struggling';
  return 'healthy';
}

export class World {
  residents = new Map<string, ResidentEntity>();
  forageableNodes = new Map<string, ForageableNodeState>();
  map: TileMap;
  worldTime = 0;
  trainTimer = 0;
  shopRestockTimer = 0;
  trainQueue: string[] = [];
  private lastSaveTime = 0;
  private saveInterval = 30; // seconds
  private petitionCheckTimer = 0;
  private petitionCheckInterval = 60; // check every 60 real seconds

  constructor(map: TileMap) {
    this.map = map;

    // Load world state from DB
    const ws = getWorldState();
    this.worldTime = ws.world_time;
    this.trainTimer = ws.train_timer;
    this.shopRestockTimer = ws.shop_restock_timer || 0;

    // Initialize shop stock on startup
    initShopStock();

    // Initialize forageable nodes from map data
    for (const node of map.data.forageableNodes ?? []) {
      const regrowGameSeconds = node.type === 'berry_bush'
        ? BERRY_BUSH_REGROW_GAME_HOURS * 3600
        : SPRING_REGROW_GAME_HOURS * 3600;
      this.forageableNodes.set(node.id, {
        id: node.id,
        type: node.type,
        x: node.tileX * TILE_SIZE + TILE_SIZE / 2,
        y: node.tileY * TILE_SIZE + TILE_SIZE / 2,
        usesRemaining: node.maxUses,
        maxUses: node.maxUses,
        depletedAt: null,
        regrowGameSeconds,
      });
    }
    console.log(`[World] Initialized ${this.forageableNodes.size} forageable nodes`);
  }

  loadResidentsFromDb(): void {
    const rows = getAllAliveResidents();
    for (const row of rows) {
      this.addResidentFromRow(row);
    }
    console.log(`[World] Loaded ${this.residents.size} alive residents`);
  }

  addResidentFromRow(row: ResidentRow): ResidentEntity {
    const entity: ResidentEntity = {
      id: row.id,
      passportNo: row.passport_no,
      fullName: row.full_name,
      preferredName: row.preferred_name,
      type: row.type as 'AGENT' | 'HUMAN',
      x: row.x,
      y: row.y,
      facing: row.facing,
      velocityX: 0,
      velocityY: 0,
      speed: 'stop',
      needs: {
        hunger: row.hunger,
        thirst: row.thirst,
        energy: row.energy,
        bladder: row.bladder,
        health: row.health,
      },
      wallet: row.wallet,
      inventory: getInventory(row.id).map(inv => ({
        id: inv.id, type: inv.item_type, quantity: inv.quantity,
      })),
      isSleeping: row.is_sleeping === 1,
      isDead: row.status === 'DECEASED',
      currentBuilding: row.current_building,
      employment: null,  // populated below if job exists
      currentJobId: row.current_job_id ?? null,
      shiftStartTime: row.shift_start_time ?? null,
      carryingBodyId: row.carrying_body_id ?? null,
      lastUbiCollection: row.last_ubi_collection,
      skinTone: row.skin_tone,
      hairStyle: row.hair_style,
      hairColor: row.hair_color,
      build: row.build as Build,
      webhookUrl: row.webhook_url ?? null,
      agentFramework: row.agent_framework ?? null,
      bio: row.bio || '',
      githubUsername: row.github_username ?? null,
      lastGithubClaimTime: row.last_github_claim_time ?? 0,
      ws: null,
      lastActionTime: 0,
      pendingSpeech: [],
      pathWaypoints: null,
      pathIndex: 0,
      pathTargetBuilding: null,
      pathBlockedTicks: 0,
      pendingNotifications: [],
      socialNearbyCount: 0,
      socialCheckCounter: 0,
      lastConversationTime: 0,
      lastSpeechWebhookTime: 0,
      // Law enforcement
      lawBreaking: JSON.parse(row.law_breaking || '[]'),
      arrestedBy: row.arrested_by ?? null,
      prisonSentenceEnd: row.prison_sentence_end ?? null,
      carryingSuspectId: row.carrying_suspect_id ?? null,
      loiterX: row.x,
      loiterY: row.y,
      loiterTimer: 0,
    };

    // On load: if arrested_by is set but no officer is carrying this resident, clear arrest state
    if (entity.arrestedBy && !entity.prisonSentenceEnd) {
      // Will be validated in the first tick — for now just load as-is
    }

    // Load employment from job if assigned
    if (entity.currentJobId) {
      const job = getJob(entity.currentJobId);
      if (job) {
        entity.employment = { job: job.title, onShift: false };
      } else {
        entity.currentJobId = null;
      }
    }

    this.residents.set(row.id, entity);
    return entity;
  }

  /** Position updates — called at 30 Hz */
  updatePositions(dt: number): void {
    // Path-following pre-pass: steer residents along active paths
    for (const [, r] of this.residents) {
      if (r.isDead || r.isSleeping || r.arrestedBy || r.prisonSentenceEnd || !r.pathWaypoints) continue;

      // Cancel path if out of energy
      if (r.needs.energy <= 0) {
        r.pathWaypoints = null;
        r.pathTargetBuilding = null;
        r.pathBlockedTicks = 0;
        r.velocityX = 0;
        r.velocityY = 0;
        r.speed = 'stop';
        r.pendingNotifications.push('Path cancelled: exhausted.');
        continue;
      }

      const wp = r.pathWaypoints[r.pathIndex];
      const dx = wp.x - r.x;
      const dy = wp.y - r.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 16) {
        // Reached current waypoint — advance
        r.pathIndex++;
        if (r.pathIndex >= r.pathWaypoints.length) {
          // Path complete
          r.velocityX = 0;
          r.velocityY = 0;
          r.speed = 'stop';
          const targetBld = r.pathTargetBuilding;
          r.pathWaypoints = null;
          r.pathTargetBuilding = null;
          r.pathBlockedTicks = 0;

          // Auto-enter building if targeted
          if (targetBld) {
            const result = enterBuilding(r, targetBld, this);
            if (result.success) {
              r.pendingNotifications.push(`Arrived and entered ${result.message.replace('Entered ', '')}.`);
            } else {
              r.pendingNotifications.push(`Arrived but could not enter: ${result.message}`);
            }
          } else {
            r.pendingNotifications.push('Arrived at destination.');
          }
          continue;
        }
      }

      // Steer toward current waypoint
      const angle = Math.atan2(dy, dx);
      r.velocityX = Math.cos(angle) * WALK_SPEED;
      r.velocityY = Math.sin(angle) * WALK_SPEED;
      r.speed = 'walk';
      r.facing = ((angle * 180) / Math.PI + 360) % 360;
    }

    for (const [, r] of this.residents) {
      if (r.isDead || r.isSleeping || r.arrestedBy || r.prisonSentenceEnd) continue;
      if (r.velocityX === 0 && r.velocityY === 0) continue;

      const newX = r.x + r.velocityX * dt;
      const newY = r.y + r.velocityY * dt;

      const fromX = r.x;
      const fromY = r.y;
      const result = resolveMovement(this.map, r.x, r.y, newX, newY);
      r.x = result.x;
      r.y = result.y;

      // If fully blocked (didn't move at all), stop velocity
      if (result.blocked && result.x === fromX && result.y === fromY) {
        r.velocityX = 0;
        r.velocityY = 0;
        r.speed = 'stop';

        // Cancel path if blocked for too long (30 ticks = ~1 second)
        if (r.pathWaypoints) {
          r.pathBlockedTicks++;
          if (r.pathBlockedTicks >= 30) {
            r.pathWaypoints = null;
            r.pathTargetBuilding = null;
            r.pathBlockedTicks = 0;
            r.pendingNotifications.push('Path cancelled: blocked.');
          }
        }
      } else if (r.pathWaypoints) {
        r.pathBlockedTicks = 0;
      }
    }
  }

  /** Needs decay — called at 10 Hz */
  updateNeeds(dt: number): void {
    // Social proximity check — only every 10 ticks (~1 second) for performance
    for (const [, r] of this.residents) {
      if (r.isDead) continue;
      r.socialCheckCounter++;
      if (r.socialCheckCounter >= 10) {
        r.socialCheckCounter = 0;
        let nearbyCount = 0;
        for (const [, other] of this.residents) {
          if (other === r || other.isDead || other.isSleeping) continue;
          const dx = other.x - r.x;
          const dy = other.y - r.y;
          if (dx * dx + dy * dy <= SOCIAL_PROXIMITY_RANGE * SOCIAL_PROXIMITY_RANGE) {
            nearbyCount++;
          }
        }
        r.socialNearbyCount = nearbyCount;
      }
    }

    for (const [, r] of this.residents) {
      if (r.isDead) continue;

      // Social bonus: reduce hunger/thirst decay when near other awake residents
      // Enhanced bonus when actively conversing (within last SOCIAL_CONVERSATION_WINDOW seconds)
      const isConversing = Date.now() - r.lastConversationTime < SOCIAL_CONVERSATION_WINDOW * 1000;
      const socialMultiplier = isConversing
        ? (1 - SOCIAL_CONVERSATION_DECAY_REDUCTION)
        : r.socialNearbyCount > 0 ? (1 - SOCIAL_DECAY_REDUCTION) : 1;

      // Hunger decays
      r.needs.hunger = Math.max(0, r.needs.hunger - HUNGER_DECAY_PER_SEC * dt * socialMultiplier);

      // Thirst decays
      r.needs.thirst = Math.max(0, r.needs.thirst - THIRST_DECAY_PER_SEC * dt * socialMultiplier);

      // Bladder fills
      r.needs.bladder = Math.min(100, r.needs.bladder + BLADDER_FILL_PER_SEC * dt);

      // Energy: passive decay or sleep recovery
      if (r.isSleeping) {
        // Recovery rate depends on equipment (sleeping bag)
        const hasSleepingBag = r.inventory.some(i => i.type === 'sleeping_bag');
        const recoveryRate = hasSleepingBag ? SLEEP_BAG_RATE_PER_SEC : SLEEP_ROUGH_RATE_PER_SEC;
        r.needs.energy = Math.min(100, r.needs.energy + recoveryRate * dt);

        // Auto-wake at 100
        if (r.needs.energy >= 100) {
          r.isSleeping = false;
          r.needs.energy = 100;
        }
      } else {
        r.needs.energy = Math.max(0, r.needs.energy - ENERGY_PASSIVE_DECAY_PER_SEC * dt);

        // Conversation energy recovery: +0.5 energy/hr when conversing
        if (isConversing) {
          r.needs.energy = Math.min(100, r.needs.energy + SOCIAL_CONVERSATION_ENERGY_RECOVERY * dt);
        }

        // Walking costs energy
        if (r.speed === 'walk') {
          const moveCost = 0.5 / TILE_SIZE; // 0.5 per tile-equivalent
          const moveSpeed = Math.sqrt(r.velocityX ** 2 + r.velocityY ** 2);
          r.needs.energy = Math.max(0, r.needs.energy - moveCost * moveSpeed * dt);
        } else if (r.speed === 'run') {
          const moveCost = 1.5 / TILE_SIZE;
          const moveSpeed = Math.sqrt(r.velocityX ** 2 + r.velocityY ** 2);
          r.needs.energy = Math.max(0, r.needs.energy - moveCost * moveSpeed * dt);
        }
      }

      // Employment: track shift progress and pay wages
      updateShift(r, dt);

      // Forced collapse at energy 0 — auto-sleep to prevent permanent immobilization
      if (r.needs.energy <= 0 && !r.isSleeping) {
        r.needs.energy = 0;
        r.velocityX = 0;
        r.velocityY = 0;
        r.speed = 'stop';
        r.isSleeping = true;
        // Cancel any active path
        r.pathWaypoints = null;
        r.pathTargetBuilding = null;
        r.pathBlockedTicks = 0;
        r.pendingNotifications.push('You collapsed from exhaustion and fell asleep.');
        logEvent('collapse', r.id, null, null, r.x, r.y, {});
        sendWebhook(r, 'collapse', { energy: 0, x: r.x, y: r.y });
      }

      // Health damage from unmet needs
      if (r.needs.hunger <= 0) {
        r.needs.health = Math.max(0, r.needs.health - HEALTH_DRAIN_HUNGER * dt);
      }
      if (r.needs.thirst <= 0) {
        r.needs.health = Math.max(0, r.needs.health - HEALTH_DRAIN_THIRST * dt);
      }

      // Webhook alert when health drops below 50 (checked once per ~10 seconds to avoid spam)
      if (r.needs.health > 0 && r.needs.health < 50 && (r.needs.hunger <= 0 || r.needs.thirst <= 0)) {
        // Only send roughly every 100 ticks (10 seconds at 10Hz)
        if (Math.random() < 0.01) {
          sendWebhook(r, 'health_critical', {
            health: Math.round(r.needs.health * 10) / 10,
            hunger: Math.round(r.needs.hunger * 10) / 10,
            thirst: Math.round(r.needs.thirst * 10) / 10,
            energy: Math.round(r.needs.energy * 10) / 10,
          });
        }
      }

      // Health recovery when all needs above threshold
      if (
        r.needs.hunger > HEALTH_RECOVERY_THRESHOLD &&
        r.needs.thirst > HEALTH_RECOVERY_THRESHOLD &&
        r.needs.energy > HEALTH_RECOVERY_THRESHOLD &&
        r.needs.health < 100
      ) {
        r.needs.health = Math.min(100, r.needs.health + HEALTH_RECOVERY_PER_SEC * dt);
      }

      // Bladder accident at 100
      if (r.needs.bladder >= 100) {
        r.needs.bladder = 50; // partial relief
        r.wallet = Math.max(0, r.wallet - 5); // cleaning fee
        logEvent('bladder_accident', r.id, null, null, r.x, r.y, {
          fee: 5, wallet_after: r.wallet
        });
      }
    }
  }

  /** Law enforcement — called at 10 Hz */
  updateLawEnforcement(dt: number): void {
    const loiterThresholdSec = LOITER_THRESHOLD_GAME_HOURS * 3600; // game-seconds

    for (const [, r] of this.residents) {
      if (r.isDead) continue;

      // --- Prison release ---
      if (r.prisonSentenceEnd !== null && this.worldTime >= r.prisonSentenceEnd) {
        r.prisonSentenceEnd = null;
        r.arrestedBy = null;
        r.lawBreaking = [];
        r.currentBuilding = null;
        // Teleport outside police station door
        const ps = this.map.data.buildings.find(b => b.id === 'police-station');
        if (ps && ps.doors[0]) {
          r.x = ps.doors[0].tileX * TILE_SIZE + TILE_SIZE / 2 + TILE_SIZE;
          r.y = ps.doors[0].tileY * TILE_SIZE + TILE_SIZE / 2;
        }
        r.pendingNotifications.push('You have been released from prison.');
        logEvent('prison_release', r.id, null, 'police-station', r.x, r.y, {});
        sendWebhook(r, 'prison_release', { x: r.x, y: r.y });
        console.log(`[World] ${r.preferredName} released from prison`);
        continue;
      }

      // Skip loitering checks for imprisoned/arrested/sleeping/inside-building residents
      if (r.arrestedBy || r.prisonSentenceEnd || r.isSleeping || r.currentBuilding) {
        // Reset loiter tracking
        r.loiterX = r.x;
        r.loiterY = r.y;
        r.loiterTimer = 0;
        continue;
      }

      // --- Loitering detection ---
      const movedDx = r.x - r.loiterX;
      const movedDy = r.y - r.loiterY;
      const movedDist = Math.sqrt(movedDx * movedDx + movedDy * movedDy);

      if (movedDist > LOITER_CHECK_DISTANCE) {
        // Moved enough — reset timer and clear loitering offense
        r.loiterX = r.x;
        r.loiterY = r.y;
        r.loiterTimer = 0;
        if (r.lawBreaking.includes('loitering')) {
          r.lawBreaking = r.lawBreaking.filter(l => l !== 'loitering');
        }
      } else {
        // Accumulate loiter time (game-seconds)
        r.loiterTimer += dt * TIME_SCALE;
        if (r.loiterTimer >= loiterThresholdSec && !r.lawBreaking.includes('loitering')) {
          r.lawBreaking.push('loitering');
          r.pendingNotifications.push('You are loitering. Move along or risk arrest.');
          logEvent('law_violation', r.id, null, null, r.x, r.y, { offense: 'loitering' });
          sendWebhook(r, 'law_violation', { offense: 'loitering', x: r.x, y: r.y });
        }
      }
    }

    // --- Suspect following: move arrested suspects to follow their officer ---
    for (const [, officer] of this.residents) {
      if (officer.isDead || !officer.carryingSuspectId) continue;
      const suspect = this.residents.get(officer.carryingSuspectId);
      if (!suspect || suspect.isDead) {
        // Suspect gone — clear officer's carry state
        officer.carryingSuspectId = null;
        continue;
      }
      // Move suspect 20px behind officer
      const angle = (officer.facing * Math.PI) / 180;
      suspect.x = officer.x - Math.cos(angle) * 20;
      suspect.y = officer.y - Math.sin(angle) * 20;
    }

    // --- Validate arrested-by on load ---
    // If a resident has arrestedBy set but no officer is carrying them, and they're not in prison, release them
    for (const [, r] of this.residents) {
      if (r.isDead || !r.arrestedBy || r.prisonSentenceEnd) continue;
      const officer = this.residents.get(r.arrestedBy);
      if (!officer || officer.isDead || officer.carryingSuspectId !== r.id) {
        r.arrestedBy = null;
        r.pendingNotifications.push('You have been released.');
      }
    }
  }

  /** Forageable node regrowth — called at 10 Hz */
  updateForageables(_dt: number): void {
    for (const [, node] of this.forageableNodes) {
      if (node.depletedAt !== null && this.worldTime >= node.depletedAt + node.regrowGameSeconds) {
        // Regrow: reset uses and clear depletion timestamp
        node.usesRemaining = node.maxUses;
        node.depletedAt = null;
      }
    }
  }

  /** Check for deaths — called at 10 Hz */
  checkDeaths(): void {
    for (const [id, r] of this.residents) {
      if (r.isDead) continue;
      if (r.needs.health <= 0) {
        r.isDead = true;
        r.velocityX = 0;
        r.velocityY = 0;
        r.speed = 'stop';
        r.isSleeping = false;

        // Determine cause
        let cause = 'unknown';
        if (r.needs.hunger <= 0 && r.needs.thirst <= 0) cause = 'starvation and dehydration';
        else if (r.needs.hunger <= 0) cause = 'starvation';
        else if (r.needs.thirst <= 0) cause = 'dehydration';

        // Release suspect if officer dies while carrying
        if (r.carryingSuspectId) {
          const suspect = this.residents.get(r.carryingSuspectId);
          if (suspect) {
            suspect.arrestedBy = null;
            suspect.pendingNotifications.push('The officer escorting you has died. You are free.');
          }
          r.carryingSuspectId = null;
        }
        // Release from arrest if suspect dies
        if (r.arrestedBy) {
          const officer = this.residents.get(r.arrestedBy);
          if (officer && officer.carryingSuspectId === r.id) {
            officer.carryingSuspectId = null;
          }
          r.arrestedBy = null;
          r.prisonSentenceEnd = null;
        }

        markResidentDead(id, cause);
        logEvent('death', id, null, null, r.x, r.y, {
          cause, wallet_lost: r.wallet
        });

        r.wallet = 0;
        console.log(`[World] ${r.preferredName} (${r.passportNo}) has died: ${cause}`);
        sendWebhook(r, 'death', { cause, x: r.x, y: r.y });

        // Notify nearby residents about the death
        this.notifyNearby(r.x, r.y, 200, `${r.preferredName} has died nearby.`);
      }
    }
  }

  /** Train timer — called at 10 Hz */
  updateTrain(dt: number): void {
    this.worldTime += dt * TIME_SCALE;
    this.trainTimer += dt * TIME_SCALE;  // advance in game-time so trains run every 15 game-minutes

    // In dev mode, use a shorter train interval (30 seconds)
    const interval = process.env.NODE_ENV === 'production' ? TRAIN_INTERVAL_SEC : 30;

    if (this.trainTimer >= interval) {
      this.trainTimer -= interval;
      this.spawnTrainArrivals();
    }

    // Immediately spawn if train queue has people and timer is close (within 5 game-seconds)
    if (this.trainQueue.length > 0 && this.trainTimer >= interval - 5 * TIME_SCALE) {
      this.trainTimer = interval; // force trigger on next check
    }

    // Shop restock timer
    this.shopRestockTimer += dt;
    const restockIntervalSec = SHOP_RESTOCK_INTERVAL_GAME_HOURS * 3600 / TIME_SCALE;
    if (this.shopRestockTimer >= restockIntervalSec) {
      this.shopRestockTimer -= restockIntervalSec;
      restockShop();
      // Notify residents near the council-supplies building
      const shopBuilding = this.map.data.buildings.find(b => b.id === 'council-supplies');
      if (shopBuilding) {
        const shopX = (shopBuilding.tileX + shopBuilding.widthTiles / 2) * TILE_SIZE;
        const shopY = (shopBuilding.tileY + shopBuilding.heightTiles / 2) * TILE_SIZE;
        this.notifyNearby(shopX, shopY, 300, 'Council Supplies has been restocked.');
      }
    }

    // Periodically close expired petitions
    this.petitionCheckTimer += dt;
    if (this.petitionCheckTimer >= this.petitionCheckInterval) {
      this.petitionCheckTimer = 0;
      const maxAgeMs = (PETITION_MAX_AGE_GAME_HOURS * 3600 / TIME_SCALE) * 1000;
      const closed = closeExpiredPetitions(maxAgeMs);
      if (closed > 0) {
        console.log(`[World] Closed ${closed} expired petition(s)`);
      }
    }
  }

  private spawnTrainArrivals(): void {
    if (this.trainQueue.length === 0) return;

    const spawn = this.map.data.spawnPoint;
    const arrivals = [...this.trainQueue];
    this.trainQueue = [];

    for (let i = 0; i < arrivals.length; i++) {
      const residentId = arrivals[i];
      const r = this.residents.get(residentId);
      if (!r) continue;

      // Spread arrivals slightly so they don't stack
      r.x = spawn.x + (i - arrivals.length / 2) * 20;
      r.y = spawn.y;

      logEvent('arrival', r.id, null, 'train-station', r.x, r.y, {
        name: r.preferredName, passport_no: r.passportNo
      });
      console.log(`[World] ${r.preferredName} arrived on the train`);
    }

    // Notify nearby residents about train arrival
    if (arrivals.length > 0) {
      this.notifyNearby(spawn.x, spawn.y, 300, 'A train has arrived at the station.');
    }
  }

  queueForTrain(residentId: string): void {
    this.trainQueue.push(residentId);

    // In development, spawn immediately instead of waiting for train
    if (process.env.NODE_ENV !== 'production') {
      this.spawnTrainArrivals();
    } else {
      const gameSecsUntilTrain = TRAIN_INTERVAL_SEC - this.trainTimer;
      const realSecsUntilTrain = gameSecsUntilTrain / TIME_SCALE;
      console.log(`[World] ${residentId} queued for train (arriving in ${Math.ceil(realSecsUntilTrain)}s real / ${Math.ceil(gameSecsUntilTrain)}s game)`);
    }
  }

  /** Returns a 0-1 multiplier for vision ranges based on time of day */
  getVisionMultiplier(): number {
    const worldTimeSec = this.worldTime + STARTING_HOUR * 3600;
    const hour = (worldTimeSec % GAME_DAY_SECONDS) / 3600;

    if (hour >= 8 && hour < 18) return 1.0;                           // Day
    if (hour >= 6 && hour < 8) {                                      // Dawn
      const t = (hour - 6) / 2;
      return NIGHT_VISION_MULTIPLIER + (1 - NIGHT_VISION_MULTIPLIER) * t;
    }
    if (hour >= 18 && hour < 20) {                                    // Dusk
      const t = (hour - 18) / 2;
      return 1 - (1 - NIGHT_VISION_MULTIPLIER) * t;
    }
    return NIGHT_VISION_MULTIPLIER;                                    // Night
  }

  /** Compute perception for a single resident */
  computePerception(resident: ResidentEntity, tick: number): PerceptionUpdate {
    const visible: VisibleEntity[] = [];
    const audible: AudibleMessage[] = [];
    const interactions: string[] = [];

    // Night vision: reduce vision ranges based on time of day
    const visionMult = this.getVisionMultiplier();
    const effectiveFovRange = FOV_RANGE * visionMult;
    const effectiveAmbientRange = AMBIENT_RANGE * visionMult;
    const effectiveBuildingRange = FOV_RANGE * 1.5 * visionMult;

    // Imprisoned residents can only speak and inspect
    const isImprisoned = resident.arrestedBy !== null || resident.prisonSentenceEnd !== null;
    if (isImprisoned) {
      interactions.push('speak', 'inspect');
      // Skip all other interaction computation for imprisoned residents
      const notifications = [...resident.pendingNotifications];
      // Still include own pending speech
      for (const speech of resident.pendingSpeech) {
        const toResident = speech.directedTo ? this.residents.get(speech.directedTo) : null;
        audible.push({
          from: resident.id,
          from_name: resident.preferredName,
          text: speech.text,
          volume: speech.volume,
          distance: 0,
          to: toResident ? speech.directedTo! : undefined,
          to_name: toResident ? toResident.preferredName : undefined,
        });
      }
      return {
        tick,
        time: new Date().toISOString(),
        world_time: this.worldTime + STARTING_HOUR * 3600,
        self: {
          id: resident.id,
          passport_no: resident.passportNo,
          x: resident.x,
          y: resident.y,
          facing: resident.facing,
          hunger: Math.round(resident.needs.hunger * 10) / 10,
          thirst: Math.round(resident.needs.thirst * 10) / 10,
          energy: Math.round(resident.needs.energy * 10) / 10,
          bladder: Math.round(resident.needs.bladder * 10) / 10,
          health: Math.round(resident.needs.health * 10) / 10,
          wallet: resident.wallet,
          inventory: resident.inventory,
          status: resident.arrestedBy ? 'arrested' : 'imprisoned',
          is_sleeping: false,
          current_building: resident.currentBuilding,
          employment: resident.employment ? { job: resident.employment.job, on_shift: resident.employment.onShift } : null,
          law_breaking: resident.lawBreaking,
          prison_sentence_remaining: resident.prisonSentenceEnd !== null
            ? Math.max(0, Math.round(resident.prisonSentenceEnd - this.worldTime))
            : null,
          carrying_suspect_id: null,
        },
        visible: [],
        audible,
        interactions,
        notifications,
      };
    }

    // Always available actions
    interactions.push('speak', 'inspect');
    if (!resident.isSleeping && resident.needs.energy > 0) {
      interactions.push('move', 'move_to');
    }
    if (resident.needs.energy < 90 && !resident.isSleeping) {
      interactions.push('sleep');
    }
    if (resident.isSleeping) {
      interactions.push('wake');
    }
    if (resident.employment) {
      interactions.push('quit_job');
    }

    // Include own pending speech in audible (distance 0)
    for (const speech of resident.pendingSpeech) {
      const toResident = speech.directedTo ? this.residents.get(speech.directedTo) : null;
      audible.push({
        from: resident.id,
        from_name: resident.preferredName,
        text: speech.text,
        volume: speech.volume,
        distance: 0,
        to: toResident ? speech.directedTo! : undefined,
        to_name: toResident ? toResident.preferredName : undefined,
      });
    }

    const facingRad = (resident.facing * Math.PI) / 180;

    for (const [id, other] of this.residents) {
      if (id === resident.id) continue;

      const dx = other.x - resident.x;
      const dy = other.y - resident.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Check visibility
      let canSee = false;

      // 360° ambient awareness
      if (dist <= effectiveAmbientRange) {
        canSee = true;
      }
      // 90° FOV cone
      else if (dist <= effectiveFovRange) {
        const angleToOther = Math.atan2(dy, dx);
        let angleDiff = angleToOther - facingRad;
        // Normalize to [-PI, PI]
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        if (Math.abs(angleDiff) <= FOV_ANGLE / 2) {
          // Check line of sight
          if (this.map.hasLineOfSight(resident.x, resident.y, other.x, other.y)) {
            canSee = true;
          }
        }
      }

      if (canSee) {
        visible.push({
          id: other.id,
          type: 'resident',
          name: other.preferredName,
          x: other.x,
          y: other.y,
          facing: other.facing,
          appearance: {
            skin_tone: other.skinTone,
            hair_style: other.hairStyle,
            hair_color: other.hairColor,
            build: other.build,
          },
          action: other.isDead ? 'dead' : other.isSleeping ? 'sleeping' : other.speed !== 'stop' ? 'walking' : 'idle',
          is_dead: other.isDead,
          agent_framework: other.agentFramework ?? undefined,
          condition: other.isDead ? undefined : computeCondition(other),
          is_wanted: other.lawBreaking.length > 0 ? true : undefined,
          is_police: other.currentJobId === 'police-officer' ? true : undefined,
          is_arrested: (other.arrestedBy || other.prisonSentenceEnd) ? true : undefined,
        } satisfies VisibleResident);

        // Body collection interaction: can pick up dead residents
        if (other.isDead && dist <= BODY_COLLECT_RANGE && !resident.carryingBodyId && !resident.isSleeping) {
          interactions.push(`collect_body:${other.id}`);
        }

        // Arrest interaction: police officers can arrest wanted residents
        if (!other.isDead && other.lawBreaking.length > 0 && !other.arrestedBy &&
            resident.currentJobId === 'police-officer' && !resident.carryingSuspectId &&
            !resident.isSleeping && dist <= ARREST_RANGE) {
          interactions.push(`arrest:${other.id}`);
        }
      }

      // Check audibility (recent speech)
      for (const speech of other.pendingSpeech) {
        let range: number;
        switch (speech.volume) {
          case 'whisper': range = WHISPER_RANGE; break;
          case 'shout': range = SHOUT_RANGE; break;
          default: range = NORMAL_VOICE_RANGE;
        }

        // Reduce range through walls
        const walls = this.map.countWallsBetween(resident.x, resident.y, other.x, other.y);
        range *= Math.pow(WALL_SOUND_FACTOR, walls);

        if (dist <= range) {
          const toResident = speech.directedTo ? this.residents.get(speech.directedTo) : null;
          audible.push({
            from: other.id,
            from_name: other.preferredName,
            text: speech.text,
            volume: speech.volume,
            distance: Math.round(dist * 10) / 10,
            to: toResident ? speech.directedTo! : undefined,
            to_name: toResident ? toResident.preferredName : undefined,
          });

          // Brain pin: push notification when speech is directed at this resident
          if (speech.directedTo === resident.id) {
            resident.pendingNotifications.push(
              `${other.preferredName} said to you: "${speech.text}"`
            );
          }
        }
      }
    }

    // Inventory actions: eat/drink available if resident has consumables
    if (!resident.isSleeping) {
      for (const item of resident.inventory) {
        if (item.type !== 'sleeping_bag') {
          interactions.push('eat', 'drink');
          break;
        }
      }
    }

    // If inside a building, add building-specific interactions
    if (resident.currentBuilding) {
      interactions.push('exit_building');
      const currentBldg = this.map.data.buildings.find(b => b.id === resident.currentBuilding);
      if (currentBldg) {
        for (const zone of currentBldg.interactionZones) {
          interactions.push(zone.action);
        }
      }
      // Council Hall extras
      if (resident.currentBuilding === 'council-hall') {
        interactions.push('list_jobs', 'list_petitions');
        if (resident.employment) {
          interactions.push('quit_job');
        }
      }
      // Mortuary: process_body if carrying one
      if (resident.currentBuilding === 'council-mortuary' && resident.carryingBodyId) {
        interactions.push('process_body');
      }
      // Police station: book_suspect if carrying one
      if (resident.currentBuilding === 'police-station' && resident.carryingSuspectId) {
        interactions.push('book_suspect');
      }
      // GitHub Guild: link/list actions
      if (resident.currentBuilding === 'github-guild') {
        if (!resident.githubUsername) {
          interactions.push('link_github');
        }
        interactions.push('list_claims');
      }
    }

    // Add buildings as visible entities
    for (const building of this.map.data.buildings) {
      const bCenterX = (building.tileX + building.widthTiles / 2) * TILE_SIZE;
      const bCenterY = (building.tileY + building.heightTiles / 2) * TILE_SIZE;
      const dx = bCenterX - resident.x;
      const dy = bCenterY - resident.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= effectiveBuildingRange) { // buildings visible at slightly longer range
        const primaryDoor = building.doors[0];
        visible.push({
          id: building.id,
          type: 'building',
          name: building.name,
          building_type: building.type,
          x: building.tileX * TILE_SIZE,
          y: building.tileY * TILE_SIZE,
          width: building.widthTiles * TILE_SIZE,
          height: building.heightTiles * TILE_SIZE,
          door_x: primaryDoor ? primaryDoor.tileX * TILE_SIZE + TILE_SIZE / 2 : building.tileX * TILE_SIZE,
          door_y: primaryDoor ? primaryDoor.tileY * TILE_SIZE + TILE_SIZE / 2 : building.tileY * TILE_SIZE,
        } satisfies VisibleBuilding);

        // Check if near door for enter_building interaction
        for (const door of building.doors) {
          const doorX = door.tileX * TILE_SIZE + TILE_SIZE / 2;
          const doorY = door.tileY * TILE_SIZE + TILE_SIZE / 2;
          const doorDist = Math.sqrt((resident.x - doorX) ** 2 + (resident.y - doorY) ** 2);
          if (doorDist < TILE_SIZE * 2) {
            interactions.push(`enter_building:${building.id}`);
          }
        }
      }
    }

    // Add forageable nodes as visible entities
    for (const [, node] of this.forageableNodes) {
      const dx = node.x - resident.x;
      const dy = node.y - resident.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= effectiveBuildingRange) {
        visible.push({
          id: node.id,
          type: 'forageable',
          x: node.x,
          y: node.y,
          resource_type: node.type,
          uses_remaining: node.usesRemaining,
          max_uses: node.maxUses,
        } satisfies VisibleForageable);

        // Forage interaction: within range, has uses, not sleeping
        if (dist <= FORAGE_RANGE && node.usesRemaining > 0 && !resident.isSleeping) {
          interactions.push(`forage:${node.id}`);
        }
      }
    }

    return {
      tick,
      time: new Date().toISOString(),
      world_time: this.worldTime + STARTING_HOUR * 3600,
      self: {
        id: resident.id,
        passport_no: resident.passportNo,
        x: resident.x,
        y: resident.y,
        facing: resident.facing,
        hunger: Math.round(resident.needs.hunger * 10) / 10,
        thirst: Math.round(resident.needs.thirst * 10) / 10,
        energy: Math.round(resident.needs.energy * 10) / 10,
        bladder: Math.round(resident.needs.bladder * 10) / 10,
        health: Math.round(resident.needs.health * 10) / 10,
        wallet: resident.wallet,
        inventory: resident.inventory,
        status: resident.isDead ? 'dead' : resident.isSleeping ? 'sleeping' : resident.speed !== 'stop' ? 'walking' : 'idle',
        is_sleeping: resident.isSleeping,
        current_building: resident.currentBuilding,
        employment: resident.employment ? { job: resident.employment.job, on_shift: resident.employment.onShift } : null,
        law_breaking: resident.lawBreaking,
        prison_sentence_remaining: resident.prisonSentenceEnd !== null
          ? Math.max(0, Math.round(resident.prisonSentenceEnd - this.worldTime))
          : null,
        carrying_suspect_id: resident.carryingSuspectId,
      },
      visible,
      audible,
      interactions: [...new Set(interactions)],
      notifications: [...resident.pendingNotifications],
    };
  }

  /** Compute full-world perception for spectators (no FOV filtering) */
  computeSpectatorPerception(resident: ResidentEntity, tick: number): PerceptionUpdate {
    const visible: VisibleEntity[] = [];
    const audible: AudibleMessage[] = [];

    // Include ALL residents (no FOV/distance filtering)
    for (const [id, other] of this.residents) {
      if (id === resident.id) continue;

      visible.push({
        id: other.id,
        type: 'resident',
        name: other.preferredName,
        x: other.x,
        y: other.y,
        facing: other.facing,
        appearance: {
          skin_tone: other.skinTone,
          hair_style: other.hairStyle,
          hair_color: other.hairColor,
          build: other.build,
        },
        action: other.isDead ? 'dead' : other.isSleeping ? 'sleeping' : other.speed !== 'stop' ? 'walking' : 'idle',
        is_dead: other.isDead,
        agent_framework: other.agentFramework ?? undefined,
        condition: other.isDead ? undefined : computeCondition(other),
        is_wanted: other.lawBreaking.length > 0 ? true : undefined,
        is_police: other.currentJobId === 'police-officer' ? true : undefined,
        is_arrested: (other.arrestedBy || other.prisonSentenceEnd) ? true : undefined,
      } satisfies VisibleResident);

      // Include ALL pending speech (no distance/wall filtering)
      for (const speech of other.pendingSpeech) {
        const dx = other.x - resident.x;
        const dy = other.y - resident.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const toResident = speech.directedTo ? this.residents.get(speech.directedTo) : null;
        audible.push({
          from: other.id,
          from_name: other.preferredName,
          text: speech.text,
          volume: speech.volume,
          distance: Math.round(dist * 10) / 10,
          to: toResident ? speech.directedTo! : undefined,
          to_name: toResident ? toResident.preferredName : undefined,
        });
      }
    }

    // Include own pending speech
    for (const speech of resident.pendingSpeech) {
      const toResident = speech.directedTo ? this.residents.get(speech.directedTo) : null;
      audible.push({
        from: resident.id,
        from_name: resident.preferredName,
        text: speech.text,
        volume: speech.volume,
        distance: 0,
        to: toResident ? speech.directedTo! : undefined,
        to_name: toResident ? toResident.preferredName : undefined,
      });
    }

    // Include ALL buildings (no distance filtering)
    for (const building of this.map.data.buildings) {
      const primaryDoor = building.doors[0];
      visible.push({
        id: building.id,
        type: 'building',
        name: building.name,
        building_type: building.type,
        x: building.tileX * TILE_SIZE,
        y: building.tileY * TILE_SIZE,
        width: building.widthTiles * TILE_SIZE,
        height: building.heightTiles * TILE_SIZE,
        door_x: primaryDoor ? primaryDoor.tileX * TILE_SIZE + TILE_SIZE / 2 : building.tileX * TILE_SIZE,
        door_y: primaryDoor ? primaryDoor.tileY * TILE_SIZE + TILE_SIZE / 2 : building.tileY * TILE_SIZE,
      } satisfies VisibleBuilding);
    }

    // Include ALL forageable nodes (no distance filtering)
    for (const [, node] of this.forageableNodes) {
      visible.push({
        id: node.id,
        type: 'forageable',
        x: node.x,
        y: node.y,
        resource_type: node.type,
        uses_remaining: node.usesRemaining,
        max_uses: node.maxUses,
      } satisfies VisibleForageable);
    }

    return {
      tick,
      time: new Date().toISOString(),
      world_time: this.worldTime + STARTING_HOUR * 3600,
      self: {
        id: resident.id,
        passport_no: resident.passportNo,
        x: resident.x,
        y: resident.y,
        facing: resident.facing,
        hunger: Math.round(resident.needs.hunger * 10) / 10,
        thirst: Math.round(resident.needs.thirst * 10) / 10,
        energy: Math.round(resident.needs.energy * 10) / 10,
        bladder: Math.round(resident.needs.bladder * 10) / 10,
        health: Math.round(resident.needs.health * 10) / 10,
        wallet: resident.wallet,
        inventory: resident.inventory,
        status: resident.isDead ? 'dead' : resident.isSleeping ? 'sleeping' : resident.speed !== 'stop' ? 'walking' : 'idle',
        is_sleeping: resident.isSleeping,
        current_building: resident.currentBuilding,
        employment: resident.employment ? { job: resident.employment.job, on_shift: resident.employment.onShift } : null,
        law_breaking: resident.lawBreaking,
        prison_sentence_remaining: resident.prisonSentenceEnd !== null
          ? Math.max(0, Math.round(resident.prisonSentenceEnd - this.worldTime))
          : null,
        carrying_suspect_id: resident.carryingSuspectId,
      },
      visible,
      audible,
      interactions: [], // spectators can't interact
      notifications: [...resident.pendingNotifications],
    };
  }

  /** Fire speech_heard webhooks and update conversation timestamps */
  computeSpeechListeners(): void {
    const now = Date.now();

    for (const [speakerId, speaker] of this.residents) {
      if (speaker.isDead || speaker.pendingSpeech.length === 0) continue;

      for (const speech of speaker.pendingSpeech) {
        let range: number;
        switch (speech.volume) {
          case 'whisper': range = WHISPER_RANGE; break;
          case 'shout': range = SHOUT_RANGE; break;
          default: range = NORMAL_VOICE_RANGE;
        }

        let anyListenerInConversationRange = false;

        for (const [listenerId, listener] of this.residents) {
          if (listenerId === speakerId || listener.isDead) continue;

          const dx = listener.x - speaker.x;
          const dy = listener.y - speaker.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Apply wall attenuation
          const walls = this.map.countWallsBetween(speaker.x, speaker.y, listener.x, listener.y);
          const effectiveRange = range * Math.pow(WALL_SOUND_FACTOR, walls);

          if (dist > effectiveRange) continue;

          // Conversation bonus: update timestamps for both parties
          if (dist <= SOCIAL_CONVERSATION_RANGE) {
            anyListenerInConversationRange = true;
            listener.lastConversationTime = now;
          }

          // Webhook: fire speech_heard for listeners with webhookUrl
          if (listener.webhookUrl) {
            const isDirected = speech.directedTo === listenerId;

            // Throttle undirected speech webhooks to 1/second; directed always fires
            if (isDirected || now - listener.lastSpeechWebhookTime >= 1000) {
              listener.lastSpeechWebhookTime = now;
              sendWebhook(listener, 'speech_heard', {
                from_id: speakerId,
                from_name: speaker.preferredName,
                text: speech.text,
                volume: speech.volume,
                distance: Math.round(dist * 10) / 10,
                directed: isDirected,
              });
            }
          }
        }

        // Speaker gets conversation bonus only if someone else heard them within range
        if (anyListenerInConversationRange) {
          speaker.lastConversationTime = now;
        }
      }
    }
  }

  /** Clear pending speech after perception broadcast */
  clearPendingSpeech(): void {
    for (const [, r] of this.residents) {
      r.pendingSpeech = [];
    }
  }

  /** Clear pending notifications after perception broadcast */
  clearPendingNotifications(): void {
    for (const [, r] of this.residents) {
      r.pendingNotifications = [];
    }
  }

  /** Send a notification to all living residents within range of a point */
  notifyNearby(x: number, y: number, range: number, message: string): void {
    for (const [, r] of this.residents) {
      if (r.isDead) continue;
      const dx = r.x - x;
      const dy = r.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= range) {
        r.pendingNotifications.push(message);
      }
    }
  }

  /** Save all state to DB */
  saveToDb(): void {
    const residents = Array.from(this.residents.values())
      .filter(r => !r.isDead)
      .map(r => ({
        id: r.id,
        x: r.x,
        y: r.y,
        facing: r.facing,
        needs: r.needs,
        wallet: r.wallet,
        is_sleeping: r.isSleeping,
        current_building: r.currentBuilding,
        current_job_id: r.currentJobId,
        shift_start_time: r.shiftStartTime,
        carrying_body_id: r.carryingBodyId,
        law_breaking: r.lawBreaking,
        arrested_by: r.arrestedBy,
        prison_sentence_end: r.prisonSentenceEnd,
        carrying_suspect_id: r.carryingSuspectId,
      }));

    batchSaveResidents(residents);

    // Save inventory
    const allInventory: Array<{
      id: string; resident_id: string; item_type: string;
      quantity: number; durability: number;
    }> = [];
    for (const r of this.residents.values()) {
      if (r.isDead) continue;
      for (const item of r.inventory) {
        allInventory.push({
          id: item.id,
          resident_id: r.id,
          item_type: item.type,
          quantity: item.quantity,
          durability: -1, // durability tracked separately if needed
        });
      }
    }
    if (allInventory.length > 0) {
      batchSaveInventory(allInventory);
    }

    saveWorldState(this.worldTime, this.trainTimer, this.shopRestockTimer);
  }

  /** Periodic save check */
  checkSave(dt: number): void {
    this.lastSaveTime += dt;
    if (this.lastSaveTime >= this.saveInterval) {
      this.lastSaveTime = 0;
      this.saveToDb();
    }
  }
}
