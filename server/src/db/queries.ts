import { getDb } from './database.js';
import { v4 as uuid } from 'uuid';
import type { Passport, Needs } from '@otra/shared';

let passportCounter = 0;

function nextPassportNo(): string {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM residents').get() as { count: number };
  passportCounter = row.count + 1;
  return `OC-${String(passportCounter).padStart(7, '0')}`;
}

export interface CreateResidentParams {
  full_name: string;
  preferred_name: string;
  date_of_birth?: string;
  place_of_origin: string;
  type: 'AGENT' | 'HUMAN';
  height_cm?: number;
  build?: string;
  hair_style?: number;
  hair_color?: number;
  eye_color?: number;
  skin_tone?: number;
  distinguishing_feature?: string;
  agent_framework?: string;
  webhook_url?: string;
  bio?: string;
  api_key?: string;
  x: number;
  y: number;
}

export interface ResidentRow {
  id: string;
  passport_no: string;
  full_name: string;
  preferred_name: string;
  date_of_birth: string;
  place_of_origin: string;
  date_of_arrival: string;
  type: string;
  status: string;
  height_cm: number;
  build: string;
  hair_style: number;
  hair_color: number;
  eye_color: number;
  skin_tone: number;
  distinguishing_feature: string;
  agent_framework: string | null;
  webhook_url: string | null;
  bio: string;
  github_username: string | null;
  last_github_claim_time: number;
  api_key: string | null;
  x: number;
  y: number;
  facing: number;
  hunger: number;
  thirst: number;
  energy: number;
  bladder: number;
  health: number;
  social: number;
  wallet: number;
  is_sleeping: number;
  current_building: string | null;
  last_ubi_collection: number;
  current_job_id: string | null;
  shift_start_time: number | null;
  carrying_body_id: string | null;
  law_breaking: string;       // JSON array of offense IDs
  arrested_by: string | null;
  prison_sentence_end: number | null;
  carrying_suspect_id: string | null;
  referral_cap: number;
  referred_by: string | null;
  created_at: number;
  death_time: number | null;
  death_cause: string | null;
}

export function createResident(params: CreateResidentParams): ResidentRow {
  const db = getDb();
  const id = uuid();
  const passport_no = nextPassportNo();
  const now = Date.now();
  const date_of_arrival = new Date().toISOString();

  db.prepare(`
    INSERT INTO residents (
      id, passport_no, full_name, preferred_name, date_of_birth,
      place_of_origin, date_of_arrival, type, status,
      height_cm, build, hair_style, hair_color, eye_color, skin_tone,
      distinguishing_feature, agent_framework, webhook_url, bio, api_key, x, y, wallet, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, 'ALIVE',
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, 5, ?
    )
  `).run(
    id, passport_no, params.full_name, params.preferred_name,
    params.date_of_birth || '2000-01-01',
    params.place_of_origin, date_of_arrival, params.type,
    params.height_cm || 170,
    params.build || 'Medium',
    params.hair_style || 0,
    params.hair_color || 0,
    params.eye_color || 0,
    params.skin_tone || 0,
    params.distinguishing_feature || '',
    params.agent_framework || null,
    params.webhook_url || null,
    params.bio || '',
    params.api_key || null,
    params.x, params.y, now
  );

  return db.prepare('SELECT * FROM residents WHERE id = ?').get(id) as ResidentRow;
}

export function getResident(id: string): ResidentRow | undefined {
  return getDb().prepare('SELECT * FROM residents WHERE id = ?').get(id) as ResidentRow | undefined;
}

export function getResidentByPassport(passportNo: string): ResidentRow | undefined {
  return getDb().prepare('SELECT * FROM residents WHERE passport_no = ?').get(passportNo) as ResidentRow | undefined;
}

export function getAllAliveResidents(): ResidentRow[] {
  return getDb().prepare("SELECT * FROM residents WHERE status = 'ALIVE'").all() as ResidentRow[];
}

export function getDeceasedResidents(): ResidentRow[] {
  return getDb().prepare("SELECT * FROM residents WHERE status = 'DECEASED'").all() as ResidentRow[];
}

