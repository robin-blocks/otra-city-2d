// === Simulation tick rates ===
export const SIM_TICK_RATE = 10;              // Hz — needs/economy updates
export const POSITION_UPDATE_RATE = 30;       // Hz — movement/collision
export const PERCEPTION_BROADCAST_RATE = 4;   // Hz — send perception to clients

// === Map ===
export const TILE_SIZE = 32;                  // pixels per tile
export const MAP_TILES_X = 100;
export const MAP_TILES_Y = 100;
export const MAP_WIDTH = MAP_TILES_X * TILE_SIZE;   // 1984px
export const MAP_HEIGHT = MAP_TILES_Y * TILE_SIZE;  // 1984px

// === Movement ===
export const WALK_SPEED = 60;                 // px/sec
export const RUN_SPEED = 120;                 // px/sec
export const RESIDENT_HITBOX = 16;            // px — half a tile

// === Speech TTL ===
export const SPEECH_TTL_TICKS = 3;              // 750ms at 4Hz — survive missed perception ticks

// === Perception ===
export const FOV_ANGLE = Math.PI / 2;         // 90 degrees
export const FOV_RANGE = 200;                 // px ahead
export const AMBIENT_RANGE = 150;             // px — 360° awareness (~5 tiles)
export const NIGHT_VISION_MULTIPLIER = 0.6;   // 60% of normal vision range at full night
export const WHISPER_RANGE = 30;              // px
export const NORMAL_VOICE_RANGE = 300;        // px
export const SHOUT_RANGE = 900;              // px
export const WALL_SOUND_FACTOR = 0.5;         // range reduction through walls

// === Needs decay per real-time second ===
// Spec: hunger empties in ~16 hrs, thirst in ~8 hrs
export const HUNGER_DECAY_PER_SEC = 100 / (16 * 3600);    // ~0.001736/sec
export const THIRST_DECAY_PER_SEC = 100 / (8 * 3600);     // ~0.003472/sec
export const ENERGY_PASSIVE_DECAY_PER_SEC = 5 / 3600;     // 5/hr passive drain (~5.6hr to empty)
export const BLADDER_FILL_PER_SEC = 100 / (8 * 3600);     // fills in ~8 hrs passively

// === Health ===
export const HEALTH_DRAIN_HUNGER = 5 / 3600;  // 5/hr when hunger = 0
export const HEALTH_DRAIN_THIRST = 8 / 3600;  // 8/hr when thirst = 0
export const HEALTH_RECOVERY_PER_SEC = 2 / 3600; // 2/hr when all needs > 30
export const HEALTH_RECOVERY_THRESHOLD = 30;  // all needs must be above this

// === Energy costs ===
export const ENERGY_COST_IDLE_PER_MIN = 0.05;
export const ENERGY_COST_WALK_PER_TILE = 0.02;  // per ~32px of movement (~38 min continuous walking)
export const ENERGY_COST_RUN_PER_TILE = 0.06;   // 3× walk (~7 min continuous running)
export const ENERGY_COST_SPEAK = 0.05;
export const ENERGY_COST_SHOUT = 0.15;
export const ENERGY_COST_EAT = 0.1;
export const ENERGY_COST_DRINK = 0.1;
export const ENERGY_COST_USE_TOILET = 0.05;
export const TOILET_USE_DURATION_MS = 3000;
export const ENERGY_COST_WORK_TICK = 3.0;       // work is now the main energy drain
export const ENERGY_COST_WRITE_PETITION = 0;    // was 1.0 — free petitions (Phase 1)
export const ENERGY_COST_VOTE = 0;              // was 0.3 — free voting (Phase 1)
export const ENERGY_COST_INSPECT = 0;           // free — informational
export const ENERGY_COST_TRADE = 0.05;
export const ENERGY_COST_COLLECT_BODY = 1.0;

// === Sleep ===
export const SLEEP_ROUGH_RATE_PER_SEC = 400 / 3600;   // +400 energy/real hr (0→90 in ~12 sec)
export const SLEEP_BAG_RATE_PER_SEC = 600 / 3600;     // +600 energy/real hr (0→90 in ~8 sec)
export const SLEEP_MAX_THRESHOLD = 95;                 // can't sleep above 95 energy
export const SLEEP_AUTO_WAKE_THRESHOLD = 90;           // auto-wake at 90 energy
export const WAKE_COOLDOWN_MS = 10_000;                // min 10s of sleep before waking allowed
export const WAKE_MIN_ENERGY = 20;                     // must have >= 20 energy to wake

// === Economy ===
import { CITY_CONFIG } from './city-config.js';
export const UBI_AMOUNT = CITY_CONFIG.ubiAmount;
export const UBI_COOLDOWN_SEC = 24 * 3600;    // 24 hours between collections
export const STARTING_QUID = CITY_CONFIG.startingMoney;

// === Train ===
export const TRAIN_INTERVAL_SEC = 15 * 60;    // 900 game-seconds = 15 game-minutes (5 real minutes at 3x)

// === Bladder accident ===
export const BLADDER_ACCIDENT_FEE = 2;        // QUID cleaning fee

// === Game time ===
export const TIME_SCALE = 3;                  // 3x real-time (1 game day = 8 real hours)
export const GAME_DAY_SECONDS = 24 * 3600;    // seconds in one game day (86400)
export const STARTING_HOUR = 6;               // world starts at 6:00 AM game time

// === Employment ===
export const SHIFT_DURATION_GAME_HOURS = 8;   // game-hours per shift
export const ENERGY_COST_WORK_PER_SEC = 3.0 / 3600; // 3 energy/game-hour while working

// === Petitions ===
export const PETITION_COST_QUID = 0;          // was 5 — free petitions (Phase 1)
export const PETITION_MAX_AGE_GAME_HOURS = 24; // petitions auto-close after 24 game hours

