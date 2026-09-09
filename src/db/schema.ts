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
export const SCHEMA_VERSION = 1;

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
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

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
`;