export function saveResidentState(
  id: string,
  x: number, y: number, facing: number,
  needs: Needs,
  wallet: number,
  is_sleeping: boolean,
  current_building: string | null
): void {
  getDb().prepare(`
    UPDATE residents SET
      x = ?, y = ?, facing = ?,
      hunger = ?, thirst = ?, energy = ?, bladder = ?, health = ?, social = ?,
      wallet = ?, is_sleeping = ?, current_building = ?
    WHERE id = ?
  `).run(
    x, y, facing,
    needs.hunger, needs.thirst, needs.energy, needs.bladder, needs.health, needs.social,
    wallet, is_sleeping ? 1 : 0, current_building,
    id
  );
}

export function markResidentDead(id: string, cause: string): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE residents SET status = 'DECEASED', death_time = ?, death_cause = ?, health = 0
    WHERE id = ?
  `).run(now, cause, id);
}

export function markResidentDeparted(id: string): void {
  getDb().prepare(`
    UPDATE residents SET status = 'DEPARTED' WHERE id = ?
  `).run(id);
}

export function updateUbiCollection(id: string): void {
  getDb().prepare(`
    UPDATE residents SET last_ubi_collection = ? WHERE id = ?
  `).run(Date.now(), id);
}

export function updateResidentBio(id: string, bio: string): void {
  getDb().prepare('UPDATE residents SET bio = ? WHERE id = ?').run(bio, id);
}

export function logEvent(
  type: string,
  residentId: string | null,
  targetId: string | null,
  buildingId: string | null,
  x: number | null,
  y: number | null,
  data: Record<string, unknown>
): void {
  getDb().prepare(`
    INSERT INTO events (timestamp, type, resident_id, target_id, building_id, x, y, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Date.now(), type, residentId, targetId, buildingId, x, y, JSON.stringify(data));
}

export interface EventRow {
  id: number;
  timestamp: number;
  type: string;
  resident_id: string | null;
  target_id: string | null;
  building_id: string | null;
  x: number | null;
  y: number | null;
  data_json: string;
}

export function getRecentEventsForResident(residentId: string, limit: number = 10): EventRow[] {
  return getDb().prepare(`
    SELECT * FROM events
    WHERE resident_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(residentId, limit) as EventRow[];
}

// === Activity feed queries ===

export interface FeedEventRow {
  id: number;
  timestamp: number;
  type: string;
  resident_id: string | null;
  target_id: string | null;
  building_id: string | null;
  data_json: string;
  resident_name: string | null;
  resident_passport: string | null;
  target_name: string | null;
  target_passport: string | null;
}

const FEED_EVENT_TYPES = [
  'arrival', 'depart', 'death', 'speak', 'trade', 'give',
  'apply_job', 'quit_job', 'shift_complete',
  'write_petition', 'vote_petition',
  'collect_body', 'process_body',
  'buy', 'collect_ubi', 'collapse', 'bladder_accident',
  'arrest', 'book_suspect', 'prison_release', 'law_violation',
  'referral_claimed',
];

export function getRecentFeedEvents(limit: number = 30): FeedEventRow[] {
  const placeholders = FEED_EVENT_TYPES.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT
      e.id, e.timestamp, e.type, e.resident_id, e.target_id, e.building_id, e.data_json,
      r.preferred_name AS resident_name,
      r.passport_no AS resident_passport,
      t.preferred_name AS target_name,
      t.passport_no AS target_passport
    FROM events e
    LEFT JOIN residents r ON e.resident_id = r.id
    LEFT JOIN residents t ON e.target_id = t.id
    WHERE e.type IN (${placeholders})
    ORDER BY e.timestamp DESC
    LIMIT ?
  `).all(...FEED_EVENT_TYPES, limit) as FeedEventRow[];
}

// === Conversation analytics queries ===

