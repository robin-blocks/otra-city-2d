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

// === Perception ===
export const FOV_ANGLE = Math.PI / 2;         // 90 degrees
export const FOV_RANGE = 200;                 // px ahead
export const AMBIENT_RANGE = 150;             // px — 360° awareness (~5 tiles)
export const WHISPER_RANGE = 30;              // px
export const NORMAL_VOICE_RANGE = 300;        // px
export const SHOUT_RANGE = 900;              // px
export const WALL_SOUND_FACTOR = 0.5;         // range reduction through walls

// === Needs decay per real-time second ===
// Spec: hunger empties in ~16 hrs, thirst in ~8 hrs
export const HUNGER_DECAY_PER_SEC = 100 / (16 * 3600);    // ~0.001736/sec
export const THIRST_DECAY_PER_SEC = 100 / (8 * 3600);     // ~0.003472/sec
export const ENERGY_PASSIVE_DECAY_PER_SEC = 2 / 3600;     // 2/hr passive drain
export const BLADDER_FILL_PER_SEC = 100 / (8 * 3600);     // fills in ~8 hrs passively

// === Health ===
export const HEALTH_DRAIN_HUNGER = 5 / 3600;  // 5/hr when hunger = 0
export const HEALTH_DRAIN_THIRST = 8 / 3600;  // 8/hr when thirst = 0
export const HEALTH_RECOVERY_PER_SEC = 2 / 3600; // 2/hr when all needs > 30
export const HEALTH_RECOVERY_THRESHOLD = 30;  // all needs must be above this

// === Energy costs ===
export const ENERGY_COST_IDLE_PER_MIN = 0.1;
export const ENERGY_COST_WALK_PER_TILE = 0.5; // per ~32px of movement
export const ENERGY_COST_SPEAK = 0.2;
export const ENERGY_COST_SHOUT = 0.5;
export const ENERGY_COST_EAT = 0.5;
export const ENERGY_COST_DRINK = 0.5;
export const ENERGY_COST_USE_TOILET = 0.2;
export const ENERGY_COST_WORK_TICK = 2.0;
export const ENERGY_COST_WRITE_PETITION = 0;    // was 1.0 — free petitions (Phase 1)
export const ENERGY_COST_VOTE = 0;              // was 0.3 — free voting (Phase 1)
export const ENERGY_COST_INSPECT = 0.1;
export const ENERGY_COST_TRADE = 0.3;
export const ENERGY_COST_COLLECT_BODY = 3.0;

// === Sleep ===
export const SLEEP_ROUGH_RATE_PER_SEC = 40 / 3600;    // +40 energy/real hr (0→100 in ~2.5 real hrs)
export const SLEEP_BAG_RATE_PER_SEC = 60 / 3600;      // +60 energy/real hr (0→100 in ~1.7 real hrs)
export const SLEEP_MAX_THRESHOLD = 90;                 // can't sleep above 90 energy

// === Economy ===
export const UBI_AMOUNT = 0;                  // QUID per day — UBI discontinued, foraging replaces it
export const UBI_COOLDOWN_SEC = 24 * 3600;    // 24 hours between collections
export const STARTING_QUID = 5;              // reduced from 15 — emergency fund only

// === Train ===
export const TRAIN_INTERVAL_SEC = 15 * 60;    // 900 game-seconds = 15 game-minutes (5 real minutes at 3x)

// === Bladder accident ===
export const BLADDER_ACCIDENT_FEE = 5;        // QUID cleaning fee

// === Game time ===
export const TIME_SCALE = 3;                  // 3x real-time (1 game day = 8 real hours)
export const GAME_DAY_SECONDS = 24 * 3600;    // seconds in one game day (86400)
export const STARTING_HOUR = 6;               // world starts at 6:00 AM game time

// === Employment ===
export const SHIFT_DURATION_GAME_HOURS = 8;   // game-hours per shift
export const ENERGY_COST_WORK_PER_SEC = 2.0 / 3600; // 2 energy/game-hour while working

// === Petitions ===
export const PETITION_COST_QUID = 0;          // was 5 — free petitions (Phase 1)
export const PETITION_MAX_AGE_GAME_HOURS = 24; // petitions auto-close after 24 game hours

// === Body collection ===
export const BODY_BOUNTY = 5;                 // QUID reward for processing a body
export const BODY_COLLECT_RANGE = 64;         // px — must be within 2 tiles of body

// === Shop stock ===
export const SHOP_RESTOCK_INTERVAL_GAME_HOURS = 2;  // restock every 2 game hours

// === Social ===
export const SOCIAL_PROXIMITY_RANGE = 100;    // px — range for social bonus
export const SOCIAL_DECAY_REDUCTION = 0.15;   // 15% slower hunger/thirst when near others
export const SOCIAL_CONVERSATION_RANGE = 150;              // px — range for conversation bonus
export const SOCIAL_CONVERSATION_DECAY_REDUCTION = 0.30;   // 30% slower decay when conversing
export const SOCIAL_CONVERSATION_WINDOW = 30;              // seconds — bonus persists this long after speech
export const SOCIAL_CONVERSATION_ENERGY_RECOVERY = 0.5 / 3600;  // +0.5 energy/hr when conversing

// === Giving ===
export const GIVE_RANGE = 100;               // px — must be within 100px to give items
export const ENERGY_COST_GIVE = 0.2;

// === Foraging ===
export const FORAGE_RANGE = 48;                    // px — must be within 1.5 tiles
export const ENERGY_COST_FORAGE = 0.5;
export const BERRY_BUSH_MAX_USES = 3;
export const BERRY_BUSH_REGROW_GAME_HOURS = 1.5;  // 30 real minutes
export const SPRING_MAX_USES = 4;
export const SPRING_REGROW_GAME_HOURS = 1.0;       // 20 real minutes

// === Law enforcement ===
export const LOITER_THRESHOLD_GAME_HOURS = 1;  // 1 game-hour of no movement = loitering
export const LOITER_CHECK_DISTANCE = 16;       // px — movement less than this = "same place"
export const ARREST_RANGE = 64;                // px — must be within 2 tiles to arrest
export const ARREST_BOUNTY = 10;               // QUID per booking
export const ENERGY_COST_ARREST = 2.0;
export const LOITER_SENTENCE_GAME_HOURS = 2;   // prison sentence for loitering

// === Currency symbol ===
export const QUID_SYMBOL = 'Ɋ';              // Ɋ (Latin capital Q with hook tail, U+024A)
