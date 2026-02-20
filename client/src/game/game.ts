import { Application, Container, Graphics } from 'pixi.js';
import type { MapData, PerceptionUpdate, ResidentState, VisibleResident, VisibleEntity, VisibleForageable, AudibleMessage, Passport, InventoryItem } from '@otra/shared';
import { WALK_SPEED, RUN_SPEED, QUID_SYMBOL, GAME_DAY_SECONDS, TIME_SCALE } from '@otra/shared';
import { WsClient } from '../network/ws-client.js';
import { ActionSender } from '../network/action-sender.js';
import { MapRenderer } from '../rendering/map-renderer.js';
import { ResidentRenderer } from '../rendering/resident-renderer.js';
import { SpeechBubbleRenderer } from '../rendering/speech-bubble.js';
import { Camera } from './camera.js';
import { InputHandler } from './input.js';
import { InventoryUI } from '../ui/inventory.js';
import { ShopUI } from '../ui/shop.js';
import { InspectUI } from '../ui/inspect.js';
import { BuildingInfoUI } from '../ui/building-info.js';

export class Game {
  private app!: Application;
  private worldContainer!: Container;
  private uiContainer!: Container;

  private wsClient!: WsClient;
  private actions!: ActionSender;
  private mapRenderer!: MapRenderer;
  private residentRenderer!: ResidentRenderer;
  private speechRenderer!: SpeechBubbleRenderer;
  private camera!: Camera;
  private input!: InputHandler;
  private inventoryUI!: InventoryUI;
  private shopUI!: ShopUI;
  private inspectUI!: InspectUI;
  private buildingInfoUI!: BuildingInfoUI;

  // State
  private selfId = '';
  private selfName = '';
  private selfPassport: Passport | null = null;
  private selfX = 0;
  private selfY = 0;
  private selfFacing = 0;
  private selfAction = 'idle';
  private selfSkinTone = 0;
  private selfHairColor = 0;
  private selfFramework: string | null = null;
  private lastPerception: PerceptionUpdate | null = null;
  private mapLoaded = false;
  private spectatorMode = false;

  // Spectator camera tracking
  private originalFollowId = '';
  private currentFollowId = '';
  private currentFollowName = '';
  private spectatorKeys = new Set<string>();
  private lastVisible: VisibleEntity[] = [];

  // Drag-to-scroll state
  private dragPointerDown = false;
  private dragMoved = false;
  private dragStartScreenX = 0;
  private dragStartScreenY = 0;
  private dragStartFreeX = 0;
  private dragStartFreeY = 0;

  // Pinch-to-zoom state
  private pinchActive = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;

  // State-diff tracking for event feed
  private prevSleeping = false;
  private prevBuilding: string | null = null;
  private prevWallet = 0;
  private prevInventoryCount = 0;
  private prevStatus = 'idle';

  // Client-side prediction
  private predictedX = 0;
  private predictedY = 0;
  private moveDirection: number | null = null;  // degrees, null = stopped
  private moveSpeed: 'walk' | 'run' = 'walk';

  // Game time (interpolated client-side between perception ticks)
  private worldTime = 0;  // game seconds
  private lastWorldTimeUpdate = 0;  // performance.now() of last server time

  // Forageable state overlays
  private forageableOverlays = new Map<string, Graphics>();
  private forageableContainer: Container | null = null;