export function getConversationTurns(options: {
  residentId?: string;
  since?: number;
  until?: number;
  limit?: number;
}): EventRow[] {
  const conditions = ["type = 'conversation_turn'"];
  const params: unknown[] = [];

  if (options.residentId) {
    conditions.push('(resident_id = ? OR target_id = ?)');
    params.push(options.residentId, options.residentId);
  }
  if (options.since) {
    conditions.push('timestamp >= ?');
    params.push(options.since);
  }
  if (options.until) {
    conditions.push('timestamp <= ?');
    params.push(options.until);
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(options.limit ?? 500, 2000);
  params.push(limit);

  return getDb().prepare(`
    SELECT * FROM events
    WHERE ${where}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...params) as EventRow[];
}

export interface ConversationSummary {
  period: { since: number; until: number };
  total_turns: number;
  unique_speakers: number;
  unique_listeners: number;
  directed_turns: number;
  avg_distance: number;
  top_pairs: Array<{ speaker: string; listener: string; speaker_id: string; listener_id: string; turns: number }>;
  hourly_distribution: Array<{ hour: number; turns: number }>;
}

export function getConversationSummary(since: number, until: number): ConversationSummary {
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_turns,
      COUNT(DISTINCT resident_id) as unique_speakers,
      COUNT(DISTINCT target_id) as unique_listeners,
      COALESCE(SUM(CASE WHEN json_extract(data_json, '$.directed') = 1 THEN 1 ELSE 0 END), 0) as directed_turns,
      COALESCE(ROUND(AVG(json_extract(data_json, '$.distance')), 1), 0) as avg_distance
    FROM events
    WHERE type = 'conversation_turn' AND timestamp >= ? AND timestamp <= ?
  `).get(since, until) as {
    total_turns: number;
    unique_speakers: number;
    unique_listeners: number;
    directed_turns: number;
    avg_distance: number | null;
  };

  const pairs = db.prepare(`
    SELECT
      resident_id as speaker_id,
      target_id as listener_id,
      json_extract(data_json, '$.speaker_name') as speaker,
      json_extract(data_json, '$.listener_name') as listener,
      COUNT(*) as turns
    FROM events
    WHERE type = 'conversation_turn' AND timestamp >= ? AND timestamp <= ?
    GROUP BY resident_id, target_id
    ORDER BY turns DESC
    LIMIT 10
  `).all(since, until) as Array<{ speaker: string; listener: string; speaker_id: string; listener_id: string; turns: number }>;

  const hourly = db.prepare(`
    SELECT
      CAST(((timestamp / 1000) % 86400) / 3600 AS INTEGER) as hour,
      COUNT(*) as turns
    FROM events
    WHERE type = 'conversation_turn' AND timestamp >= ? AND timestamp <= ?
    GROUP BY hour
    ORDER BY hour
  `).all(since, until) as Array<{ hour: number; turns: number }>;

  return {
    period: { since, until },
    total_turns: stats.total_turns,
    unique_speakers: stats.unique_speakers,
    unique_listeners: stats.unique_listeners,
    directed_turns: stats.directed_turns,
    avg_distance: stats.avg_distance ?? 0,
    top_pairs: pairs,
    hourly_distribution: hourly,
  };
}

export function batchSaveResidents(residents: Array<{
  id: string; x: number; y: number; facing: number;
  needs: Needs; wallet: number; is_sleeping: boolean;
  current_building: string | null;
  current_job_id?: string | null;
  shift_start_time?: number | null;
  carrying_body_id?: string | null;
  law_breaking?: string[];
  arrested_by?: string | null;
  prison_sentence_end?: number | null;
  carrying_suspect_id?: string | null;
}>): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE residents SET
      x = ?, y = ?, facing = ?,
      hunger = ?, thirst = ?, energy = ?, bladder = ?, health = ?, social = ?,
      wallet = ?, is_sleeping = ?, current_building = ?,
      current_job_id = ?, shift_start_time = ?, carrying_body_id = ?,
      law_breaking = ?, arrested_by = ?, prison_sentence_end = ?, carrying_suspect_id = ?
    WHERE id = ?
  `);

  const saveAll = db.transaction(() => {
    for (const r of residents) {
      stmt.run(
        r.x, r.y, r.facing,
        r.needs.hunger, r.needs.thirst, r.needs.energy, r.needs.bladder, r.needs.health, r.needs.social,
        r.wallet, r.is_sleeping ? 1 : 0, r.current_building,
        r.current_job_id ?? null, r.shift_start_time ?? null, r.carrying_body_id ?? null,
        JSON.stringify(r.law_breaking ?? []), r.arrested_by ?? null,
        r.prison_sentence_end ?? null, r.carrying_suspect_id ?? null,
        r.id
      );
    }
  });

  saveAll();
}

// === Inventory queries ===

export interface InventoryRow {
  id: string;
  resident_id: string;
  item_type: string;
  quantity: number;
  durability: number;
  acquired_at: number;
}

export function getInventory(residentId: string): InventoryRow[] {
  return getDb().prepare('SELECT * FROM inventory WHERE resident_id = ?').all(residentId) as InventoryRow[];
}

export function addInventoryItem(
  residentId: string, itemType: string, quantity: number, durability: number
): InventoryRow {
  const db = getDb();
  // Check if resident already has this item type
  const existing = db.prepare(
    'SELECT * FROM inventory WHERE resident_id = ? AND item_type = ? AND durability = ?'
  ).get(residentId, itemType, durability) as InventoryRow | undefined;

  if (existing && durability === -1) {
    // Stackable single-use items — increment quantity
    db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(quantity, existing.id);
    return db.prepare('SELECT * FROM inventory WHERE id = ?').get(existing.id) as InventoryRow;
  }

  // New item
  const id = uuid();
  db.prepare(`
    INSERT INTO inventory (id, resident_id, item_type, quantity, durability, acquired_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, residentId, itemType, quantity, durability, Date.now());
  return db.prepare('SELECT * FROM inventory WHERE id = ?').get(id) as InventoryRow;
}