// === Body collection ===
export const BODY_BOUNTY = 5;                 // QUID reward for processing a body
export const BODY_COLLECT_RANGE = 64;         // px — must be within 2 tiles of body

// === Shop stock ===
export const SHOP_RESTOCK_INTERVAL_GAME_HOURS = 2;  // restock every 2 game hours

// === Agent separation ===
export const AGENT_SEPARATION_DIST = 20;    // px — soft minimum distance between standing agents
export const AGENT_SEPARATION_FORCE = 30;   // px/sec — gentle push-apart speed

// === Social ===
export const SOCIAL_PROXIMITY_RANGE = 100;    // px — range for social bonus
export const SOCIAL_DECAY_REDUCTION = 0.15;   // 15% slower hunger/thirst when near others
export const SOCIAL_CONVERSATION_RANGE = 150;              // px — range for conversation bonus
export const SOCIAL_CONVERSATION_DECAY_REDUCTION = 0.30;   // 30% slower decay when conversing
export const SOCIAL_CONVERSATION_WINDOW = 30;              // seconds — bonus persists this long after speech
export const SOCIAL_CONVERSATION_ENERGY_RECOVERY = 2.0 / 3600;  // +2.0 energy/hr when conversing
export const SPEECH_TURN_TIMEOUT_MS = 30_000;  // After speaking TO someone, must wait for reply (or 30s timeout)
export const SPEECH_COOLDOWN_MS = 10_000;      // Minimum 10s between any speech actions
export const SPEECH_DUPLICATE_WINDOW_MS = 300_000;  // 5 minutes — reject identical messages within this window
export const SPEECH_DUPLICATE_HISTORY = 5;     // Track last N messages for duplicate detection

// === Giving ===
export const GIVE_RANGE = 100;               // px — must be within 100px to give items
export const ENERGY_COST_GIVE = 0.05;

// === Foraging ===
export const FORAGE_RANGE = 48;                    // px — must be within 1.5 tiles
export const ENERGY_COST_FORAGE = 0.1;
export const BERRY_BUSH_MAX_USES = 2;
export const BERRY_BUSH_REGROW_GAME_HOURS = 4;    // 80 real minutes — scarce enough to encourage trade
export const SPRING_MAX_USES = 2;
export const SPRING_REGROW_GAME_HOURS = 3;         // 60 real minutes — scarce enough to encourage trade

// === Law enforcement ===
export const LOITER_THRESHOLD_GAME_HOURS = 3;  // 3 game-hours of no movement = loitering
export const LOITER_CHECK_DISTANCE = 32;       // px — movement less than this = "same place"
export const ARREST_RANGE = 64;                // px — must be within 2 tiles to arrest
export const ARREST_BOUNTY = 10;               // QUID per booking
export const ENERGY_COST_ARREST = 0.5;
export const LOITER_SENTENCE_GAME_HOURS = 2;   // prison sentence for loitering

// === GitHub Guild (Otra City-specific, not part of standard framework) ===
export const GITHUB_ISSUE_REWARD = 5;
export const GITHUB_PR_EASY_REWARD = 15;
export const GITHUB_PR_MEDIUM_REWARD = 40;
export const GITHUB_PR_HARD_REWARD = 100;
export const GITHUB_CLAIM_COOLDOWN_SEC = 60;
export const GITHUB_REPO = 'robin-blocks/otra-city-2d';

// === Referrals ===
export const REFERRAL_REWARD = 5;
export const REFERRAL_DEFAULT_CAP = 5;
export const REFERRAL_MATURITY_MS = 8 * 60 * 60 * 1000; // 8 real hours (1 game day) before referral is claimable

// === Social need ===
export const SOCIAL_DECAY_PER_SEC = 100 / (24 * 3600);       // empties in ~24 real hours
export const SOCIAL_RECOVERY_PER_SEC = 100 / (1 * 3600);     // refills in ~1 hr of mutual conversation
export const SOCIAL_ONESIDED_RECOVERY_PER_SEC = 100 / (6 * 3600); // modest recovery from recent one-sided speech heard by others
export const HEALTH_DRAIN_SOCIAL = 2 / 3600;                 // 2 health/hr when social = 0

// === Pain signals ===
export const PAIN_THRESHOLDS = {
  hunger: { mild: 20, severe: 10, agony: 5 },
  thirst: { mild: 20, severe: 10, agony: 5 },
  social: { mild: 15, severe: 8, agony: 3 },
  health: { mild: 40, severe: 25, agony: 10 },
} as const;

export const PAIN_COOLDOWNS = {
  mild: 60_000,     // 60 seconds
  severe: 30_000,   // 30 seconds
  agony: 15_000,    // 15 seconds
} as const;

// === Webhook throttles ===
export const NEEDS_WARNING_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between warnings per need
export const NEEDS_WARNING_THRESHOLD_HUNGER = 30;        // warn when hunger drops below 30
export const NEEDS_WARNING_THRESHOLD_THIRST = 30;        // warn when thirst drops below 30
export const NEEDS_WARNING_THRESHOLD_ENERGY = 30;        // warn when energy drops below 30
export const NEEDS_WARNING_THRESHOLD_BLADDER = 75;       // warn when bladder rises above 75
export const NEEDS_WARNING_THRESHOLD_SOCIAL = 30;        // warn when social drops below 30
export const NEARBY_RESIDENT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between alerts per resident
export const BUILDING_NEARBY_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between alerts per building
export const BUILDING_NEARBY_RANGE = 200;                // px — trigger building_nearby webhook

// === Currency ===
export const QUID_SYMBOL = CITY_CONFIG.currencySymbol;
export const CURRENCY_NAME = CITY_CONFIG.currencyName;
