import type { ServerMessage, ClientMessage, PerceptionUpdate, ResidentState, InspectData } from '@otra/shared';

type MessageHandler = (msg: ServerMessage) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private token: string = '';
  private spectateId: string = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  connected = false;

  onPerception: ((data: PerceptionUpdate) => void) | null = null;
  onWelcome: ((resident: ResidentState, mapUrl: string, worldTime: number) => void) | null = null;
  onError: ((code: string, message: string) => void) | null = null;
  onActionResult: ((requestId: string, status: string, reason?: string) => void) | null = null;
  onInspectResult: ((data: InspectData) => void) | null = null;
  onPain: ((message: string, source: string, intensity: string) => void) | null = null;

  connect(token: string): void {
    this.token = token;
    this.spectateId = '';
    this.doConnect();
  }

  connectSpectator(residentId: string): void {
    this.spectateId = residentId;
    this.token = '';
    this.doConnect();
  }

  private doConnect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = this.spectateId
      ? `${protocol}//${window.location.host}/ws?spectate=${encodeURIComponent(this.spectateId)}`
      : `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.connected = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.dispatch(msg);
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected: ${event.code} ${event.reason}`);
      this.connected = false;
      this.ws = null;

      // Reconnect after 3 seconds (unless intentionally closed)
      if (event.code !== 4003 && event.code !== 1000) {
        this.reconnectTimer = setTimeout(() => this.doConnect(), 3000);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'perception':
        this.onPerception?.(msg.data);
        break;
      case 'welcome':
        this.onWelcome?.(msg.resident, msg.map_url, msg.world_time);
        break;
      case 'error':
        console.warn(`[WS] Server error: ${msg.code} - ${msg.message}`);
        this.onError?.(msg.code, msg.message);
        break;
      case 'action_result':
        this.onActionResult?.(msg.request_id, msg.status, msg.reason);
        break;
      case 'inspect_result':
        this.onInspectResult?.(msg.data);
        break;
      case 'pain':
        this.onPain?.(msg.message, msg.source, msg.intensity);
        break;
    }
    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close(1000, 'Client disconnect');
  }
}