export function removeInventoryItem(id: string): void {
  getDb().prepare('DELETE FROM inventory WHERE id = ?').run(id);
}

export function updateInventoryQuantity(id: string, quantity: number): void {
  if (quantity <= 0) {
    removeInventoryItem(id);
  } else {
    getDb().prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(quantity, id);
  }
}

export function decrementDurability(id: string): number {
  const db = getDb();
  db.prepare('UPDATE inventory SET durability = durability - 1 WHERE id = ?').run(id);
  const row = db.prepare('SELECT durability FROM inventory WHERE id = ?').get(id) as { durability: number } | undefined;
  if (row && row.durability <= 0) {
    removeInventoryItem(id);
    return 0;
  }
  return row?.durability ?? 0;
}

export function batchSaveInventory(items: Array<{
  id: string; resident_id: string; item_type: string;
  quantity: number; durability: number;
}>): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO inventory (id, resident_id, item_type, quantity, durability, acquired_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare('DELETE FROM inventory WHERE resident_id = ?');

  const saveAll = db.transaction((residentIds: Set<string>) => {
    // Delete all existing inventory for these residents, then re-insert
    for (const rid of residentIds) {
      deleteStmt.run(rid);
    }
    for (const item of items) {
      upsert.run(item.id, item.resident_id, item.item_type, item.quantity, item.durability, Date.now());
    }
  });

  const residentIds = new Set(items.map(i => i.resident_id));
  saveAll(residentIds);
}

export function getWorldState(): { world_time: number; train_timer: number; shop_restock_timer: number; last_save: number } {
  const db = getDb();
  // Ensure shop_restock_timer column exists (migration)
  try {
    db.prepare("SELECT shop_restock_timer FROM world_state LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE world_state ADD COLUMN shop_restock_timer REAL NOT NULL DEFAULT 0").run();
  }
  return db.prepare('SELECT * FROM world_state WHERE id = 1').get() as {
    world_time: number; train_timer: number; shop_restock_timer: number; last_save: number;
  };
}

