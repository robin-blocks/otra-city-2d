import { SIM_TICK_RATE, POSITION_UPDATE_RATE, PERCEPTION_BROADCAST_RATE } from '@otra/shared';
import type { World } from './world.js';

export class GameLoop {
  private running = false;
  private lastTime = 0;
  private simAccumulator = 0;
  private posAccumulator = 0;
  private perceptionAccumulator = 0;
  private tick = 0;

  private readonly SIM_STEP = 1000 / SIM_TICK_RATE;         // 100ms
  private readonly POS_STEP = 1000 / POSITION_UPDATE_RATE;   // ~33ms
  private readonly PERC_STEP = 1000 / PERCEPTION_BROADCAST_RATE; // 250ms

  constructor(
    private world: World,
    private onPerceptionTick: (tick: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    console.log(`[GameLoop] Started — sim: ${SIM_TICK_RATE}Hz, pos: ${POSITION_UPDATE_RATE}Hz, perception: ${PERCEPTION_BROADCAST_RATE}Hz`);
    this.loop();
  }

  stop(): void {
    this.running = false;
    console.log('[GameLoop] Stopped');
  }

  private loop = (): void => {
    if (!this.running) return;

    const now = performance.now();
    const delta = now - this.lastTime;
    this.lastTime = now;

    // Cap delta to prevent spiral of death after long pauses
    const cappedDelta = Math.min(delta, 500);

    this.posAccumulator += cappedDelta;
    this.simAccumulator += cappedDelta;
    this.perceptionAccumulator += cappedDelta;

    // Position updates (30 Hz) — highest frequency
    while (this.posAccumulator >= this.POS_STEP) {
      this.world.updatePositions(this.POS_STEP / 1000);
      this.posAccumulator -= this.POS_STEP;
    }

    // Simulation ticks (10 Hz) — needs, economy, deaths, foraging
    while (this.simAccumulator >= this.SIM_STEP) {
      const dt = this.SIM_STEP / 1000;
      this.world.updateNeeds(dt);
      this.world.updateLawEnforcement(dt);
      this.world.updateForageables(dt);
      this.world.checkDeaths();
      this.world.updateTrain(dt);
      this.world.checkSave(dt);
      this.simAccumulator -= this.SIM_STEP;
    }

    // Perception broadcasts (4 Hz) — send state to clients
    while (this.perceptionAccumulator >= this.PERC_STEP) {
      this.tick++;
      this.onPerceptionTick(this.tick);
      this.world.computeSpeechListeners();
      this.world.checkNearbyAlerts();
      this.world.clearPendingSpeech();
      this.world.clearPendingNotifications();
      this.world.clearPendingPainMessages();
      this.perceptionAccumulator -= this.PERC_STEP;
    }

    // Yield to event loop, then continue
    setImmediate(this.loop);
  };
}
