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

/** Creates the tables on first use and refuses a database written by a newer server. */
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
}
