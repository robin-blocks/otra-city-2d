import { Application, Container } from 'pixi.js';
import type { MapData, PerceptionUpdate, ResidentState, VisibleResident, AudibleMessage, Passport, InventoryItem } from '@otra/shared';
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

    // Click-to-inspect residents
    this.residentRenderer.onResidentClick = (residentId: string) => {
      if (this.input.uiOpen) return;
      if (residentId === this.selfId) {
        // Self-click: in spectator mode show local passport; in player mode use server inspect
        if (this.spectatorMode) {
          this.showLocalInspect();
        } else {
          this.actions.inspect(residentId);
        }
      } else if (this.spectatorMode) {
        // Spectator clicking another resident: show limited info with spectate button
        this.showOtherInspect(residentId);
      } else {
        // Player mode: full inspect via server
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
          resident.needs.bladder, resident.needs.health, resident.wallet);

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
          data.self.bladder, data.self.health, data.self.wallet,
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
      };

      this.wsClient.onInspectResult = (data) => {
        this.inspectUI.show(data);
        this.input.uiOpen = true;
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

  async spectate(residentId: string): Promise<void> {
    this.spectatorMode = true;

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
          resident.needs.bladder, resident.needs.health, resident.wallet);

        resolve();
      };

      this.wsClient.onPerception = (data: PerceptionUpdate) => {
        this.lastPerception = data;
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
          data.self.bladder, data.self.health, data.self.wallet,
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

        // Update spectator inventory panel
        this.updateSpectatorInventory(data.self.inventory, data.self.wallet);
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
    }

    // Update camera to follow predicted position (smooth)
    this.camera.followPosition(this.predictedX, this.predictedY);
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

  private updateHud(
    hunger: number, thirst: number, energy: number,
    bladder: number, health: number, wallet: number,
  ): void {
    const hungerBar = document.getElementById('hunger-bar');
    const thirstBar = document.getElementById('thirst-bar');
    const energyBar = document.getElementById('energy-bar');
    const bladderBar = document.getElementById('bladder-bar');
    const healthBar = document.getElementById('health-bar');
    const walletEl = document.getElementById('wallet');

    if (hungerBar) hungerBar.style.width = `${hunger}%`;
    if (thirstBar) thirstBar.style.width = `${thirst}%`;
    if (energyBar) energyBar.style.width = `${energy}%`;
    if (bladderBar) bladderBar.style.width = `${bladder}%`;
    if (healthBar) healthBar.style.width = `${health}%`;
    if (walletEl) walletEl.textContent = `${QUID_SYMBOL}${wallet}`;

    // Update numeric values next to bars
    const hungerVal = document.getElementById('hunger-val');
    const thirstVal = document.getElementById('thirst-val');
    const energyVal = document.getElementById('energy-val');
    const bladderVal = document.getElementById('bladder-val');
    const healthVal = document.getElementById('health-val');
    if (hungerVal) hungerVal.textContent = hunger.toFixed(1);
    if (thirstVal) thirstVal.textContent = thirst.toFixed(1);
    if (energyVal) energyVal.textContent = energy.toFixed(1);
    if (bladderVal) bladderVal.textContent = bladder.toFixed(1);
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
      // Collect UBI
      if (interactions.includes('collect_ubi')) {
        this.actions.collectUbi();
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
      if (interactions.includes('collect_ubi')) {
        prompts.push('<span class="prompt-key">[U]</span> Collect UBI');
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