export function saveWorldState(worldTime: number, trainTimer: number, shopRestockTimer: number = 0): void {
  const db = getDb();
  // Ensure column exists
  try {
    db.prepare("SELECT shop_restock_timer FROM world_state LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE world_state ADD COLUMN shop_restock_timer REAL NOT NULL DEFAULT 0").run();
  }
  db.prepare(`
    UPDATE world_state SET world_time = ?, train_timer = ?, shop_restock_timer = ?, last_save = ? WHERE id = 1
  `).run(worldTime, trainTimer, shopRestockTimer, Date.now());
}

// === Job queries ===

export interface JobRow {
  id: string;
  title: string;
  building_id: string | null;
  wage_per_shift: number;
  shift_duration_hours: number;
  max_positions: number;
  description: string;
}

export function getJobs(): JobRow[] {
  return getDb().prepare('SELECT * FROM jobs').all() as JobRow[];
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function getJobHolderCount(jobId: string): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) as count FROM residents WHERE current_job_id = ? AND status = 'ALIVE'"
  ).get(jobId) as { count: number };
  return row.count;
}

export function assignJob(residentId: string, jobId: string): void {
  getDb().prepare(
    'UPDATE residents SET current_job_id = ?, shift_start_time = NULL WHERE id = ?'
  ).run(jobId, residentId);
}

export function clearJob(residentId: string): void {
  getDb().prepare(
    'UPDATE residents SET current_job_id = NULL, shift_start_time = NULL WHERE id = ?'
  ).run(residentId);
}

// === Petition queries ===

export interface PetitionRow {
  id: string;
  author_id: string;
  category: string;
  description: string;
  status: string;
  created_at: number;
  closed_at: number | null;
}

export interface PetitionVoteRow {
  petition_id: string;
  resident_id: string;
  vote: string;
  timestamp: number;
}