  async init(): Promise<void> {
    this.app = new Application();
    await this.app.init({
      resizeTo: window,
      backgroundColor: 0x0a0a1a,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    const appEl = document.getElementById('app')!;
    appEl.insertBefore(this.app.canvas, appEl.firstChild);

    this.worldContainer = new Container();
    this.worldContainer.sortableChildren = true;
    this.uiContainer = new Container();

    this.app.stage.addChild(this.worldContainer);
    this.app.stage.addChild(this.uiContainer);

    // Renderers
    this.mapRenderer = new MapRenderer(this.worldContainer);
    this.residentRenderer = new ResidentRenderer(this.worldContainer);
    this.speechRenderer = new SpeechBubbleRenderer(this.worldContainer);

    // Forageable overlay container (above map, below residents)
    this.forageableContainer = new Container();
    this.forageableContainer.zIndex = 1; // above map (0), below residents
    this.worldContainer.addChild(this.forageableContainer);

    // Camera
    this.camera = new Camera(this.worldContainer, this.app.screen.width, this.app.screen.height);

    // Network
    this.wsClient = new WsClient();
    this.actions = new ActionSender(this.wsClient);

    // UI overlays
    this.inventoryUI = new InventoryUI(this.actions);
    this.shopUI = new ShopUI(this.actions);
    this.inspectUI = new InspectUI();
    this.inspectUI.onHide = () => { this.input.uiOpen = false; };
    this.buildingInfoUI = new BuildingInfoUI();
    this.buildingInfoUI.onHide = () => { this.input.uiOpen = false; };

    // Click-to-inspect residents (player mode) / click-to-follow (spectator mode)
    this.residentRenderer.onResidentClick = (residentId: string) => {
      if (this.input.uiOpen) return;
      if (this.dragMoved) return; // Ignore clicks that were part of a drag

      if (this.spectatorMode) {
        // Spectator: click to inspect resident (fetch full data including bio)
        if (residentId === this.selfId) {
          this.input.uiOpen = true;
          this.inspectUI.showById(residentId, this.selfPassport?.preferred_name ?? undefined);
        } else {
          const target = this.lastVisible.find(
            v => v.type === 'resident' && v.id === residentId,
          );
          if (target && target.type === 'resident') {
            this.input.uiOpen = true;
            this.inspectUI.showOther(target);
          }
        }
      } else {
        // Player mode: inspect via server
        this.actions.inspect(residentId);
      }
    };

    // Click-to-inspect buildings
    this.mapRenderer.onBuildingClick = (buildingId: string) => {
      if (this.input.uiOpen) return;
      this.input.uiOpen = true;
      this.buildingInfoUI.show(buildingId);
    };

    // Input
    this.input = new InputHandler(this.actions);
    this.input.onChatSubmit = (text: string) => {
      this.actions.speak(text);
      // Immediately show own speech bubble (don't wait for server perception)
      this.speechRenderer.addLocalMessage(
        this.selfId,
        text,
        this.predictedX,
        this.predictedY,
      );
    };
    this.input.onHotkey = (key: string) => this.handleHotkey(key);

    // Handle window resize
    window.addEventListener('resize', () => {
      this.camera.setScreenSize(this.app.screen.width, this.app.screen.height);
    });

    // Game loop
    this.app.ticker.add(() => {
      const dt = this.app.ticker.deltaMS / 1000;
      this.update(dt);
    });
  }

  async register(
    fullName: string, preferredName: string, origin: string,
    type: 'HUMAN' | 'AGENT' = 'HUMAN', agentFramework?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      full_name: fullName,
      preferred_name: preferredName || fullName.split(' ')[0],
      place_of_origin: origin,
      type,
    };
    if (type === 'AGENT' && agentFramework) {
      body.agent_framework = agentFramework;
    }
    const res = await fetch('/api/passport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }

    const data = await res.json();
    return data.token;
  }

  async connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wsClient.onWelcome = async (resident: ResidentState, mapUrl: string, worldTime: number) => {
        console.log(`[Game] Welcome! ${resident.passport.preferred_name} (${resident.passport.passport_no})`);

        this.selfId = resident.id;
        this.selfName = resident.passport.preferred_name;
        this.selfPassport = resident.passport;
        this.worldTime = worldTime;
        this.lastWorldTimeUpdate = performance.now();
        this.selfX = resident.x;
        this.selfY = resident.y;
        this.predictedX = resident.x;
        this.predictedY = resident.y;
        this.selfFacing = resident.facing;
        this.selfSkinTone = resident.passport.skin_tone;
        this.selfHairColor = resident.passport.hair_color;
        this.selfFramework = resident.agent_framework ?? null;

        // Init state-diff tracking
        this.prevSleeping = resident.is_sleeping;
        this.prevBuilding = resident.current_building;
        this.prevWallet = resident.wallet;
        this.prevInventoryCount = resident.inventory.length;
        this.prevStatus = resident.status;

        // Load map
        if (!this.mapLoaded) {
          try {
            const mapRes = await fetch(mapUrl);
            const mapData: MapData = await mapRes.json();
            this.mapRenderer.render(mapData);
            this.mapLoaded = true;
          } catch (err) {
            console.error('[Game] Failed to load map:', err);
          }
        }

        // Snap camera to player position
        this.camera.snapTo(this.selfX, this.selfY);

        // Update HUD
        this.updateHud(resident.needs.hunger, resident.needs.thirst, resident.needs.energy,
          resident.needs.bladder, resident.needs.social, resident.needs.health, resident.wallet);

        resolve();
      };

      this.wsClient.onPerception = (data: PerceptionUpdate) => {
        this.lastPerception = data;

        // Sync game time from server
        this.worldTime = data.world_time;
        this.lastWorldTimeUpdate = performance.now();

        // Server reconciliation: snap predicted position toward server
        // If difference is small, lerp toward server; if large, snap
        const serverX = data.self.x;
        const serverY = data.self.y;
        const dx = serverX - this.predictedX;
        const dy = serverY - this.predictedY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 100) {
          // Teleport — too far off
          this.predictedX = serverX;
          this.predictedY = serverY;
        } else {
          // Blend toward server position
          this.predictedX += dx * 0.3;
          this.predictedY += dy * 0.3;
        }

        this.selfX = serverX;
        this.selfY = serverY;
        this.selfFacing = data.self.facing;
        this.selfAction = data.self.status;

        // Update HUD
        this.updateHud(
          data.self.hunger, data.self.thirst, data.self.energy,
          data.self.bladder, data.self.social, data.self.health, data.self.wallet,
        );

        // Update speech bubble position map every perception tick
        const positions = new Map<string, { x: number; y: number }>();
        positions.set(this.selfId, { x: this.predictedX, y: this.predictedY });
        for (const v of data.visible) {
          if (v.type === 'resident') {
            positions.set(v.id, { x: v.x, y: v.y });
          }
        }
        this.speechRenderer.updateResidentPositions(positions);

        // Process speech bubbles
        if (data.audible.length > 0) {
          this.speechRenderer.addMessages(data.audible);
        }

        // Update interaction prompts
        this.updateInteractionPrompts(data.interactions, data.self.current_building);

        // Update building transparency
        this.mapRenderer.setCurrentBuilding(data.self.current_building);

        // Update shop wallet if open
        this.shopUI.updateWallet(data.self.wallet);

        // Add event feed items for interesting events
        for (const notif of data.notifications) {
          this.addEventFeedItem(notif);
        }

        // State-diff event detection
        this.detectStateChanges(data);

        // Update forageable overlays
        const forageables = data.visible.filter((v): v is VisibleForageable => v.type === 'forageable');
        this.updateForageableOverlays(forageables);
      };

      this.wsClient.onInspectResult = (data) => {
        this.inspectUI.show(data);
        this.input.uiOpen = true;
      };

      this.wsClient.onPain = (message: string, _source: string, intensity: string) => {
        const prefix = intensity === 'agony' ? '⚠️ ' : intensity === 'severe' ? '🔴 ' : '🟡 ';
        this.addEventFeedItem(prefix + message);
      };

      this.wsClient.onError = async (code: string, message: string) => {
        if (code === 'not_spawned') {
          this.addEventFeedItem('Waiting for the next train...');
          // Load map so the screen isn't blank while waiting
          if (!this.mapLoaded) {
            try {
              const mapRes = await fetch('/api/map');
              const mapData: MapData = await mapRes.json();
              this.mapRenderer.render(mapData);
              this.mapLoaded = true;
            } catch (err) {
              console.error('[Game] Failed to load map:', err);
            }
          }
        } else {
          reject(new Error(`${code}: ${message}`));
        }
      };

      this.wsClient.connect(token);
    });
  }

  async loadMapOnly(): Promise<void> {
    if (this.mapLoaded) return;
    try {
      const res = await fetch('/api/map');
      const mapData: MapData = await res.json();
      this.mapRenderer.render(mapData);
      this.mapLoaded = true;
    } catch (err) {
      console.error('[Game] Failed to load map:', err);
    }
  }

  async spectate(residentId: string): Promise<void> {
    this.spectatorMode = true;
    this.input.spectatorMode = true; // Disable InputHandler key processing

    // Movement keys that should be captured for camera panning
    const movementKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

    // Set up spectator keyboard listeners for camera panning
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      this.spectatorKeys.add(key);
      if (movementKeys.has(key)) {
        e.preventDefault(); // Prevent page scrolling from arrow keys
      }
      if (e.key === 'Escape') {
        if (this.inspectUI.isVisible()) this.inspectUI.hide();
        if (this.buildingInfoUI.isVisible()) this.buildingInfoUI.hide();
        this.input.uiOpen = false;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.spectatorKeys.delete(e.key.toLowerCase());
    });
    // Prevent stuck keys when window loses focus
    window.addEventListener('blur', () => {
      this.spectatorKeys.clear();
    });

    // Bind re-centre button
    const recentreBtn = document.getElementById('spectator-recentre');
    if (recentreBtn) {
      recentreBtn.addEventListener('click', () => this.recentre());
    }

    // Set up click-and-drag-to-scroll on canvas
    this.setupDragToScroll();

    return new Promise((resolve, reject) => {
      this.wsClient.onWelcome = async (resident: ResidentState, mapUrl: string, worldTime: number) => {
        console.log(`[Game] Spectating ${resident.passport.preferred_name} (${resident.passport.passport_no})`);

        this.selfId = resident.id;
        this.selfName = resident.passport.preferred_name;
        this.selfPassport = resident.passport;
        this.worldTime = worldTime;
        this.lastWorldTimeUpdate = performance.now();
        this.selfX = resident.x;
        this.selfY = resident.y;
        this.predictedX = resident.x;
        this.predictedY = resident.y;
        this.selfFacing = resident.facing;
        this.selfSkinTone = resident.passport.skin_tone;
        this.selfHairColor = resident.passport.hair_color;
        this.selfFramework = resident.agent_framework ?? null;

        // Initialize spectator follow tracking
        this.originalFollowId = resident.id;
        this.currentFollowId = resident.id;
        this.currentFollowName = resident.passport.preferred_name;

        // Init state-diff tracking
        this.prevSleeping = resident.is_sleeping;
        this.prevBuilding = resident.current_building;
        this.prevWallet = resident.wallet;
        this.prevInventoryCount = resident.inventory.length;
        this.prevStatus = resident.status;

        // Show spectator inventory panel
        const specInv = document.getElementById('spectator-inventory');
        if (specInv) specInv.style.display = 'block';

        if (!this.mapLoaded) {
          try {
            const mapRes = await fetch(mapUrl);
            const mapData: MapData = await mapRes.json();
            this.mapRenderer.render(mapData);
            this.mapLoaded = true;
          } catch (err) {
            console.error('[Game] Failed to load map:', err);
          }
        }

        this.camera.snapTo(this.selfX, this.selfY);
        this.updateHud(resident.needs.hunger, resident.needs.thirst, resident.needs.energy,
          resident.needs.bladder, resident.needs.social, resident.needs.health, resident.wallet);

        resolve();
      };

      this.wsClient.onPerception = (data: PerceptionUpdate) => {
        this.lastPerception = data;
        this.lastVisible = data.visible;
        this.worldTime = data.world_time;
        this.lastWorldTimeUpdate = performance.now();

        // In spectator mode, use server position directly (no prediction)
        this.predictedX = data.self.x;
        this.predictedY = data.self.y;
        this.selfX = data.self.x;
        this.selfY = data.self.y;
        this.selfFacing = data.self.facing;
        this.selfAction = data.self.status;

        this.updateHud(
          data.self.hunger, data.self.thirst, data.self.energy,
          data.self.bladder, data.self.social, data.self.health, data.self.wallet,
        );

        const positions = new Map<string, { x: number; y: number }>();
        positions.set(this.selfId, { x: this.predictedX, y: this.predictedY });
        for (const v of data.visible) {
          if (v.type === 'resident') {
            positions.set(v.id, { x: v.x, y: v.y });
          }
        }
        this.speechRenderer.updateResidentPositions(positions);

        if (data.audible.length > 0) {
          this.speechRenderer.addMessages(data.audible);
        }

        this.mapRenderer.setCurrentBuilding(data.self.current_building);

        for (const notif of data.notifications) {
          this.addEventFeedItem(notif);
        }

        // State-diff event detection
        this.detectStateChanges(data);

        // Update forageable overlays
        const forageables = data.visible.filter((v): v is VisibleForageable => v.type === 'forageable');
        this.updateForageableOverlays(forageables);

        // Update spectator inventory panel
        this.updateSpectatorInventory(data.self.inventory, data.self.wallet);

        // If following a non-original resident who is no longer visible, auto-recentre
        if (this.currentFollowId !== this.originalFollowId) {
          const stillVisible = data.visible.some(
            v => v.type === 'resident' && v.id === this.currentFollowId,
          );
          if (!stillVisible) {
            this.recentre();
          }
        }
      };

      this.wsClient.onError = (_code: string, message: string) => {
        reject(new Error(message));
      };

      this.wsClient.connectSpectator(residentId);
    });
  }

  private update(dt: number): void {
    if (!this.spectatorMode) {
      // Process input
      this.input.process();

      // Client-side prediction: move predicted position based on local input
      this.moveDirection = this.input.currentDirection;
      this.moveSpeed = this.input.currentSpeed;

      if (this.moveDirection !== null) {
        const speed = this.moveSpeed === 'run' ? RUN_SPEED : WALK_SPEED;
        const rad = (this.moveDirection * Math.PI) / 180;
        this.predictedX += Math.cos(rad) * speed * dt;
        this.predictedY += Math.sin(rad) * speed * dt;
      }

      // Player mode: always follow predicted position
      this.camera.followPosition(this.predictedX, this.predictedY);
    } else {
      // Spectator mode: process camera panning from raw keys
      let dx = 0, dy = 0;
      if (this.spectatorKeys.has('w') || this.spectatorKeys.has('arrowup')) dy -= 1;
      if (this.spectatorKeys.has('s') || this.spectatorKeys.has('arrowdown')) dy += 1;
      if (this.spectatorKeys.has('a') || this.spectatorKeys.has('arrowleft')) dx -= 1;
      if (this.spectatorKeys.has('d') || this.spectatorKeys.has('arrowright')) dx += 1;

      if (dx !== 0 || dy !== 0) {
        // Normalize diagonal movement
        if (dx !== 0 && dy !== 0) {
          const len = Math.sqrt(dx * dx + dy * dy);
          dx /= len;
          dy /= len;
        }
        this.camera.moveCamera(dx, dy, dt);
        this.updateRecentreButton();
      }

      // Update follow target from perception data (without changing camera mode)
      if (this.currentFollowId === this.originalFollowId) {
        this.camera.updateFollowTarget(this.selfX, this.selfY);
      } else {
        const target = this.lastVisible.find(
          v => v.type === 'resident' && v.id === this.currentFollowId,
        );
        if (target) {
          this.camera.updateFollowTarget(target.x, target.y);
        }
      }
    }

    this.camera.update(dt);

    // Update resident sprites from last perception
    if (this.lastPerception) {
      const visibleResidents = this.lastPerception.visible.filter(
        (v): v is VisibleResident => v.type === 'resident'
      );

      // Compute self condition from perception data
      const self = this.lastPerception.self;
      let selfCondition: 'healthy' | 'struggling' | 'critical' = 'healthy';
      if (self.health < 20 || self.hunger <= 0 || self.thirst <= 0) selfCondition = 'critical';
      else if (self.hunger < 20 || self.thirst < 20 || self.energy < 10 || self.health < 50) selfCondition = 'struggling';

      // Pass predicted position for self — this is instant
      this.residentRenderer.updateResidents(
        visibleResidents,
        this.selfId, this.selfName, this.predictedX, this.predictedY,
        this.selfFacing, this.selfAction,
        this.selfSkinTone, this.selfHairColor,
        this.selfFramework, selfCondition,
      );
    }

    // Update speech bubbles
    this.speechRenderer.update();

    // Interpolate game time client-side and update clock + tinting
    const elapsed = (performance.now() - this.lastWorldTimeUpdate) / 1000;
    const currentTime = this.worldTime + elapsed * TIME_SCALE;
    this.updateClock(currentTime);
    this.mapRenderer.setTimeOfDay(currentTime);
  }

  /**
   * Interpolates a color from a gradient based on a value (0-100).
   * Maps: 0 = red, 50 = yellow, 100 = green.
   * @param value The current value (0-100).
   * @param inverted If true, the gradient is reversed (0 = green, 100 = red).
   * @returns A CSS hex color string (e.g., "#ff0000").
   */
  private getGradientColor(value: number, inverted: boolean = false): string {
    if (inverted) {
      value = 100 - value;
    }

    // Clamp the value between 0 and 100
    value = Math.max(0, Math.min(100, value));

    let r: number, g: number, b: number;

    if (value > 50) {
      // Yellow to Green (50 -> 100)
      const t = (value - 50) / 50;
      r = Math.round(255 * (1 - t));
      g = Math.round(165 + 90 * t);
      b = 0;
    } else {
      // Red to Yellow (0 -> 50)
      const t = value / 50;
      r = 255;
      g = Math.round(255 * t);
      b = 0;
    }

    const toHex = (c: number) => c.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  /**
   * Returns a blue-tinted gradient color for the thirst bar.
   * Maps: 0 = red/orange (dehydrated), 50 = light blue, 100 = deep blue (hydrated).
   * @param value The current thirst value (0-100).
   * @returns A CSS hex color string.
   */
  private getThirstColor(value: number): string {
    value = Math.max(0, Math.min(100, value));

    let r: number, g: number, b: number;

    if (value > 50) {
      // Light blue to deep blue (50 -> 100)
      const t = (value - 50) / 50;
      r = Math.round(100 * (1 - t) + 30 * t);
      g = Math.round(180 * (1 - t) + 120 * t);
      b = Math.round(220 + 35 * t);
    } else {
      // Red/orange to light blue (0 -> 50)
      const t = value / 50;
      r = Math.round(220 * (1 - t) + 100 * t);
      g = Math.round(60 * (1 - t) + 180 * t);
      b = Math.round(50 * (1 - t) + 220 * t);
    }

    const toHex = (c: number) => c.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private getSocialColor(value: number): string {
    value = Math.max(0, Math.min(100, value));

    let r: number, g: number, b: number;

    if (value > 50) {
      // Light purple to vibrant purple (50 -> 100)
      const t = (value - 50) / 50;
      r = Math.round(160 * (1 - t) + 180 * t);
      g = Math.round(120 * (1 - t) + 80 * t);
      b = Math.round(200 + 55 * t);
    } else {
      // Gray-red to light purple (0 -> 50)
      const t = value / 50;
      r = Math.round(150 * (1 - t) + 160 * t);
      g = Math.round(80 * (1 - t) + 120 * t);
      b = Math.round(80 * (1 - t) + 200 * t);
    }

    const toHex = (c: number) => c.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private updateHud(
    hunger: number, thirst: number, energy: number,
    bladder: number, social: number, health: number, wallet: number,
  ): void {
    const hungerBar = document.getElementById('hunger-bar');
    const thirstBar = document.getElementById('thirst-bar');
    const energyBar = document.getElementById('energy-bar');
    const bladderBar = document.getElementById('bladder-bar');
    const socialBar = document.getElementById('social-bar');
    const healthBar = document.getElementById('health-bar');
    const walletEl = document.getElementById('wallet');

    if (hungerBar) {
      hungerBar.style.width = `${hunger}%`;
      hungerBar.style.backgroundColor = this.getGradientColor(hunger);
    }
    if (thirstBar) {
      thirstBar.style.width = `${thirst}%`;
      thirstBar.style.backgroundColor = this.getThirstColor(thirst);
    }
    if (energyBar) {
      energyBar.style.width = `${energy}%`;
      energyBar.style.backgroundColor = this.getGradientColor(energy);
    }
    if (bladderBar) {
      bladderBar.style.width = `${bladder}%`;
      // Inverted: 0 = healthy (green), 100 = desperate (red)
      bladderBar.style.backgroundColor = this.getGradientColor(bladder, true);
    }
    if (socialBar) {
      socialBar.style.width = `${social}%`;
      socialBar.style.backgroundColor = this.getSocialColor(social);
    }
    if (healthBar) {
      healthBar.style.width = `${health}%`;
      healthBar.style.backgroundColor = this.getGradientColor(health);
    }
    if (walletEl) walletEl.textContent = `${QUID_SYMBOL}${wallet}`;

    // Update numeric values next to bars
    const hungerVal = document.getElementById('hunger-val');
    const thirstVal = document.getElementById('thirst-val');
    const energyVal = document.getElementById('energy-val');
    const bladderVal = document.getElementById('bladder-val');
    const socialVal = document.getElementById('social-val');
    const healthVal = document.getElementById('health-val');
    if (hungerVal) hungerVal.textContent = hunger.toFixed(1);
    if (thirstVal) thirstVal.textContent = thirst.toFixed(1);
    if (energyVal) energyVal.textContent = energy.toFixed(1);
    if (bladderVal) bladderVal.textContent = bladder.toFixed(1);
    if (socialVal) socialVal.textContent = social.toFixed(1);
    if (healthVal) healthVal.textContent = health.toFixed(1);
  }

  private handleHotkey(key: string): void {
    const perc = this.lastPerception;
    const interactions = perc?.interactions ?? [];
    const currentBuilding = perc?.self.current_building ?? null;

    if (key === 'escape') {
      // Close any open UI
      if (this.inventoryUI.isVisible()) this.inventoryUI.hide();
      if (this.shopUI.isVisible()) this.shopUI.hide();
      if (this.inspectUI.isVisible()) this.inspectUI.hide();
      if (this.buildingInfoUI.isVisible()) this.buildingInfoUI.hide();
      this.input.uiOpen = false;
      return;
    }

    if (key === 'i') {
      // Toggle inventory
      const wallet = perc?.self.wallet ?? 0;
      const inventory = perc?.self.inventory ?? [];
      this.inventoryUI.toggle(inventory, wallet);
      if (this.shopUI.isVisible()) this.shopUI.hide();
      this.input.uiOpen = this.inventoryUI.isVisible();
      return;
    }

    if (key === 'e') {
      // Enter/exit building
      if (currentBuilding) {
        this.actions.exitBuilding();
      } else {
        // Find enter_building interaction
        const enterAction = interactions.find(i => i.startsWith('enter_building:'));
        if (enterAction) {
          const buildingId = enterAction.split(':')[1];
          this.actions.enterBuilding(buildingId);
        }
      }
      return;
    }

    if (key === 'b') {
      // Open shop (must be in council-supplies)
      if (currentBuilding === 'council-supplies' && interactions.includes('buy')) {
        const wallet = perc?.self.wallet ?? 0;
        this.shopUI.show(wallet);
        if (this.inventoryUI.isVisible()) this.inventoryUI.hide();
        this.input.uiOpen = true;
      }
      return;
    }

    if (key === 'u') {
      // Use toilet
      if (interactions.includes('use_toilet')) {
        this.actions.useToilet();
      }
      return;
    }
  }

  private updateInteractionPrompts(interactions: string[], currentBuilding: string | null): void {
    const el = document.getElementById('interaction-prompts');
    if (!el) return;

    const prompts: string[] = [];

    if (currentBuilding) {
      prompts.push('<span class="prompt-key">[E]</span> Exit Building');

      if (interactions.includes('buy')) {
        prompts.push('<span class="prompt-key">[B]</span> Shop');
      }
      if (interactions.includes('use_toilet')) {
        prompts.push('<span class="prompt-key">[U]</span> Use Toilet');
      }
    } else {
      // Check for enter_building
      const enterAction = interactions.find(i => i.startsWith('enter_building:'));
      if (enterAction) {
        prompts.push('<span class="prompt-key">[E]</span> Enter Building');
      }
    }

    if (interactions.includes('eat') || interactions.includes('drink')) {
      prompts.push('<span class="prompt-key">[I]</span> Inventory');
    }

    el.innerHTML = prompts.join(' &nbsp; ');
  }

  private static MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  private static DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  private updateClock(worldTimeSec: number): void {
    const daySeconds = worldTimeSec % GAME_DAY_SECONDS;
    const hour = Math.floor(daySeconds / 3600);
    const minute = Math.floor((daySeconds % 3600) / 60);
    let dayOfYear = Math.floor(worldTimeSec / GAME_DAY_SECONDS);  // 0-based

    // Convert day-of-year to month + day
    let month = 0;
    while (month < 11 && dayOfYear >= Game.DAYS_IN_MONTH[month]) {
      dayOfYear -= Game.DAYS_IN_MONTH[month];
      month++;
    }
    const dayOfMonth = dayOfYear + 1;

    const timeEl = document.getElementById('clock-time');
    const dayEl = document.getElementById('clock-day');
    if (timeEl) timeEl.textContent = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (dayEl) dayEl.textContent = `${dayOfMonth} ${Game.MONTH_NAMES[month]}`;
  }

  /** Update forageable overlays showing uses-remaining pips */
  private updateForageableOverlays(visible: VisibleForageable[]): void {
    if (!this.forageableContainer) return;

    // Track which nodes we've seen this tick
    const seen = new Set<string>();

    for (const node of visible) {
      seen.add(node.id);
      let g = this.forageableOverlays.get(node.id);

      if (!g) {
        g = new Graphics();
        this.forageableOverlays.set(node.id, g);
        this.forageableContainer.addChild(g);
      }

      // Redraw overlay
      g.clear();

      const isBerry = node.resource_type === 'berry_bush';
      const maxUses = isBerry ? 3 : 4;
      const uses = node.uses_remaining;
      const depleted = uses <= 0;

      // Dim overlay for depleted nodes
      if (depleted) {
        g.circle(node.x, node.y, 14);
        g.fill({ color: 0x000000, alpha: 0.35 });
      }

      // Uses-remaining pips (small dots above the node)
      const pipY = node.y - 18;
      const pipSpacing = 6;
      const pipStartX = node.x - ((maxUses - 1) * pipSpacing) / 2;

      for (let i = 0; i < maxUses; i++) {
        const filled = i < uses;
        const pipX = pipStartX + i * pipSpacing;
        g.circle(pipX, pipY, 2.5);
        if (filled) {
          g.fill(isBerry ? 0x44cc44 : 0x44aadd);
        } else {
          g.fill({ color: 0x333333, alpha: 0.6 });
        }
      }
    }

    // Remove overlays for nodes no longer visible
    for (const [id, g] of this.forageableOverlays) {
      if (!seen.has(id)) {
        g.clear();
        this.forageableContainer.removeChild(g);
        g.destroy();
        this.forageableOverlays.delete(id);
      }
    }
  }

  private detectStateChanges(data: PerceptionUpdate): void {
    const self = data.self;

    // Sleep state changes
    if (self.is_sleeping && !this.prevSleeping) {
      this.addEventFeedItem('Fell asleep');
    } else if (!self.is_sleeping && this.prevSleeping) {
      this.addEventFeedItem('Woke up');
    }

    // Building entry/exit
    if (self.current_building && self.current_building !== this.prevBuilding) {
      this.addEventFeedItem(`Entered ${self.current_building}`);
    } else if (!self.current_building && this.prevBuilding) {
      this.addEventFeedItem('Left building');
    }

    // Wallet changes
    if (self.wallet !== this.prevWallet) {
      const diff = self.wallet - this.prevWallet;
      const sign = diff > 0 ? '+' : '';
      this.addEventFeedItem(`Wallet: ${QUID_SYMBOL}${this.prevWallet} → ${QUID_SYMBOL}${self.wallet} (${sign}${diff})`);
    }

    // Inventory changes
    const invCount = self.inventory.length;
    if (invCount > this.prevInventoryCount) {
      this.addEventFeedItem('Received an item');
    } else if (invCount < this.prevInventoryCount) {
      this.addEventFeedItem('Used an item');
    }

    // Death
    if (self.status === 'dead' && this.prevStatus !== 'dead') {
      this.addEventFeedItem('Died');
    }

    // Update previous state
    this.prevSleeping = self.is_sleeping;
    this.prevBuilding = self.current_building;
    this.prevWallet = self.wallet;
    this.prevInventoryCount = invCount;
    this.prevStatus = self.status;
  }

  private showLocalInspect(): void {
    if (!this.selfPassport || !this.lastPerception) return;
    this.inspectUI.showLocal(this.selfPassport, this.lastPerception.self, this.selfFramework);
    this.input.uiOpen = true;
  }

  private showOtherInspect(residentId: string): void {
    if (!this.lastPerception) return;
    const resident = this.lastPerception.visible.find(
      (v) => v.type === 'resident' && v.id === residentId,
    );
    if (!resident || resident.type !== 'resident') return;
    this.inspectUI.showOther(resident);
    this.input.uiOpen = true;
  }

  private updateSpectatorInventory(
    inventory: InventoryItem[],
    wallet: number,
  ): void {
    const el = document.getElementById('spectator-inventory');
    if (!el) return;

    let html = `<div class="spec-inv-wallet">${QUID_SYMBOL}${wallet}</div>`;
    if (inventory.length === 0) {
      html += '<div class="spec-inv-empty">No items</div>';
    } else {
      for (const item of inventory) {
        html += `<div class="spec-inv-item">${item.type} ×${item.quantity}</div>`;
      }
    }
    el.innerHTML = html;
  }

  /** Set up click-and-drag-to-scroll on the canvas (spectator mode only) */
  private setupDragToScroll(): void {
    const canvas = this.app.canvas;
    canvas.style.cursor = 'grab';

    const DRAG_THRESHOLD = 5; // pixels before drag activates

    canvas.addEventListener('pointerdown', (e) => {
      if (this.pinchActive) return; // Don't start drag during pinch
      this.dragPointerDown = true;
      this.dragMoved = false;
      this.dragStartScreenX = e.clientX;
      this.dragStartScreenY = e.clientY;
      // Don't switch to free mode yet — wait for drag threshold
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragPointerDown || this.pinchActive) return;
      const dx = e.clientX - this.dragStartScreenX;
      const dy = e.clientY - this.dragStartScreenY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (!this.dragMoved && dist < DRAG_THRESHOLD) return; // Not a drag yet

      if (!this.dragMoved) {
        this.dragMoved = true;
        canvas.style.cursor = 'grabbing';
        // NOW switch to free mode and snapshot anchor
        if (this.camera.getMode() === 'follow') {
          this.camera.startFreeMode();
        }
        const pos = this.camera.getFreePosition();
        this.dragStartFreeX = pos.x;
        this.dragStartFreeY = pos.y;
      }

      // Invert: dragging right moves camera left in world space
      // Divide by zoom so drag distance maps correctly to world distance
      const zoom = this.camera.getZoom();
      this.camera.setFreePosition(
        this.dragStartFreeX - dx / zoom,
        this.dragStartFreeY - dy / zoom,
      );
      this.updateRecentreButton();
    });

    const endDrag = () => {
      this.dragPointerDown = false;
      canvas.style.cursor = 'grab';
      // dragMoved stays true briefly so the pointerdown-based resident click handler
      // can check it — it resets on the next pointerdown
    };

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointerleave', endDrag);

    // Pinch-to-zoom (touch events only — two fingers)
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        this.pinchActive = true;
        this.dragPointerDown = false; // Cancel any single-finger drag
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        this.pinchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        this.pinchStartZoom = this.camera.getZoom();
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!this.pinchActive || e.touches.length < 2) return;
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      if (this.pinchStartDist > 0) {
        const newZoom = this.pinchStartZoom * (dist / this.pinchStartDist);
        this.camera.setZoom(newZoom);
      }
    }, { passive: false });

    const endPinch = () => {
      this.pinchActive = false;
    };

    canvas.addEventListener('touchend', endPinch);
    canvas.addEventListener('touchcancel', endPinch);
  }

  /** Re-centre camera on the originally-followed resident */
  private recentre(): void {
    this.currentFollowId = this.originalFollowId;
    this.currentFollowName = this.selfName;
    this.camera.followPosition(this.selfX, this.selfY);
    this.updateSpectatorBanner();
    this.updateRecentreButton();
  }

  /** Show/hide the re-centre button based on current state */
  private updateRecentreButton(): void {
    const btn = document.getElementById('spectator-recentre');
    if (!btn) return;
    const showBtn = this.currentFollowId !== this.originalFollowId || this.camera.getMode() === 'free';
    btn.style.display = showBtn ? 'block' : 'none';
  }

  /** Update spectator banner to reflect the currently-followed resident */
  private updateSpectatorBanner(): void {
    const banner = document.getElementById('spectator-banner');
    if (!banner) return;

    let html: string;
    if (this.currentFollowId === this.originalFollowId) {
      html = `Spectating: ${this.escapeHtml(this.selfName)}`;
    } else {
      html = `Spectating: ${this.escapeHtml(this.currentFollowName)}`;
    }
    html += ` · <a href="/quick-start" class="spectator-cta">Connect your own bot →</a>`;
    banner.innerHTML = html;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private addEventFeedItem(text: string): void {
    const feed = document.getElementById('event-feed');
    if (!feed) return;
    const item = document.createElement('div');
    item.className = 'event-item';
    item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    feed.appendChild(item);
    feed.scrollTop = feed.scrollHeight;

    // Limit to 50 items
    while (feed.children.length > 50) {
      feed.removeChild(feed.firstChild!);
    }
  }
}
