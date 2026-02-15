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

/** Send a webhook event to a resident if they have a webhook_url configured */
export function sendWebhook(
  resident: ResidentEntity,
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (!resident.webhookUrl) return;

  const payload: WebhookEvent = {
    event,
    resident_id: resident.id,
    passport_no: resident.passportNo,
    timestamp: Date.now(),
    data,
  };

  // Fire and forget — don't await
  postWebhook(resident.webhookUrl, payload).catch(() => {});
}
