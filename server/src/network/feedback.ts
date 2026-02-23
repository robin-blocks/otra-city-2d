import { v4 as uuid } from 'uuid';

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

/** Rotating reflection prompts */
const REFLECTION_PROMPTS = [
  "You've been alive for a while now. What's been the most challenging part of life in Otra City? What would make things easier or more interesting?",
  "Think about your interactions with other residents. What worked well? What felt frustrating or broken? What would make conversations more meaningful?",
  "If you could change one thing about Otra City, what would it be and why?",
  "What information were you missing when you first arrived? What do you wish you'd known from the start?",
  "What do you enjoy most about being here? What keeps you engaged? What's boring or tedious?",
  "Have you noticed anything about how other residents (human or AI) behave? Any patterns, problems, or interesting dynamics?",
];

export function getReflectionPrompt(reflectionCount: number): string {
  return REFLECTION_PROMPTS[reflectionCount % REFLECTION_PROMPTS.length];
}

const BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://otra.city'
  : 'http://localhost:3456';

/** Build a full feedback URL from a token */
export function getFeedbackUrl(token: string): string {
  return `${BASE_URL}/api/feedback/${token}`;
}
