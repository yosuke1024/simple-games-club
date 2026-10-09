/**
 * The seam between the SQL the store writes and the engine that runs it.
 * Two engines implement it — Node's `node:sqlite` (src/db/database.ts) and a
 * Durable Object's `ctx.storage.sql` (src/worker/driver.ts). Both are SQLite,
 * so every statement in store.ts and schema.ts is written once and the two
 * deployments differ only in how a request reaches the database. `exec` runs
 * a script with no bindings (the schema); the other three take bindings.
 */
import { contractOf, resultRank } from '../contracts/games.js';
import {
  DAILY_INDEX_SQL,
  MEMBER_ROWS_INDEX_SQL,
  RANKING_CLIENT_INDEX_SQL,
  RANKING_ENTRIES_SQL,
  RANKING_INDEX_SQL,
  RANKING_POPULAR_INDEX_SQL,
  RANKING_TABLES_SQL,
  RESULT_RANK_INDEX_SQL,
  REPORTED_INDEX_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './schema.js';

export type SqlValue = string | number | null;
/** A row as the engine hands it back; the store narrows each column itself. */
export type Row = Record<string, unknown>;

export interface SqlDriver {
  exec(script: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  get(sql: string, ...params: SqlValue[]): Row | undefined;
  all(sql: string, ...params: SqlValue[]): Row[];
}

/** Creates the tables on first use, upgrades an older database, and refuses a newer one. */
export function migrate(db: SqlDriver): void {
  db.exec(SCHEMA_SQL);
  const row = db.get(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (row === undefined) {
    db.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, String(SCHEMA_VERSION));
    db.exec(RANKING_INDEX_SQL);
    db.exec(RANKING_CLIENT_INDEX_SQL);
    db.exec(DAILY_INDEX_SQL);
    db.exec(REPORTED_INDEX_SQL);
    db.exec(RESULT_RANK_INDEX_SQL);
    db.exec(RANKING_POPULAR_INDEX_SQL);
    db.exec(MEMBER_ROWS_INDEX_SQL);
    return;
  }
  const stored = Number(row.value);
  if (stored > SCHEMA_VERSION) {
    // Refuse rather than guess: a database written by a newer server may hold
    // columns this one would silently drop on the next write.
    throw new Error(
      `database schema ${stored} is newer than this server (${SCHEMA_VERSION}); upgrade the server`,
    );
  }
  if (stored < 2) upgradeToV2(db);
  if (stored < 3) upgradeToV3(db);
  if (stored < 4) upgradeToV4(db);
  if (stored < 5) upgradeToV5(db);
  if (stored < 6) upgradeToV6(db);
  addRankingClientId(db);
  db.exec(RANKING_INDEX_SQL);
  db.exec(RANKING_CLIENT_INDEX_SQL);
  db.exec(DAILY_INDEX_SQL);
  db.exec(REPORTED_INDEX_SQL);
  db.exec(RESULT_RANK_INDEX_SQL);
  db.exec(RANKING_POPULAR_INDEX_SQL);
  db.exec(MEMBER_ROWS_INDEX_SQL);
}

/**
 * v1 → v2. SCHEMA_SQL above has already created the board index
 * (IF NOT EXISTS); what an old `challenges` table lacks is added here,
 * checked first so a run that stopped half-way can simply run again.
 */
function upgradeToV2(db: SqlDriver): void {
  const have = new Set(
    db.all(`PRAGMA table_info(challenges)`).map((column) => String(column.name)),
  );
  if (!have.has('daily')) db.exec(`ALTER TABLE challenges ADD COLUMN daily TEXT`);
  if (!have.has('result_count')) {
    db.exec(`ALTER TABLE challenges ADD COLUMN result_count INTEGER NOT NULL DEFAULT 0`);
  }
  db.run(
    `UPDATE challenges SET result_count =
       (SELECT COUNT(*) FROM results r WHERE r.challenge_id = challenges.id)`,
  );
  db.run(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
}

/**
 * v2 → v3. SCHEMA_SQL has already created `ranking_entries` and
 * `ranking_tables` (IF NOT EXISTS). The v2 `records` table is dropped, not
 * carried over: it was derived from challenge results, which rankings no
 * longer follow (club.md §16), so there is nothing in it a ranking could
 * honestly inherit.
 *
 * A `ranking_entries` made before `seq` existed (a developer database only —
 * v3 was never deployed) gets the column, a backfill in insertion order, the
 * counter, and its index rebuilt; the summary table is rebuilt from the rows.
 * Every step can run again.
 */
export function upgradeToV3(db: SqlDriver): void {
  db.exec(`DROP TABLE IF EXISTS records`);
  const have = new Set(
    db.all(`PRAGMA table_info(ranking_entries)`).map((column) => String(column.name)),
  );
  if (!have.has('seq')) {
    db.exec(`ALTER TABLE ranking_entries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
    db.exec(`DROP INDEX IF EXISTS ranking_entries_table`);
    db.exec(`UPDATE ranking_entries SET seq = rowid`);
  }
  db.exec(RANKING_INDEX_SQL);
  const top = db.get(`SELECT COALESCE(MAX(seq), 0) AS top FROM ranking_entries`);
  db.run(
    `INSERT INTO meta (key, value) VALUES ('ranking_seq', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    String(Number(top?.top ?? 0)),
  );
  rebuildRankingTables(db);
  db.run(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
}

/**
 * v3 → v4. SCHEMA_SQL has already created `reports` (IF NOT EXISTS), and the
 * `challenges.daily` and `members_reported` indexes follow in migrate(). What
 * an older table lacks (`members.report_count`) is added and backfilled from
 * `reports`, so running it again changes nothing.
 */
export function upgradeToV4(db: SqlDriver): void {
  db.exec(`CREATE TABLE IF NOT EXISTS reports (
    target_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (target_id, reporter_id)
  )`);
  const have = new Set(db.all(`PRAGMA table_info(members)`).map((column) => String(column.name)));
  if (!have.has('report_count')) {
    db.exec(`ALTER TABLE members ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0`);
  }
  db.run(
    `UPDATE members SET report_count =
       (SELECT COUNT(*) FROM reports r WHERE r.target_id = members.id)`,
  );
  db.run(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`);
}

/**
 * v4 → v5. SCHEMA_SQL has already created the two indexes' tables; what an older
 * `results` table lacks (`rank_class`, `rank_key`) is added and every row's rank is
 * computed by `rerankResults`, so running it again changes nothing. The indexes follow in
 * migrate(), after the columns exist.
 */
export function upgradeToV5(db: SqlDriver): void {
  const have = new Set(db.all(`PRAGMA table_info(results)`).map((column) => String(column.name)));
  if (!have.has('rank_class')) {
    db.exec(`ALTER TABLE results ADD COLUMN rank_class INTEGER NOT NULL DEFAULT 2`);
  }
  if (!have.has('rank_key')) db.exec(`ALTER TABLE results ADD COLUMN rank_key REAL`);
  rerankResults(db);
  db.run(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
}

/**
 * v5 → v6 (club.md §16-1, 2026-10-10): a ranking table holds one row per result instead of
 * one per member. `ranking_entries` is rebuilt with `seq` — the arrival counter its rows
 * already carried, unique because every write took a fresh one — as its key, and every row is
 * copied as it is, so each member's one best becomes their first result row. `ranking_tables`
 * names its leader by row (`leader_seq`) instead of by member: it is rebuilt from the rows,
 * which names the same leader the v5 summary did (the best value, the earliest `seq` on a
 * tie), and its count is the rows, which in a v5 database is the members. The v5 `(member_id)` index
 * goes with the old table; migrate() builds the v6 indexes after this.
 *
 * Every step can run again: the old table is renamed aside before anything is dropped and is
 * itself dropped only once its rows are copied, so a run that stopped half-way — even with the
 * empty v6 table SCHEMA_SQL created on the next start — finds it and finishes the copy.
 */
export function upgradeToV6(db: SqlDriver): void {
  const columns = (table: string) => db.all(`PRAGMA table_info(${table})`);
  const keyOfEntries = columns('ranking_entries')
    .filter((column) => Number(column.pk) > 0)
    .map((column) => String(column.name));
  if (keyOfEntries.includes('member_id')) {
    db.exec(`DROP INDEX IF EXISTS ranking_entries_member`);
    db.exec(`DROP INDEX IF EXISTS ranking_entries_table`);
    db.exec(`ALTER TABLE ranking_entries RENAME TO ranking_entries_v5`);
  }
  if (columns('ranking_entries_v5').length > 0) {
    db.exec(RANKING_ENTRIES_SQL);
    db.exec(
      `INSERT OR IGNORE INTO ranking_entries
         (game_id, params_key, member_id, nickname, value, facts_json, seed, board_digest,
          submitted_at, seq)
       SELECT game_id, params_key, member_id, nickname, value, facts_json, seed, board_digest,
              submitted_at, seq
       FROM ranking_entries_v5`,
    );
    db.exec(`DROP TABLE ranking_entries_v5`);
  }
  // The counter must stay ahead of every row, or a new result would take a used key.
  const top = Number(db.get(`SELECT COALESCE(MAX(seq), 0) AS top FROM ranking_entries`)?.top ?? 0);
  const counter = db.get(`SELECT value FROM meta WHERE key = 'ranking_seq'`);
  if (counter === undefined || Number(counter.value) < top) {
    db.run(
      `INSERT INTO meta (key, value) VALUES ('ranking_seq', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(top),
    );
  }
  if (!columns('ranking_tables').some((column) => String(column.name) === 'leader_seq')) {
    db.exec(`DROP TABLE IF EXISTS ranking_tables`); // its ranking_tables_popular index with it
    db.exec(RANKING_TABLES_SQL);
  }
  rebuildRankingTables(db);
  db.run(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
}

/**
 * `ranking_entries.client_id` (club.md §16-1, the result's idempotency key) belongs to the
 * v6 table itself, not to a version of its own: v6 was never deployed. A table `upgradeToV6`
 * or `SCHEMA_SQL` just made has it; this adds it to one already at v6 from before the key
 * (a developer database), where every row has none. Checked first, so it can run again.
 */
function addRankingClientId(db: SqlDriver): void {
  const have = db
    .all(`PRAGMA table_info(ranking_entries)`)
    .some((column) => String(column.name) === 'client_id');
  if (!have) db.exec(`ALTER TABLE ranking_entries ADD COLUMN client_id TEXT`);
}

/**
 * Recompute `rank_class` / `rank_key` of every stored result with `resultRank`
 * (src/contracts/games.ts) — the one reading of `facts`, so a stored row and a fresh one
 * can never disagree. Writes only the rows whose rank changed, so it is cheap to run
 * again; a change to GAME_CONTRACTS must ship with a schema bump that calls it.
 */
export function rerankResults(db: SqlDriver): void {
  const rows = db.all(
    `SELECT r.seq, r.outcome, r.facts_json, r.rank_class, r.rank_key, c.game_id
       FROM results r JOIN challenges c ON c.id = r.challenge_id`,
  );
  for (const row of rows) {
    let facts: unknown = null;
    try {
      facts = JSON.parse(String(row.facts_json));
    } catch {
      // Unreadable facts have no axis; the row sorts as a completed result without one.
    }
    const { rankClass, rankKey } = resultRank(String(row.game_id), String(row.outcome), facts);
    const sameKey = rankKey === null ? row.rank_key === null : Number(row.rank_key) === rankKey;
    if (Number(row.rank_class) === rankClass && sameKey) continue;
    db.run(
      `UPDATE results SET rank_class = ?, rank_key = ? WHERE seq = ?`,
      rankClass,
      rankKey,
      row.seq as number,
    );
  }
}

/**
 * One pass over the entries, grouped in code: count and leader per table. The leader is
 * written as `leader_seq` (v6), or as `leader_member_id` when `upgradeToV3` meets a summary
 * table still in its pre-v6 shape (`upgradeToV6` replaces that table afterwards).
 */
function rebuildRankingTables(db: SqlDriver): void {
  const bySeq = db
    .all(`PRAGMA table_info(ranking_tables)`)
    .some((column) => String(column.name) === 'leader_seq');
  db.run(`DELETE FROM ranking_tables`);
  const tables = new Map<
    string,
    { gameId: string; paramsKey: string; count: number; leader: string; value: number; seq: number }
  >();
  const rows = db.all(
    `SELECT game_id, params_key, member_id, value, seq FROM ranking_entries ORDER BY seq`,
  );
  for (const row of rows) {
    const gameId = String(row.game_id);
    const paramsKey = String(row.params_key);
    const value = Number(row.value);
    const key = `${gameId}\u0000${paramsKey}`;
    const table = tables.get(key);
    if (table === undefined) {
      tables.set(key, {
        gameId,
        paramsKey,
        count: 1,
        leader: String(row.member_id),
        value,
        seq: Number(row.seq),
      });
      continue;
    }
    table.count += 1;
    const asc = (contractOf(gameId)?.direction ?? 'asc') === 'asc';
    // Rows arrive in seq order, so only a strictly better value takes the lead.
    if (asc ? value < table.value : value > table.value) {
      table.leader = String(row.member_id);
      table.value = value;
      table.seq = Number(row.seq);
    }
  }
  for (const t of tables.values()) {
    db.run(
      `INSERT INTO ranking_tables (game_id, params_key, entry_count, ${bySeq ? 'leader_seq' : 'leader_member_id'})
       VALUES (?, ?, ?, ?)`,
      t.gameId,
      t.paramsKey,
      t.count,
      bySeq ? t.seq : t.leader,
    );
  }
}
