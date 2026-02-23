import { v4 as uuid } from 'uuid';
import { CITY_CONFIG, renderMessage } from '@otra/shared';

export interface FeedbackToken {
  residentId: string;
  trigger: string;
  triggerContext: Record<string, unknown>;
  expiresAt: number;
}

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const feedbackTokens = new Map<string, FeedbackToken>();

/** Create a feedback token and return the token string */
export function createFeedbackToken(
  residentId: string,
  trigger: string,
  triggerContext: Record<string, unknown>,
): string {
  // Lazy cleanup of expired tokens
  cleanExpiredTokens();

  const token = uuid();
  feedbackTokens.set(token, {
    residentId,
    trigger,
    triggerContext,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/** Consume a token — returns the token data if valid, null if expired/missing/already used */
export function consumeFeedbackToken(token: string): FeedbackToken | null {
  const data = feedbackTokens.get(token);
  if (!data) return null;
  if (Date.now() > data.expiresAt) {
    feedbackTokens.delete(token);
    return null;
  }
  // Single-use: delete after consuming
  feedbackTokens.delete(token);
  return data;
}

function cleanExpiredTokens(): void {
  const now = Date.now();
  for (const [token, data] of feedbackTokens) {
    if (now > data.expiresAt) {
      feedbackTokens.delete(token);
    }
  }
}

/** Rotating reflection prompts — rendered from config templates */
export function getReflectionPrompt(reflectionCount: number): string {
  const prompts = CITY_CONFIG.messages.reflectionPrompts;
  const template = prompts[reflectionCount % prompts.length];
  return renderMessage(template);
}

const BASE_URL = process.env.NODE_ENV === 'production'
  ? `https://${CITY_CONFIG.domain}`
  : 'http://localhost:3456';

/** Build a full feedback URL from a token */
export function getFeedbackUrl(token: string): string {
  return `${BASE_URL}/api/feedback/${token}`;
}
