import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import { join } from 'path';
import { createGzip, type Gzip } from 'zlib';
import WebSocket from 'ws';
import type { ServerMessage } from '@otra/shared';
import { sanitizeModelId } from './agent-manager.js';

export interface RecorderOptions {
  instanceUrl: string;
  residentId: string;
  modelId: string;
  dataDir: string;
  onMessage?: (modelId: string, msg: ServerMessage) => void;
}

export class AgentRecorder {
  private ws: WebSocket | null = null;
  private perceptionStream: WriteStream | null = null;
  private gzip: Gzip | null = null;
  private eventsStream: WriteStream | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private messageCount = 0;

  constructor(private opts: RecorderOptions) {}

  start(): void {
    const agentDir = join(this.opts.dataDir, 'agents', sanitizeModelId(this.opts.modelId));
    mkdirSync(agentDir, { recursive: true });

    // Perception stream: gzipped JSONL
    this.gzip = createGzip({ level: 6 });
    this.perceptionStream = createWriteStream(join(agentDir, 'perception.jsonl.gz'));
    this.gzip.pipe(this.perceptionStream);

    // Events stream: plain JSONL (small, want instant reads)
    this.eventsStream = createWriteStream(join(agentDir, 'events.jsonl'), { flags: 'a' });

    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    const wsUrl = this.opts.instanceUrl
      .replace(/^http/, 'ws')
      + `/ws?spectate=${this.opts.residentId}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log(`[Recorder] Connected spectator WS for ${this.opts.modelId}`);
    });

    this.ws.on('message', (data) => {
      try {
        const msg: ServerMessage = JSON.parse(data.toString());
        this.messageCount++;

        // Write to perception log (all messages)
        const line = JSON.stringify({ ts: Date.now(), msg }) + '\n';
        this.gzip?.write(line);

        // Forward to event detector
        this.opts.onMessage?.(this.opts.modelId, msg);
      } catch {
        // Skip unparseable messages
      }
    });

    this.ws.on('close', () => {
      if (!this.stopped) {
        console.log(`[Recorder] WS closed for ${this.opts.modelId}, reconnecting in 2s...`);
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[Recorder] WS error for ${this.opts.modelId}:`, err.message);
    });
  }

  writeEvent(event: object): void {
    this.eventsStream?.write(JSON.stringify(event) + '\n');
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.gzip?.end();
    this.eventsStream?.end();
    console.log(`[Recorder] Stopped for ${this.opts.modelId} (${this.messageCount} messages recorded)`);
  }

  getMessageCount(): number {
    return this.messageCount;
  }
}
