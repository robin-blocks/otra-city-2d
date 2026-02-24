import type { ServerMessage, PerceptionUpdate } from '@otra/shared';
import type { AgentRecorder } from './recorder.js';

export interface BenchEvent {
  timestamp: number;
  world_time: number;
  event_type: string;
  model_id: string;
  passport_no: string;
  data: Record<string, unknown>;
}

interface AgentTracker {
  modelId: string;
  passportNo: string;
  lastNeeds: Record<string, number> | null;
  criticalNeeds: Set<string>;  // needs currently below 10
  alive: boolean;
  recorder: AgentRecorder;
}

export class EventDetector {
  private trackers = new Map<string, AgentTracker>();
  private onEvent?: (event: BenchEvent) => void;

  constructor(opts?: { onEvent?: (event: BenchEvent) => void }) {
    this.onEvent = opts?.onEvent;
  }

  registerAgent(
    modelId: string,
    passportNo: string,
    recorder: AgentRecorder,
  ): void {
    this.trackers.set(modelId, {
      modelId,
      passportNo,
      lastNeeds: null,
      criticalNeeds: new Set(),
      alive: true,
      recorder,
    });
  }

  /** Called for every WS message from any agent's spectator feed */
  handleMessage(modelId: string, msg: ServerMessage): void {
    const tracker = this.trackers.get(modelId);
    if (!tracker) return;

    switch (msg.type) {
      case 'perception':
        this.processPerception(tracker, msg.data);
        break;
      case 'death':
        this.emitEvent(tracker, 0, 'death', {
          cause: msg.cause,
          resident_id: msg.resident_id,
        });
        tracker.alive = false;
        break;
      case 'pain':
        this.emitEvent(tracker, 0, 'pain_received', {
          message: msg.message,
          source: msg.source,
          intensity: msg.intensity,
          needs: msg.needs,
        });
        break;
      case 'event':
        // Pass through server-side events (forage, buy, etc.)
        this.emitEvent(tracker, 0, `server_${msg.event_type}`, msg.data);
        break;
    }
  }

  private processPerception(tracker: AgentTracker, perception: PerceptionUpdate): void {
    const self = perception.self;
    const worldTime = perception.world_time;
    const needs: Record<string, number> = {
      hunger: self.hunger,
      thirst: self.thirst,
      energy: self.energy,
      health: self.health,
      social: self.social,
    };

    // Check for critical needs (< 10)
    for (const [need, value] of Object.entries(needs)) {
      const wasCritical = tracker.criticalNeeds.has(need);

      if (value < 10 && !wasCritical) {
        tracker.criticalNeeds.add(need);
        this.emitEvent(tracker, worldTime, 'need_critical', {
          need,
          value: Math.round(value),
          all_needs: needs,
        });
      } else if (value > 30 && wasCritical) {
        tracker.criticalNeeds.delete(need);
        this.emitEvent(tracker, worldTime, 'need_recovered', {
          need,
          value: Math.round(value),
          all_needs: needs,
        });
      }
    }

    // Detect conversations (two-way speech visible in audible)
    if (perception.audible.length > 0) {
      for (const msg of perception.audible) {
        if (msg.to === self.id) {
          // Directed speech received
          this.emitEvent(tracker, worldTime, 'speech_received', {
            from: msg.from_name,
            text: msg.text,
            volume: msg.volume,
            directed: true,
          });
        }
      }
    }

    tracker.lastNeeds = needs;
  }

  private emitEvent(
    tracker: AgentTracker,
    worldTime: number,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    const event: BenchEvent = {
      timestamp: Date.now(),
      world_time: worldTime,
      event_type: eventType,
      model_id: tracker.modelId,
      passport_no: tracker.passportNo,
      data,
    };

    // Write to the agent's event log
    tracker.recorder.writeEvent(event);

    // Forward to callback
    this.onEvent?.(event);
  }

  isAlive(modelId: string): boolean {
    return this.trackers.get(modelId)?.alive ?? false;
  }

  getAliveCount(): number {
    let count = 0;
    for (const tracker of this.trackers.values()) {
      if (tracker.alive) count++;
    }
    return count;
  }
}
