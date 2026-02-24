import type { PerceptionUpdate, ResidentState, VisibleResident, AudibleMessage, InventoryItem, Build } from '@otra/shared';

interface ReplayFrame {
  world_time: number;
  self: {
    x: number; y: number; facing: number; status: string;
    hunger: number; thirst: number; energy: number;
    bladder: number; health: number; social: number;
    wallet: number; current_building: string | null;
    is_sleeping: boolean;
    inventory: Array<{ type: string; quantity: number }>;
  };
  residents: Array<{
    id: string; name: string; x: number; y: number;
    facing: number; action: string;
    appearance: { skin_tone: number; hair_style: number; hair_color: number };
    condition: string; framework: string | null; is_dead: boolean;
  }>;
  speech: Array<{
    speaker_id: string; speaker_name: string; text: string; volume: string;
    to_id?: string; to_name?: string;
  }>;
}

interface AgentInfo {
  model_id: string;
  display_name: string;
  passport_no: string;
  resident_id: string;
}

interface BenchEvent {
  timestamp: number;
  world_time: number;
  event_type: string;
  model_id: string;
  passport_no: string;
  data: Record<string, unknown>;
}

const CHUNK_SIZE = 300; // world-seconds per chunk
const PREFETCH_THRESHOLD = 0.8; // prefetch at 80% through current chunk

export class ReplayClient {
  private apiBase: string;
  private runId: string;
  private modelId: string;

  // Callbacks — same shape as WsClient
  onPerception: ((data: PerceptionUpdate) => void) | null = null;
  onWelcome: ((resident: ResidentState, mapUrl: string, worldTime: number) => void) | null = null;

  // Playback state
  playing = true;
  speed = 1;
  currentTime = 0;
  totalDuration = 0;
  private startTime = 0;

  // Data
  private frames: ReplayFrame[] = [];
  private events: BenchEvent[] = [];
  private agentInfo: AgentInfo | null = null;
  private mapObjectUrl = '';
  private lastEmittedFrameIndex = -1;

  // Chunk management
  private loadedChunkStart = 0;
  private loadedChunkEnd = 0;
  private prefetching = false;

