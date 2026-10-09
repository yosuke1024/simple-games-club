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
export const SCHEMA_VERSION = 6;

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
 * kept by the store on every write, so a list read costs the number of tables, not of
 * entries (docs/cloudflare.md §4).
 *
 * v4 (the Public deployment's operation, club.md §17): `reports` — one row per
 * (target, reporter), so a member reports another's nickname once, with the
 * running total kept on `members.report_count` (so the owner's list reads a
 * page, not the table) — and an index on `challenges.daily` for the LP's
 * read-only view (§18).
 *
 * v5 (auto-sync, club.md §10): `results.rank_class` / `results.rank_key` keep where a result
 * sorts (src/contracts/games.ts `resultRank`), so a challenge's best-N read and the
 * daily's top three walk an index instead of every result of the day; and an index on
 * `ranking_tables (entry_count DESC, …)` so the landing page's most-played tables are the
 * first eight rows of a read, not a scan of every table.
 *
 * Also v5, same unreleased step (no version of its own): `withdrawn_results` — one row per
 * (challenge, member) who deleted their own result from that challenge. It is what keeps
 * "one result per member per challenge" true after the delete: a later submission by that
 * member is refused (409 `already_submitted`), so deleting a day's result means leaving that
 * day's challenge. `CREATE TABLE IF NOT EXISTS`, so an existing v5 database gains it on start.
 *
 * v6 (one row per result, club.md §16-1, 2026-10-10): `ranking_entries` holds every completed
 * result as its own row — a member appears in a table as often as they finished a game there,
 * up to `rankingRowsPerMember` (src/limits.ts) — keyed by `seq`, the arrival counter the rows
 * already carried (still taken from meta `ranking_seq`, so a deleted row's number is never
 * handed out again; a bare rowid would reuse the largest one). `ranking_tables.entry_count`
 * counts result rows and `leader_seq` names the leading row. `upgradeToV6` (src/db/driver.ts)
 * rebuilds both tables of a v5 database, each member's one best becoming their first row.
 *
 * Also v6, same unreleased step (no version of its own): `ranking_entries.client_id` — the
 * idempotency key the client sends with a result (`clientId`, club.md §16-1; `^[A-Za-z0-9_-]{8,64}$`),
 * NULL for a row copied from v5 or sent without one. A partial unique index
 * `ranking_entries_client ON (member_id, client_id) WHERE client_id IS NOT NULL` is the
 * guarantee that a member's resend (the first answer was lost) cannot become a second row;
 * `Store.addRanking` looks the pair up first and answers with the stored row. The column is
 * in `RANKING_ENTRIES_SQL`, and `migrate()` adds it to a database already at v6 without it
 * (a developer database from before the key — v6 was never deployed) before the index is built.
 */

/**
 * The two ranking tables in their v6 shape, apart so `upgradeToV6` (src/db/driver.ts) can
 * create them again after setting a v5 table aside. One row per result, keyed by `seq`.
 */
export const RANKING_ENTRIES_SQL = `
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
  seq INTEGER PRIMARY KEY,
  client_id TEXT
);
`;

/** One summary row per table: how many result rows it holds, and the leading row. */
export const RANKING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS ranking_tables (
  game_id TEXT NOT NULL,
  params_key TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  leader_seq INTEGER NOT NULL,
  PRIMARY KEY (game_id, params_key)
);
`;

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
  revoked_at TEXT,
  report_count INTEGER NOT NULL DEFAULT 0
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
  rank_class INTEGER NOT NULL DEFAULT 2,
  rank_key REAL,
  UNIQUE (challenge_id, member_id)
);

CREATE TABLE IF NOT EXISTS withdrawn_results (
  challenge_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (challenge_id, member_id)
);

${RANKING_ENTRIES_SQL}
${RANKING_TABLES_SQL}

CREATE TABLE IF NOT EXISTS reports (
  target_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_id, reporter_id)
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

/**
 * The idempotency key of a ranking result (club.md §16-1): one row per (member, `clientId`).
 * Partial, so the rows without a key — v5's and legacy clients' — are not in it and cost nothing.
 * Run by `migrate()` once `ranking_entries.client_id` is certain to exist.
 */
export const RANKING_CLIENT_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS ranking_entries_client
  ON ranking_entries (member_id, client_id) WHERE client_id IS NOT NULL;
`;

/** Run by `migrate()` once `challenges.daily` is certain to exist (after upgradeToV2). */
export const DAILY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS challenges_daily ON challenges (daily);
`;

/** Run by `migrate()` once `members.report_count` is certain to exist (after upgradeToV4). */
export const REPORTED_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS members_reported ON members (report_count DESC, seq);
`;

/**
 * Run by `migrate()` once `results.rank_class` and `rank_key` are certain to exist (after
 * upgradeToV5). `seq` is the table's rowid, so it is the index's last term without being
 * named: `ORDER BY rank_class, rank_key, seq` is read straight off the index.
 */
export const RESULT_RANK_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS results_rank ON results (challenge_id, rank_class, rank_key);
`;

/** The tables' summary rows, most-entered first — the landing page's eight (club.md §18). */
export const RANKING_POPULAR_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS ranking_tables_popular
  ON ranking_tables (entry_count DESC, game_id, params_key);
`;

/**
 * A member's own rows. Neither table's key leads with `member_id` (results: `challenge_id`;
 * ranking_entries: `seq`), so without these a member's rename (`PATCH /me`) or the owner's
 * removal with the work reads every row of both tables. Like the other indexes they are
 * created idempotently on every start; the price is one more index row written per result
 * and per ranking row (docs/cloudflare.md §5).
 *
 * Since v6 `ranking_entries_member` runs on to `(game_id, params_key, value)` (and `seq`, the
 * rowid, after them): a member's rows in one table, best or worst first, are a walk of it —
 * the per-member cap on every insert, the member's best for `me` and `GET /rankings/mine`, and
 * their tables for `mine` — so none of those reads touches another member's rows.
 * `upgradeToV6` drops the v5 `(member_id)` index, which `IF NOT EXISTS` would otherwise keep.
 */
export const MEMBER_ROWS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS results_member ON results (member_id);
CREATE INDEX IF NOT EXISTS ranking_entries_member
  ON ranking_entries (member_id, game_id, params_key, value);
`;
