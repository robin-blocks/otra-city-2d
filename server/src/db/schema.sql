-- Otra City v1 Database Schema

CREATE TABLE IF NOT EXISTS residents (
    id TEXT PRIMARY KEY,
    passport_no TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    preferred_name TEXT NOT NULL,
    date_of_birth TEXT,
    place_of_origin TEXT NOT NULL,
    date_of_arrival TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'HUMAN',
    status TEXT NOT NULL DEFAULT 'ALIVE',
    height_cm INTEGER NOT NULL DEFAULT 170,
    build TEXT NOT NULL DEFAULT 'Medium',
    hair_style INTEGER NOT NULL DEFAULT 0,
    hair_color INTEGER NOT NULL DEFAULT 0,
    eye_color INTEGER NOT NULL DEFAULT 0,
    skin_tone INTEGER NOT NULL DEFAULT 0,
    distinguishing_feature TEXT DEFAULT '',
    agent_framework TEXT,
    webhook_url TEXT,
    -- Auth
    api_key TEXT UNIQUE,
    -- Live state
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    facing REAL NOT NULL DEFAULT 180,
    hunger REAL NOT NULL DEFAULT 100,
    thirst REAL NOT NULL DEFAULT 100,
    energy REAL NOT NULL DEFAULT 100,
    bladder REAL NOT NULL DEFAULT 20,
    health REAL NOT NULL DEFAULT 100,
    wallet INTEGER NOT NULL DEFAULT 15,
    is_sleeping INTEGER NOT NULL DEFAULT 0,
    current_building TEXT,
    last_ubi_collection INTEGER DEFAULT 0,
    -- Timestamps
    created_at INTEGER NOT NULL,
    death_time INTEGER,
    death_cause TEXT
);

CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    item_type TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    durability INTEGER NOT NULL DEFAULT -1,
    acquired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_resident ON inventory(resident_id);

CREATE TABLE IF NOT EXISTS buildings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    width_tiles INTEGER NOT NULL,
    height_tiles INTEGER NOT NULL,
    data_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    resident_id TEXT,
    target_id TEXT,
    building_id TEXT,
    x REAL,
    y REAL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_resident ON events(resident_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

CREATE TABLE IF NOT EXISTS world_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    world_time REAL NOT NULL DEFAULT 0,
    train_timer REAL NOT NULL DEFAULT 0,
    last_save INTEGER NOT NULL DEFAULT 0
);

-- Insert default world state if not exists
INSERT OR IGNORE INTO world_state (id, world_time, train_timer, last_save)
VALUES (1, 0, 0, 0);

-- === Phase 4: Employment & Civic ===

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    building_id TEXT,
    wage_per_shift INTEGER NOT NULL,
    shift_duration_hours INTEGER NOT NULL DEFAULT 8,
    max_positions INTEGER NOT NULL DEFAULT 1,
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS petitions (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES residents(id),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS petition_votes (
    petition_id TEXT NOT NULL REFERENCES petitions(id),
    resident_id TEXT NOT NULL REFERENCES residents(id),
    vote TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (petition_id, resident_id)
);
