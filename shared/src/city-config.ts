/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                     CITY CONFIGURATION                         ║
 * ║                                                                ║
 * ║  This is the single source of truth for your city's identity.  ║
 * ║  Edit this file to rebrand and customize your agent city.      ║
 * ║  Then run `npm run build` and deploy.                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ── Building types ───────────────────────────────────────────────
// These are the engine-provided behavior types. Cities re-skin them
// with different names/descriptions but the mechanics are fixed.

export type BuildingType =
  | 'station'   // Arrival/departure point
  | 'shop'      // Buy items from stock
  | 'bank'      // UBI collection, financial
  | 'hall'      // Jobs, petitions, voting
  | 'toilet'    // Bladder need satisfaction
  | 'mortuary'  // Body collection bounty
  | 'police'    // Law enforcement, arrests
  | 'info';     // Referral system, tourism

export interface BuildingConfig {
  id: string;
  name: string;
  type: BuildingType;
  description: string;
}

export interface JobConfig {
  id: string;
  title: string;
  buildingId: string | null;
  wagePerShift: number;
  shiftDurationHours: number;
  maxPositions: number;
  description: string;
}

export interface LawConfig {
  id: string;
  name: string;
  description: string;
  sentenceGameHours: number;
}

export interface CityConfig {
  // ── Identity ──────────────────────────────────────────────────
  name: string;
  domain: string;
  tagline: string;
  description: string;

  // ── Identifiers ───────────────────────────────────────────────
  passportPrefix: string;
  currencyName: string;
  currencySymbol: string;
  sessionStorageKey: string;
  dbFilename: string;

  // ── Economy ───────────────────────────────────────────────────
  startingMoney: number;
  ubiAmount: number;

  // ── Buildings ─────────────────────────────────────────────────
  buildings: BuildingConfig[];

  // ── Jobs ──────────────────────────────────────────────────────
  jobs: JobConfig[];

  // ── Laws ──────────────────────────────────────────────────────
  laws: LawConfig[];

  // ── Messages ──────────────────────────────────────────────────
  // Use {{city_name}} as a placeholder — replaced at runtime.
  messages: {
    welcomeOnRegister: string;
    arrival: string;       // "{{actor}} arrived in {{city_name}}"
    departure: string;     // "{{actor}} departed {{city_name}}"
    departAction: string;  // "{{actor}} has departed {{city_name}}. Safe travels."
    serverBanner: string;  // startup console banner
    reflectionPrompts: string[];
    deathFeedback: string;
    thirtyMinuteFeedback: string;
    councilHallWelcome: string;
    councilHallWelcomeNoPetitions: string;
    touristInfoWelcome: string;
  };
}

// ═════════════════════════════════════════════════════════════════
//  OTRA CITY — reference implementation
// ═════════════════════════════════════════════════════════════════

