import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CITY_CONFIG } from '@otra/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function initDatabase(dbPath?: string): Database.Database {
  const path = dbPath || process.env.DB_PATH || join(__dirname, '..', '..', CITY_CONFIG.dbFilename);
  db = new Database(path);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Migrations — add columns that may not exist in older DBs
  const cols = db.prepare("PRAGMA table_info(residents)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('agent_framework')) {
    db.exec("ALTER TABLE residents ADD COLUMN agent_framework TEXT");
  }
  if (!colNames.has('webhook_url')) {
    db.exec("ALTER TABLE residents ADD COLUMN webhook_url TEXT");
  }
  if (!colNames.has('current_job_id')) {
    db.exec("ALTER TABLE residents ADD COLUMN current_job_id TEXT");
  }
  if (!colNames.has('shift_start_time')) {
    db.exec("ALTER TABLE residents ADD COLUMN shift_start_time INTEGER");
  }
  if (!colNames.has('carrying_body_id')) {
    db.exec("ALTER TABLE residents ADD COLUMN carrying_body_id TEXT");
  }
  // Law enforcement columns
  if (!colNames.has('law_breaking')) {
    db.exec("ALTER TABLE residents ADD COLUMN law_breaking TEXT DEFAULT '[]'");
  }
  if (!colNames.has('arrested_by')) {
    db.exec("ALTER TABLE residents ADD COLUMN arrested_by TEXT");
  }
  if (!colNames.has('prison_sentence_end')) {
    db.exec("ALTER TABLE residents ADD COLUMN prison_sentence_end REAL");
  }
  if (!colNames.has('carrying_suspect_id')) {
    db.exec("ALTER TABLE residents ADD COLUMN carrying_suspect_id TEXT");
  }
  if (!colNames.has('bio')) {
    db.exec("ALTER TABLE residents ADD COLUMN bio TEXT DEFAULT ''");
  }
  // GitHub Guild columns
  if (!colNames.has('github_username')) {
    db.exec("ALTER TABLE residents ADD COLUMN github_username TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_residents_github ON residents(github_username) WHERE github_username IS NOT NULL");
  }
  if (!colNames.has('last_github_claim_time')) {
    db.exec("ALTER TABLE residents ADD COLUMN last_github_claim_time REAL DEFAULT 0");
  }
  // Referral columns
  if (!colNames.has('referral_cap')) {
    db.exec("ALTER TABLE residents ADD COLUMN referral_cap INTEGER DEFAULT 5");
  }
  if (!colNames.has('referred_by')) {
    db.exec("ALTER TABLE residents ADD COLUMN referred_by TEXT");
  }
  // Social need
  if (!colNames.has('social')) {
    db.exec("ALTER TABLE residents ADD COLUMN social REAL NOT NULL DEFAULT 100");
  }

  // Seed jobs table from config if empty
  const jobCount = (db.prepare('SELECT COUNT(*) as count FROM jobs').get() as { count: number }).count;
  if (jobCount === 0) {
    const seedJobs = db.prepare(`
      INSERT OR IGNORE INTO jobs (id, title, building_id, wage_per_shift, shift_duration_hours, max_positions, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction(() => {
      for (const job of CITY_CONFIG.jobs) {
        seedJobs.run(job.id, job.title, job.buildingId, job.wagePerShift, job.shiftDurationHours, job.maxPositions, job.description);
      }
    });
    insertAll();
    console.log(`[DB] Seeded ${CITY_CONFIG.jobs.length} job definitions`);
  } else {
    // Ensure all configured jobs exist in older DBs
    const upsertJob = db.prepare(`
      INSERT OR IGNORE INTO jobs (id, title, building_id, wage_per_shift, shift_duration_hours, max_positions, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const job of CITY_CONFIG.jobs) {
      upsertJob.run(job.id, job.title, job.buildingId, job.wagePerShift, job.shiftDurationHours, job.maxPositions, job.description);
    }
  }

  // Seed laws table from config
  const lawCount = (db.prepare('SELECT COUNT(*) as count FROM laws').get() as { count: number }).count;
  if (lawCount === 0) {
    const seedLaw = db.prepare('INSERT INTO laws (id, name, description, sentence_game_hours) VALUES (?, ?, ?, ?)');
    for (const law of CITY_CONFIG.laws) {
      seedLaw.run(law.id, law.name, law.description, law.sentenceGameHours);
    }
    console.log(`[DB] Seeded ${CITY_CONFIG.laws.length} law definitions`);
  }

  console.log(`[DB] Initialized at ${path}`);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    console.log('[DB] Closed');
  }
}
