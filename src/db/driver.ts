/**
 * The seam between the SQL the store writes and the engine that runs it.
 * Two engines implement it — Node's `node:sqlite` (src/db/database.ts) and a
 * Durable Object's `ctx.storage.sql` (src/worker/driver.ts). Both are SQLite,
 * so every statement in store.ts and schema.ts is written once and the two
 * deployments differ only in how a request reaches the database. `exec` runs
 * a script with no bindings (the schema); the other three take bindings.
 */
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

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
 * v2 → v3. SCHEMA_SQL has already created `ranking_entries` and its index
 * (IF NOT EXISTS). The v2 `records` table is dropped, not carried over: it
 * was derived from challenge results, which rankings no longer follow
 * (club.md §16), so there is nothing in it a ranking could honestly inherit.
 */
function upgradeToV3(db: SqlDriver): void {
  db.exec(`DROP TABLE IF EXISTS records`);
  db.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(SCHEMA_VERSION));
}