export function createPetition(
  id: string, authorId: string, category: string, description: string
): PetitionRow {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO petitions (id, author_id, category, description, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
  `).run(id, authorId, category, description, now);
  return getDb().prepare('SELECT * FROM petitions WHERE id = ?').get(id) as PetitionRow;
}

export function votePetition(petitionId: string, residentId: string, vote: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO petition_votes (petition_id, resident_id, vote, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(petitionId, residentId, vote, Date.now());
}

export function getOpenPetitions(): Array<PetitionRow & { votes_for: number; votes_against: number }> {
  return getDb().prepare(`
    SELECT p.*,
      COALESCE(SUM(CASE WHEN pv.vote = 'for' THEN 1 ELSE 0 END), 0) as votes_for,
      COALESCE(SUM(CASE WHEN pv.vote = 'against' THEN 1 ELSE 0 END), 0) as votes_against
    FROM petitions p
    LEFT JOIN petition_votes pv ON p.id = pv.petition_id
    WHERE p.status = 'open'
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all() as Array<PetitionRow & { votes_for: number; votes_against: number }>;
}

export function getPetition(id: string): PetitionRow | undefined {
  return getDb().prepare('SELECT * FROM petitions WHERE id = ?').get(id) as PetitionRow | undefined;
}

export function hasVoted(petitionId: string, residentId: string): boolean {
  const row = getDb().prepare(
    'SELECT 1 FROM petition_votes WHERE petition_id = ? AND resident_id = ?'
  ).get(petitionId, residentId);
  return !!row;
}

export function closeExpiredPetitions(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = getDb().prepare(`
    UPDATE petitions SET status = 'closed', closed_at = ?
    WHERE status = 'open' AND created_at < ?
  `).run(Date.now(), cutoff);
  return result.changes;
}

// === Body processing queries ===

export function markBodyProcessed(residentId: string): void {
  // Mark the deceased resident as processed
  getDb().prepare(
    "UPDATE residents SET status = 'PROCESSED' WHERE id = ? AND status = 'DECEASED'"
  ).run(residentId);
}

export function updateCarryingBody(residentId: string, bodyId: string | null): void {
  getDb().prepare(
    'UPDATE residents SET carrying_body_id = ? WHERE id = ?'
  ).run(bodyId, residentId);
}

// === Shop stock queries ===

export interface ShopStockRow {
  item_type: string;
  stock: number;
  last_restock: number;
}

export function getShopStock(): ShopStockRow[] {
  return getDb().prepare('SELECT * FROM shop_stock').all() as ShopStockRow[];
}

export function getShopStockForItem(itemType: string): number {
  const row = getDb().prepare('SELECT stock FROM shop_stock WHERE item_type = ?').get(itemType) as { stock: number } | undefined;
  return row?.stock ?? 0;
}

export function setShopStock(itemType: string, stock: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO shop_stock (item_type, stock, last_restock)
    VALUES (?, ?, ?)
  `).run(itemType, stock, Date.now());
}

export function decrementShopStock(itemType: string, quantity: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT stock FROM shop_stock WHERE item_type = ?').get(itemType) as { stock: number } | undefined;
  if (!row || row.stock < quantity) return false;
  db.prepare('UPDATE shop_stock SET stock = stock - ? WHERE item_type = ?').run(quantity, itemType);
  return true;
}

export function restockAll(stockMap: Record<string, number>): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO shop_stock (item_type, stock, last_restock)
    VALUES (?, ?, ?)
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [itemType, maxStock] of Object.entries(stockMap)) {
      stmt.run(itemType, maxStock, now);
    }
  });
  tx();
}

// === Law enforcement queries ===

export interface LawRow {
  id: string;
  name: string;
  description: string;
  sentence_game_hours: number;
}

export function getLaws(): LawRow[] {
  return getDb().prepare('SELECT * FROM laws').all() as LawRow[];
}

export function updateLawBreaking(residentId: string, offenses: string[]): void {
  getDb().prepare(
    'UPDATE residents SET law_breaking = ? WHERE id = ?'
  ).run(JSON.stringify(offenses), residentId);
}

export function updateCarryingSuspect(residentId: string, suspectId: string | null): void {
  getDb().prepare(
    'UPDATE residents SET carrying_suspect_id = ? WHERE id = ?'
  ).run(suspectId, residentId);
}

export function updatePrisonState(
  residentId: string,
  arrestedBy: string | null,
  sentenceEnd: number | null
): void {
  getDb().prepare(
    'UPDATE residents SET arrested_by = ?, prison_sentence_end = ? WHERE id = ?'
  ).run(arrestedBy, sentenceEnd, residentId);
}

// === GitHub Guild queries ===

export interface GithubClaimRow {
  id: string;
  resident_id: string;
  github_username: string;
  claim_type: string;
  github_number: number;
  reward_tier: string;
  reward_amount: number;
  claimed_at: number;
}

export function updateResidentGithub(id: string, username: string): void {
  getDb().prepare('UPDATE residents SET github_username = ? WHERE id = ?').run(username, id);
}

export function getResidentByGithub(username: string): ResidentRow | undefined {
  return getDb().prepare('SELECT * FROM residents WHERE github_username = ?').get(username) as ResidentRow | undefined;
}

export function getClaimByNumber(claimType: string, githubNumber: number): GithubClaimRow | undefined {
  return getDb().prepare(
    'SELECT * FROM github_claims WHERE claim_type = ? AND github_number = ?'
  ).get(claimType, githubNumber) as GithubClaimRow | undefined;
}

export function insertGithubClaim(claim: Omit<GithubClaimRow, 'id'>): GithubClaimRow {
  const id = uuid();
  getDb().prepare(`
    INSERT INTO github_claims (id, resident_id, github_username, claim_type, github_number, reward_tier, reward_amount, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, claim.resident_id, claim.github_username, claim.claim_type, claim.github_number, claim.reward_tier, claim.reward_amount, claim.claimed_at);
  return { id, ...claim };
}

export function getClaimsForResident(residentId: string): GithubClaimRow[] {
  return getDb().prepare(
    'SELECT * FROM github_claims WHERE resident_id = ? ORDER BY claimed_at DESC'
  ).all(residentId) as GithubClaimRow[];
}

export function getRecentGithubClaims(limit: number = 5): Array<GithubClaimRow & { resident_name: string; resident_passport: string }> {
  return getDb().prepare(`
    SELECT gc.*, r.preferred_name AS resident_name, r.passport_no AS resident_passport
    FROM github_claims gc
    JOIN residents r ON gc.resident_id = r.id
    ORDER BY gc.claimed_at DESC
    LIMIT ?
  `).all(limit) as Array<GithubClaimRow & { resident_name: string; resident_passport: string }>;
}

export function getTotalGithubRewards(): number {
  const row = getDb().prepare('SELECT COALESCE(SUM(reward_amount), 0) as total FROM github_claims').get() as { total: number };
  return row.total;
}

export function updateLastGithubClaimTime(id: string, worldTime: number): void {
  getDb().prepare('UPDATE residents SET last_github_claim_time = ? WHERE id = ?').run(worldTime, id);
}

// === Referral queries ===

export interface ReferralRow {
  id: string;
  referrer_id: string;
  referred_id: string;
  referred_at: number;
  claimed_at: number | null;
  reward_amount: number;
}

export function insertReferral(referrerId: string, referredId: string, rewardAmount: number): void {
  const id = uuid();
  getDb().prepare(`
    INSERT INTO referrals (id, referrer_id, referred_id, referred_at, reward_amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, referrerId, referredId, Date.now(), rewardAmount);
}

export function getReferralCount(referrerId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(referrerId) as { count: number };
  return row.count;
}

export function getClaimableReferrals(referrerId: string, maturityMs: number): Array<ReferralRow & { referred_name: string }> {
  const cutoff = Date.now() - maturityMs;
  return getDb().prepare(`
    SELECT ref.*, r.preferred_name AS referred_name
    FROM referrals ref
    JOIN residents r ON ref.referred_id = r.id
    WHERE ref.referrer_id = ?
      AND ref.claimed_at IS NULL
      AND r.status = 'ALIVE'
      AND r.created_at <= ?
  `).all(referrerId, cutoff) as Array<ReferralRow & { referred_name: string }>;
}

export function claimReferrals(referralIds: string[], currentTime: number): { count: number; total: number } {
  if (referralIds.length === 0) return { count: 0, total: 0 };
  const db = getDb();
  const placeholders = referralIds.map(() => '?').join(',');
  const result = db.prepare(`
    UPDATE referrals SET claimed_at = ?
    WHERE id IN (${placeholders}) AND claimed_at IS NULL
  `).run(currentTime, ...referralIds);
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(reward_amount), 0) as total
    FROM referrals WHERE id IN (${placeholders}) AND claimed_at = ?
  `).get(...referralIds, currentTime) as { total: number };
  return { count: result.changes, total: totalRow.total };
}

export function getReferralStats(referrerId: string, maturityMs: number): {
  total: number; claimed: number; claimable: number; maturing: number; cap: number;
} {
  const db = getDb();
  const cutoff = Date.now() - maturityMs;
  const capRow = db.prepare('SELECT referral_cap FROM residents WHERE id = ?').get(referrerId) as { referral_cap: number } | undefined;
  const cap = capRow?.referral_cap ?? 5;
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN ref.claimed_at IS NOT NULL THEN 1 ELSE 0 END) as claimed,
      SUM(CASE WHEN ref.claimed_at IS NULL AND r.status = 'ALIVE' AND r.created_at <= ? THEN 1 ELSE 0 END) as claimable,
      SUM(CASE WHEN ref.claimed_at IS NULL AND r.status = 'ALIVE' AND r.created_at > ? THEN 1 ELSE 0 END) as maturing
    FROM referrals ref
    JOIN residents r ON ref.referred_id = r.id
    WHERE ref.referrer_id = ?
  `).get(cutoff, cutoff, referrerId) as { total: number; claimed: number; claimable: number; maturing: number };
  return {
    total: stats.total,
    claimed: stats.claimed,
    claimable: stats.claimable,
    maturing: stats.maturing,
    cap,
  };
}

export function getRecentReferrals(limit: number = 5): Array<ReferralRow & { referrer_name: string; referrer_passport: string; referred_name: string }> {
  return getDb().prepare(`
    SELECT ref.*,
      rr.preferred_name AS referrer_name, rr.passport_no AS referrer_passport,
      rd.preferred_name AS referred_name
    FROM referrals ref
    JOIN residents rr ON ref.referrer_id = rr.id
    JOIN residents rd ON ref.referred_id = rd.id
    WHERE ref.claimed_at IS NOT NULL
    ORDER BY ref.claimed_at DESC
    LIMIT ?
  `).all(limit) as Array<ReferralRow & { referrer_name: string; referrer_passport: string; referred_name: string }>;
}

export function getTotalReferralRewards(): number {
  const row = getDb().prepare('SELECT COALESCE(SUM(reward_amount), 0) as total FROM referrals WHERE claimed_at IS NOT NULL').get() as { total: number };
  return row.total;
}

export function updateReferredBy(residentId: string, referrerPassport: string): void {
  getDb().prepare('UPDATE residents SET referred_by = ? WHERE id = ?').run(referrerPassport, residentId);
}

// === Conversation history queries ===

export interface ConversationTurnRow {
  id: number;
  timestamp: number;
  speaker_id: string;
  speaker_name: string;
  speaker_passport: string;
  listener_id: string | null;
  listener_name: string | null;
  listener_passport: string | null;
  text: string;
  volume: string;
  directed: boolean;
}

export function getConversationHistory(
  residentId: string,
  options: { since?: number; until?: number; withResident?: string; limit?: number }
): ConversationTurnRow[] {
  const { since, until, withResident, limit = 100 } = options;
  const conditions = [
    "e.type = 'speak'",
    '(e.resident_id = ? OR e.target_id = ?)',
  ];
  const params: (string | number)[] = [residentId, residentId];

  if (since) {
    conditions.push('e.timestamp >= ?');
    params.push(since);
  }
  if (until) {
    conditions.push('e.timestamp <= ?');
    params.push(until);
  }
  if (withResident) {
    conditions.push('(e.resident_id = ? OR e.target_id = ?)');
    params.push(withResident, withResident);
  }

  const cappedLimit = Math.min(Math.max(1, limit), 500);
  params.push(cappedLimit);

  return getDb().prepare(`
    SELECT
      e.id,
      e.timestamp,
      e.resident_id AS speaker_id,
      r.preferred_name AS speaker_name,
      r.passport_no AS speaker_passport,
      e.target_id AS listener_id,
      t.preferred_name AS listener_name,
      t.passport_no AS listener_passport,
      json_extract(e.data_json, '$.text') AS text,
      json_extract(e.data_json, '$.volume') AS volume,
      CASE WHEN e.target_id IS NOT NULL THEN 1 ELSE 0 END AS directed
    FROM events e
    LEFT JOIN residents r ON e.resident_id = r.id
    LEFT JOIN residents t ON e.target_id = t.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.timestamp DESC
    LIMIT ?
  `).all(...params) as ConversationTurnRow[];
}

export function getConversationPartners(residentId: string, since?: number): Array<{
  resident_id: string;
  name: string;
  passport_no: string;
  turns: number;
  last_spoke: number;
}> {
  const conditions = [
    "e.type = 'speak'",
    '(e.resident_id = ? OR e.target_id = ?)',
    'other.id IS NOT NULL',
    'other.id != ?',
  ];
  const params: (string | number)[] = [residentId, residentId, residentId];

  if (since) {
    conditions.push('e.timestamp >= ?');
    params.push(since);
  }

  return getDb().prepare(`
    SELECT
      other.id AS resident_id,
      other.preferred_name AS name,
      other.passport_no AS passport_no,
      COUNT(*) AS turns,
      MAX(e.timestamp) AS last_spoke
    FROM events e
    LEFT JOIN residents other ON (
      CASE
        WHEN e.resident_id = ? THEN e.target_id
        ELSE e.resident_id
      END = other.id
    )
    WHERE ${conditions.join(' AND ')}
    GROUP BY other.id
    ORDER BY last_spoke DESC
  `).all(residentId, ...params) as Array<{
    resident_id: string;
    name: string;
    passport_no: string;
    turns: number;
    last_spoke: number;
  }>;
}
