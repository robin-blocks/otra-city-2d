import type { Needs, VisibleResident, Build } from '@otra/shared';
import {
  WALK_SPEED, RUN_SPEED, TILE_SIZE, RESIDENT_HITBOX,
  HUNGER_DECAY_PER_SEC, THIRST_DECAY_PER_SEC, ENERGY_PASSIVE_DECAY_PER_SEC,
  BLADDER_FILL_PER_SEC, HEALTH_DRAIN_HUNGER, HEALTH_DRAIN_THIRST,
  HEALTH_RECOVERY_PER_SEC, HEALTH_RECOVERY_THRESHOLD,
  TRAIN_INTERVAL_SEC, STARTING_QUID, FOV_ANGLE, FOV_RANGE, AMBIENT_RANGE,
  NORMAL_VOICE_RANGE, WHISPER_RANGE, SHOUT_RANGE, WALL_SOUND_FACTOR,
  TIME_SCALE, STARTING_HOUR, GAME_DAY_SECONDS,
} from '@otra/shared';
import type { WebSocket } from 'ws';
import { TileMap } from './map.js';
import { resolveMovement } from './collision.js';
import type { ResidentRow } from '../db/queries.js';
import {
  getAllAliveResidents, batchSaveResidents, saveWorldState,
  getWorldState, markResidentDead, logEvent, getInventory, batchSaveInventory,
} from '../db/queries.js';
import type { PerceptionUpdate, AudibleMessage, VisibleEntity, VisibleBuilding } from '@otra/shared';

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
  lastUbiCollection: number;
  // Appearance
  skinTone: number;
  hairStyle: number;
  hairColor: number;
  build: Build;
  // Runtime state
  ws: WebSocket | null;
  lastActionTime: number;
  // Speech tracking for perception
  pendingSpeech: Array<{ text: string; volume: 'whisper' | 'normal' | 'shout'; time: number }>;
}

export class World {
  residents = new Map<string, ResidentEntity>();
  map: TileMap;
  worldTime = 0;
  trainTimer = 0;
  trainQueue: string[] = [];
  private lastSaveTime = 0;
  private saveInterval = 30; // seconds

