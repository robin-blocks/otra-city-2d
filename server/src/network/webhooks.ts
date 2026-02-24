import type { WebSocket } from 'ws';
import type { ResidentEntity } from '../simulation/world.js';

export interface WebhookEvent {
  event: string;
  resident_id: string;
  passport_no: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/** Fire-and-forget webhook POST. Logs errors but never throws. */
async function postWebhook(url: string, event: WebhookEvent): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });

    clearTimeout(timeout);
  } catch (err) {
    // Silently ignore webhook failures — fire and forget
    console.warn(`[Webhook] Failed to POST to ${url}: ${(err as Error).message}`);
  }
}

/** Send event over WebSocket if connected. Fire-and-forget. */
function sendWsEvent(ws: WebSocket, event: string, payload: WebhookEvent): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'event', event_type: event, data: payload }));
    }
  } catch {
    // Silently ignore — fire and forget
  }
}

/** Send an event to a resident over WebSocket and/or HTTP webhook */
export function sendWebhook(
  resident: ResidentEntity,
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (!resident.webhookUrl && !resident.ws) return;

  const payload: WebhookEvent = {
    event,
    resident_id: resident.id,
    passport_no: resident.passportNo,
    timestamp: Date.now(),
    data,
  };

  // WebSocket delivery (primary channel)
  if (resident.ws) {
    sendWsEvent(resident.ws, event, payload);
  }

  // HTTP webhook delivery (optional secondary channel)
  if (resident.webhookUrl) {
    postWebhook(resident.webhookUrl, payload).catch(() => {});
  }
}
