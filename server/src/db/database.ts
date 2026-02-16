import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function initDatabase(dbPath?: string): Database.Database {
  const path = dbPath || process.env.DB_PATH || join(__dirname, '..', '..', 'otra-city.db');
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

  // Seed jobs table with definitions if empty
  const jobCount = (db.prepare('SELECT COUNT(*) as count FROM jobs').get() as { count: number }).count;
  if (jobCount === 0) {
    const seedJobs = db.prepare(`
      INSERT OR IGNORE INTO jobs (id, title, building_id, wage_per_shift, shift_duration_hours, max_positions, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction(() => {
      seedJobs.run('bank-teller',      'Bank Teller',       'bank',             10, 8, 2, 'Process UBI claims and manage deposits at the Otra City Bank.');
      seedJobs.run('shop-clerk',       'Shop Clerk',        'council-supplies', 10, 8, 2, 'Stock shelves and serve customers at Council Supplies.');
      seedJobs.run('toilet-attendant', 'Toilet Attendant',  'council-toilet',    8, 8, 1, 'Maintain the Council Toilet facilities.');
      seedJobs.run('body-collector',   'Body Collector',    'council-mortuary', 12, 8, 2, 'Collect deceased residents and transport them to the mortuary.');
      seedJobs.run('hall-clerk',       'Hall Clerk',        'council-hall',     10, 8, 1, 'Process job applications and petitions at the Council Hall.');
      seedJobs.run('groundskeeper',    'Groundskeeper',     null,                8, 8, 2, 'Maintain the city grounds and public spaces.');
      seedJobs.run('station-master',   'Station Master',    'train-station',    10, 8, 1, 'Manage train arrivals and departures at the station.');
    });
    insertAll();
    console.log('[DB] Seeded 7 job definitions');
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