  constructor(map: TileMap) {
    this.map = map;

    // Load world state from DB
    const ws = getWorldState();
    this.worldTime = ws.world_time;
    this.trainTimer = ws.train_timer;
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
      employment: null,
      lastUbiCollection: row.last_ubi_collection,
      skinTone: row.skin_tone,
      hairStyle: row.hair_style,
      hairColor: row.hair_color,
      build: row.build as Build,
      ws: null,
      lastActionTime: 0,
      pendingSpeech: [],
    };
    this.residents.set(row.id, entity);
    return entity;
  }

  /** Position updates — called at 30 Hz */
  updatePositions(dt: number): void {
    for (const [, r] of this.residents) {
      if (r.isDead || r.isSleeping) continue;
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
      }
    }
  }

  /** Needs decay — called at 10 Hz */
  updateNeeds(dt: number): void {
    for (const [, r] of this.residents) {
      if (r.isDead) continue;

      // Hunger decays
      r.needs.hunger = Math.max(0, r.needs.hunger - HUNGER_DECAY_PER_SEC * dt);

      // Thirst decays
      r.needs.thirst = Math.max(0, r.needs.thirst - THIRST_DECAY_PER_SEC * dt);

      // Bladder fills
      r.needs.bladder = Math.min(100, r.needs.bladder + BLADDER_FILL_PER_SEC * dt);

      // Energy: passive decay or sleep recovery
      if (r.isSleeping) {
        // Recovery rate depends on equipment (sleeping bag)
        const hasSleepingBag = r.inventory.some(i => i.type === 'sleeping_bag');
        const recoveryRate = hasSleepingBag ? 10 / 3600 : 5 / 3600; // +10/hr with bag, +5/hr rough
        r.needs.energy = Math.min(100, r.needs.energy + recoveryRate * dt);

        // Auto-wake at 100
        if (r.needs.energy >= 100) {
          r.isSleeping = false;
          r.needs.energy = 100;
        }
      } else {
        r.needs.energy = Math.max(0, r.needs.energy - ENERGY_PASSIVE_DECAY_PER_SEC * dt);

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

      // Forced collapse at energy 0
      if (r.needs.energy <= 0 && !r.isSleeping) {
        r.needs.energy = 0;
        r.velocityX = 0;
        r.velocityY = 0;
        r.speed = 'stop';
        // Don't force sleep, just immobilize
      }

      // Health damage from unmet needs
      if (r.needs.hunger <= 0) {
        r.needs.health = Math.max(0, r.needs.health - HEALTH_DRAIN_HUNGER * dt);
      }
      if (r.needs.thirst <= 0) {
        r.needs.health = Math.max(0, r.needs.health - HEALTH_DRAIN_THIRST * dt);
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

        markResidentDead(id, cause);
        logEvent('death', id, null, null, r.x, r.y, {
          cause, wallet_lost: r.wallet
        });

        r.wallet = 0;
        console.log(`[World] ${r.preferredName} (${r.passportNo}) has died: ${cause}`);
      }
    }
  }

  /** Train timer — called at 10 Hz */
  updateTrain(dt: number): void {
    this.worldTime += dt * TIME_SCALE;
    this.trainTimer += dt;

    // In dev mode, use a shorter train interval (30 seconds)
    const interval = process.env.NODE_ENV === 'production' ? TRAIN_INTERVAL_SEC : 30;

    if (this.trainTimer >= interval) {
      this.trainTimer -= interval;
      this.spawnTrainArrivals();
    }

    // Immediately spawn if train queue has people and timer is close (within 5s)
    if (this.trainQueue.length > 0 && this.trainTimer >= interval - 5) {
      this.trainTimer = interval; // force trigger on next check
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
  }

  queueForTrain(residentId: string): void {
    this.trainQueue.push(residentId);

    // In development, spawn immediately instead of waiting for train
    if (process.env.NODE_ENV !== 'production') {
      this.spawnTrainArrivals();
    } else {
      const timeUntilTrain = TRAIN_INTERVAL_SEC - this.trainTimer;
      console.log(`[World] ${residentId} queued for train (arriving in ${Math.ceil(timeUntilTrain)}s)`);
    }
  }

  /** Compute perception for a single resident */
  computePerception(resident: ResidentEntity, tick: number): PerceptionUpdate {
    const visible: VisibleEntity[] = [];
    const audible: AudibleMessage[] = [];
    const interactions: string[] = [];

    // Always available actions
    interactions.push('speak', 'inspect');
    if (!resident.isSleeping && resident.needs.energy > 0) {
      interactions.push('move');
    }
    if (resident.needs.energy < 90 && !resident.isSleeping) {
      interactions.push('sleep');
    }
    if (resident.isSleeping) {
      interactions.push('wake');
    }

    // Include own pending speech in audible (distance 0)
    for (const speech of resident.pendingSpeech) {
      audible.push({
        from: resident.id,
        from_name: resident.preferredName,
        text: speech.text,
        volume: speech.volume,
        distance: 0,
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
      if (dist <= AMBIENT_RANGE) {
        canSee = true;
      }
      // 90° FOV cone
      else if (dist <= FOV_RANGE) {
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
        } satisfies VisibleResident);
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
          audible.push({
            from: other.id,
            from_name: other.preferredName,
            text: speech.text,
            volume: speech.volume,
            distance: Math.round(dist * 10) / 10,
          });
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
    }

    // Add buildings as visible entities
    for (const building of this.map.data.buildings) {
      const bCenterX = (building.tileX + building.widthTiles / 2) * TILE_SIZE;
      const bCenterY = (building.tileY + building.heightTiles / 2) * TILE_SIZE;
      const dx = bCenterX - resident.x;
      const dy = bCenterY - resident.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= FOV_RANGE * 1.5) { // buildings visible at slightly longer range
        visible.push({
          id: building.id,
          type: 'building',
          name: building.name,
          building_type: building.type,
          x: building.tileX * TILE_SIZE,
          y: building.tileY * TILE_SIZE,
          width: building.widthTiles * TILE_SIZE,
          height: building.heightTiles * TILE_SIZE,
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
      },
      visible,
      audible,
      interactions: [...new Set(interactions)],
      notifications: [],
    };
  }

  /** Clear pending speech after perception broadcast */
  clearPendingSpeech(): void {
    for (const [, r] of this.residents) {
      r.pendingSpeech = [];
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

    saveWorldState(this.worldTime, this.trainTimer);
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