  constructor(apiBase: string, runId: string, modelId: string) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.runId = runId;
    this.modelId = modelId;
  }

  async load(): Promise<void> {
    // Fetch agents list, map, events, and first replay chunk in parallel
    const [agentsRes, mapRes, eventsRes, replayRes] = await Promise.all([
      fetch(`${this.apiBase}/api/runs/${this.runId}/agents`),
      fetch(`${this.apiBase}/api/runs/${this.runId}/map`),
      fetch(`${this.apiBase}/api/runs/${this.runId}/agents/${this.modelId}/events`),
      fetch(`${this.apiBase}/api/runs/${this.runId}/agents/${this.modelId}/replay?from=0&to=${CHUNK_SIZE}`),
    ]);

    // Parse agents
    if (agentsRes.ok) {
      const data = await agentsRes.json() as { agents: AgentInfo[] };
      this.agentInfo = data.agents.find(a => a.model_id === this.modelId) ?? null;
    }

    // Parse map → create Object URL
    if (mapRes.ok) {
      const mapBlob = await mapRes.blob();
      this.mapObjectUrl = URL.createObjectURL(mapBlob);
    }

    // Parse events
    if (eventsRes.ok) {
      const data = await eventsRes.json() as { events: BenchEvent[] };
      this.events = data.events;
    }

    // Parse first chunk
    if (replayRes.ok) {
      const data = await replayRes.json() as { frames: ReplayFrame[]; total_world_time: number; start_time: number };
      this.frames = data.frames;
      this.totalDuration = data.total_world_time;
      this.startTime = data.start_time;
      this.loadedChunkStart = 0;
      this.loadedChunkEnd = CHUNK_SIZE;
    }

    if (this.frames.length === 0) {
      console.warn('[ReplayClient] No frames loaded');
      return;
    }

    // Set initial time
    this.currentTime = this.frames[0].world_time;

    // Emit synthetic welcome from first frame
    this.emitSyntheticWelcome();
  }

  private emitSyntheticWelcome(): void {
    if (!this.onWelcome || this.frames.length === 0) return;

    const frame = this.frames[0];
    const info = this.agentInfo;

    const resident: ResidentState = {
      id: info?.resident_id ?? 'replay-self',
      passport: {
        passport_no: info?.passport_no ?? 'OC-REPLAY',
        full_name: info?.display_name ?? this.modelId,
        preferred_name: info?.display_name ?? this.modelId,
        date_of_birth: '2024-01-01',
        place_of_origin: 'Bench',
        date_of_arrival: new Date().toISOString(),
        type: 'AGENT',
        status: 'ALIVE',
        height_cm: 170,
        build: 'Medium' as Build,
        hair_style: 0,
        hair_color: 0,
        eye_color: 0,
        skin_tone: 0,
        distinguishing_feature: '',
      },
      x: frame.self.x,
      y: frame.self.y,
      facing: frame.self.facing,
      needs: {
        hunger: frame.self.hunger,
        thirst: frame.self.thirst,
        energy: frame.self.energy,
        bladder: frame.self.bladder,
        health: frame.self.health,
        social: frame.self.social,
      },
      wallet: frame.self.wallet,
      inventory: frame.self.inventory.map((i, idx) => ({
        id: `replay-inv-${idx}`,
        type: i.type,
        quantity: i.quantity,
      })),
      status: frame.self.status as any,
      is_sleeping: frame.self.is_sleeping,
      is_dead: false,
      current_building: frame.self.current_building,
      employment: null,
    };

    this.onWelcome(resident, this.mapObjectUrl, frame.world_time);
  }

  /** Called every render frame to advance time and emit perception */
  tick(dt: number): void {
    if (!this.playing || this.frames.length === 0) return;

    this.currentTime += dt * this.speed * 10; // 10x real-time = 1x game-time

    // Clamp to end
    const endTime = this.startTime + this.totalDuration;
    if (this.currentTime >= endTime) {
      this.currentTime = endTime;
      this.playing = false;
    }

    // Find frame closest to current time (but not exceeding)
    const frameIndex = this.findFrameIndex(this.currentTime);
    if (frameIndex < 0) return;

    // Only emit when we advance to a new frame
    if (frameIndex !== this.lastEmittedFrameIndex) {
      this.lastEmittedFrameIndex = frameIndex;
      this.emitPerception(this.frames[frameIndex]);
    }

    // Prefetch next chunk if needed
    this.maybePreFetch();
  }

  async seek(worldTime: number): Promise<void> {
    this.currentTime = worldTime;
    this.lastEmittedFrameIndex = -1;

    // Check if we need to fetch a new chunk
    const relativeTime = worldTime - this.startTime;
    if (relativeTime < this.loadedChunkStart || relativeTime > this.loadedChunkEnd) {
      const chunkStart = Math.max(0, relativeTime - 30); // start 30s before
      await this.fetchChunk(chunkStart);
    }

    // Emit the frame at the new position
    const frameIndex = this.findFrameIndex(worldTime);
    if (frameIndex >= 0) {
      this.lastEmittedFrameIndex = frameIndex;
      this.emitPerception(this.frames[frameIndex]);
    }
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  getEvents(): Array<{ world_time: number; type: string }> {
    return this.events.map(e => ({
      world_time: e.world_time,
      type: e.event_type,
    }));
  }

  getMapUrl(): string {
    return this.mapObjectUrl;
  }

  private findFrameIndex(worldTime: number): number {
    // Binary search for the largest frame.world_time <= worldTime
    let lo = 0;
    let hi = this.frames.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].world_time <= worldTime) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result;
  }

  private emitPerception(frame: ReplayFrame): void {
    if (!this.onPerception) return;

    const perception: PerceptionUpdate = {
      tick: 0,
      time: new Date().toISOString(),
      world_time: frame.world_time,
      self: {
        id: this.agentInfo?.resident_id ?? 'replay-self',
        passport_no: this.agentInfo?.passport_no ?? 'OC-REPLAY',
        x: frame.self.x,
        y: frame.self.y,
        facing: frame.self.facing,
        hunger: frame.self.hunger,
        thirst: frame.self.thirst,
        energy: frame.self.energy,
        bladder: frame.self.bladder,
        health: frame.self.health,
        social: frame.self.social,
        wallet: frame.self.wallet,
        inventory: frame.self.inventory.map((i, idx) => ({
          id: `replay-inv-${idx}`,
          type: i.type,
          quantity: i.quantity,
        })),
        status: frame.self.status,
        is_sleeping: frame.self.is_sleeping,
        sleep_started_at: null,
        is_using_toilet: false,
        current_building: frame.self.current_building,
        employment: null,
        law_breaking: [],
        prison_sentence_remaining: null,
        carrying_suspect_id: null,
      },
      visible: frame.residents.map(r => ({
        id: r.id,
        type: 'resident' as const,
        name: r.name,
        x: r.x,
        y: r.y,
        facing: r.facing,
        appearance: {
          skin_tone: r.appearance.skin_tone,
          hair_style: r.appearance.hair_style,
          hair_color: r.appearance.hair_color,
          build: 'Medium' as Build,
        },
        action: r.action,
        is_dead: r.is_dead,
        agent_framework: r.framework ?? undefined,
        condition: r.condition as 'healthy' | 'struggling' | 'critical',
      })),
      audible: frame.speech.map(s => ({
        from: s.speaker_id,
        from_name: s.speaker_name,
        text: s.text,
        volume: s.volume as 'whisper' | 'normal' | 'shout',
        distance: 0,
        ...(s.to_id ? { to: s.to_id } : {}),
        ...(s.to_name ? { to_name: s.to_name } : {}),
      })),
      interactions: [],
      notifications: [],
    };

    this.onPerception(perception);
  }

  private async maybePreFetch(): Promise<void> {
    if (this.prefetching) return;

    const relativeTime = this.currentTime - this.startTime;
    const chunkProgress = (relativeTime - this.loadedChunkStart) / (this.loadedChunkEnd - this.loadedChunkStart);

    if (chunkProgress >= PREFETCH_THRESHOLD && this.loadedChunkEnd < this.totalDuration) {
      this.prefetching = true;
      try {
        await this.fetchChunk(this.loadedChunkEnd);
      } finally {
        this.prefetching = false;
      }
    }
  }

  private async fetchChunk(fromRelative: number): Promise<void> {
    const toRelative = fromRelative + CHUNK_SIZE;
    const res = await fetch(
      `${this.apiBase}/api/runs/${this.runId}/agents/${this.modelId}/replay?from=${fromRelative}&to=${toRelative}`
    );
    if (!res.ok) return;

    const data = await res.json() as { frames: ReplayFrame[]; total_world_time: number; start_time: number };

    // Merge new frames with existing, dedup by world_time
    const existingMap = new Map(this.frames.map(f => [f.world_time, f]));
    for (const f of data.frames) {
      existingMap.set(f.world_time, f);
    }
    this.frames = Array.from(existingMap.values()).sort((a, b) => a.world_time - b.world_time);

    // Update loaded range
    this.loadedChunkStart = Math.min(this.loadedChunkStart, fromRelative);
    this.loadedChunkEnd = Math.max(this.loadedChunkEnd, toRelative);
  }
}
