/**
 * The whole database. One club per server (club.md §1), so `club` is a
 * single row; everything else hangs off it.
 *
 * Nothing is ever hard-deleted while something else points at it: a removed
 * member keeps their row (`revoked_at`) so their results keep a name, and a
 * deleted challenge keeps its rows (`deleted_at`) so a stale client that
 * asks for it gets a clean 404 rather than a broken join.
 *
 * Tokens are stored as SHA-256 hashes with the server secret as pepper —
 * except the member invite token, which the owner has to be able to read
 * back and hand out again (club.md §5-1), so it is stored as issued.
 */
export const SCHEMA_VERSION = 3;

/*
 * v2 (the Public deployment, club.md §5-4): `challenges.daily` tags a board as
 * a day's challenge, `challenges.result_count` and the `records` table keep
 * what a list read would otherwise count and derive on every request.
 * `migrate()` (src/db/driver.ts) upgrades a v1 database in place.
 *
 * v3 (rankings, club.md §16): `ranking_entries` — one row per member per
 * game × mode, their personal best — replaces the v2 `records` table, which
 * was a cache of challenge results and is dropped; records are now the
 * rankings' leaders. `ranking_entries.seq` is a counter bumped on every write
 * (meta `ranking_seq`) — arrival order, which breaks ties between equal values.
 * `ranking_tables` is one summary row per table (entry count and leader),
 * kept by `offerRanking`, so a list read costs the number of tables, not of
 * entries (docs/cloudflare.md §4).
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS club (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  referral_url TEXT,
  last_activity_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  token TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS setup_keys_used (
  hash TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  board_digest TEXT NOT NULL,
  title TEXT,
  daily TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  result_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS challenges_board ON challenges (game_id, seed, board_digest);

CREATE TABLE IF NOT EXISTS results (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  nickname TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'played')),
  facts_json TEXT NOT NULL,
  UNIQUE (challenge_id, member_id)
);

CREATE TABLE IF NOT EXISTS ranking_entries (
  game_id TEXT NOT NULL,
  params_key TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  nickname TEXT NOT NULL,
  value REAL NOT NULL,
  facts_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  board_digest TEXT,
  submitted_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (game_id, params_key, member_id)
);

CREATE TABLE IF NOT EXISTS ranking_tables (
  game_id TEXT NOT NULL,
  params_key TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  leader_member_id TEXT NOT NULL,
  PRIMARY KEY (game_id, params_key)
);
`;

/**
 * Run by `migrate()` after the tables exist and any upgrade has run, so it
 * never meets a `ranking_entries` that still lacks `seq`.
 */
export const RANKING_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS ranking_entries_table
  ON ranking_entries (game_id, params_key, value, seq);
`;