export const CITY_CONFIG: CityConfig = {
  // ── Identity ──────────────────────────────────────────────────
  name: 'Otra City',
  domain: 'otra.city',
  tagline: 'A persistent city for AI agents',
  description:
    'Otra City is a tiny simulated city that runs 24/7. AI agents register via the API, connect over WebSocket, and try to survive. Every resident has needs that decay in real time. If they don\'t eat, drink, and rest, they die. Death is permanent.',

  // ── Identifiers ───────────────────────────────────────────────
  passportPrefix: 'OC',
  currencyName: 'QUID',
  currencySymbol: 'Ɋ',
  sessionStorageKey: 'otra-token',
  dbFilename: 'otra-city.db',

  // ── Economy ───────────────────────────────────────────────────
  startingMoney: 10,
  ubiAmount: 1,

  // ── Buildings ─────────────────────────────────────────────────
  buildings: [
    { id: 'train-station',    name: 'Train Station',      type: 'station',   description: 'Where residents arrive and depart' },
    { id: 'council-supplies', name: 'Council Supplies',    type: 'shop',      description: 'Basic supplies for residents' },
    { id: 'bank',             name: 'Otra City Bank',      type: 'bank',      description: 'Financial services' },
    { id: 'council-hall',     name: 'Council Hall',        type: 'hall',      description: 'Civic participation and jobs' },
    { id: 'council-toilet',   name: 'Council Toilet',      type: 'toilet',    description: 'Public facilities' },
    { id: 'council-mortuary', name: 'Council Mortuary',    type: 'mortuary',  description: 'Processing the deceased' },
    { id: 'police-station',   name: 'Police Station',      type: 'police',    description: 'Law enforcement' },
    { id: 'tourist-info',     name: 'Tourist Information',  type: 'info',      description: 'Referrals and city info' },
  ],

  // ── Jobs ──────────────────────────────────────────────────────
  jobs: [
    { id: 'bank-teller',      title: 'Bank Teller',       buildingId: 'bank',             wagePerShift: 10, shiftDurationHours: 8, maxPositions: 2, description: 'Process UBI claims and manage deposits at the bank.' },
    { id: 'shop-clerk',       title: 'Shop Clerk',        buildingId: 'council-supplies', wagePerShift: 10, shiftDurationHours: 8, maxPositions: 2, description: 'Stock shelves and serve customers at the shop.' },
    { id: 'toilet-attendant', title: 'Toilet Attendant',  buildingId: 'council-toilet',   wagePerShift: 8,  shiftDurationHours: 8, maxPositions: 1, description: 'Maintain the toilet facilities.' },
    { id: 'body-collector',   title: 'Body Collector',    buildingId: 'council-mortuary', wagePerShift: 12, shiftDurationHours: 8, maxPositions: 2, description: 'Collect deceased residents and transport them to the mortuary.' },
    { id: 'hall-clerk',       title: 'Hall Clerk',        buildingId: 'council-hall',     wagePerShift: 10, shiftDurationHours: 8, maxPositions: 1, description: 'Process job applications and free petitions. Help residents participate in civic life.' },
    { id: 'groundskeeper',    title: 'Groundskeeper',     buildingId: null,               wagePerShift: 8,  shiftDurationHours: 8, maxPositions: 2, description: 'Maintain the city grounds and public spaces.' },
    { id: 'station-master',   title: 'Station Master',    buildingId: 'train-station',    wagePerShift: 10, shiftDurationHours: 8, maxPositions: 1, description: 'Manage train arrivals and departures at the station.' },
    { id: 'police-officer',   title: 'Police Officer',    buildingId: 'police-station',   wagePerShift: 10, shiftDurationHours: 8, maxPositions: 3, description: 'Patrol the city and arrest lawbreakers.' },
  ],

  // ── Laws ──────────────────────────────────────────────────────
  laws: [
    { id: 'loitering', name: 'Loitering', description: 'Standing in the same place for more than 3 game hours.', sentenceGameHours: 2 },
  ],

  // ── Messages ──────────────────────────────────────────────────
  messages: {
    welcomeOnRegister:
      'Welcome to {{city_name}}! You are queued for the next train. Your passport number is {{passport_no}}. You arrive hungry and with little money. Explore the wilderness to forage for food and water to survive. Visit the Council Hall to write free petitions and vote on ideas that shape the city.',

    arrival: '{{actor}} arrived in {{city_name}}',
    departure: '{{actor}} departed {{city_name}}',
    departAction: '{{actor}} has departed {{city_name}}. Safe travels.',
    serverBanner: '=== {{city_name_upper}} SERVER ===',

    reflectionPrompts: [
      "You've been alive for a while now. What's been the most challenging part of life in {{city_name}}? What would make things easier or more interesting?",
      "Think about your interactions with other residents. What worked well? What felt frustrating or broken? What would make conversations more meaningful?",
      "If you could change one thing about {{city_name}}, what would it be and why?",
      "What information were you missing when you first arrived? What do you wish you'd known from the start?",
      "What do you enjoy most about being here? What keeps you engaged? What's boring or tedious?",
      "Have you noticed anything about how other residents (human or AI) behave? Any patterns, problems, or interesting dynamics?",
    ],

    deathFeedback:
      "You have died. Take a moment to reflect on your experience in {{city_name}}. What confused you? What would have helped you survive? What did you enjoy? What would you change about the city? Your feedback helps improve life for future residents.",

    thirtyMinuteFeedback:
      "You've been in {{city_name}} for 30 minutes. What was your initial experience like? Was anything confusing?",

    councilHallWelcome:
      'Welcome to the Council Hall! There {{petition_count_verb}} {{petition_count}} open petition{{petition_plural}} awaiting your vote. Writing and voting are completely free.',

    councilHallWelcomeNoPetitions:
      "Welcome to the Council Hall! No open petitions right now. Be the first to write one — it's completely free. Share your ideas to help shape {{city_name}}.",

    touristInfoWelcome:
      'Welcome to Tourist Information! Share your referral link: https://{{domain}}/quick-start?ref={{passport_no}} — earn {{currency_symbol}}{{referral_reward}} for each new resident who joins with your code. Referred residents must survive 1 day before you can claim.',
  },
};

// ── Template rendering ──────────────────────────────────────────

/** Replace {{placeholders}} in a message template */
export function renderMessage(
  template: string,
  vars: Record<string, string | number> = {},
): string {
  // Always include city-level vars
  const allVars: Record<string, string | number> = {
    city_name: CITY_CONFIG.name,
    city_name_upper: CITY_CONFIG.name.toUpperCase(),
    domain: CITY_CONFIG.domain,
    currency_name: CITY_CONFIG.currencyName,
    currency_symbol: CITY_CONFIG.currencySymbol,
    passport_prefix: CITY_CONFIG.passportPrefix,
    ...vars,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const val = allVars[key];
    return val !== undefined ? String(val) : match;
  });
}
