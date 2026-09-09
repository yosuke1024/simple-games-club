/**
 * Opening the one SQLite file. `node:sqlite` is the runtime's own binding —
 * no native module to build in the container, no dependency to keep patched
 * — which is why this server has zero runtime dependencies (README).
 */
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  if (row === undefined) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
    return;
  }
  const stored = Number(row.value);
  if (stored > SCHEMA_VERSION) {
    // Refuse rather than guess: a file written by a newer server may hold
    // columns this one would silently drop on the next write.
    throw new Error(
      `database schema ${stored} is newer than this server (${SCHEMA_VERSION}); upgrade the server`,
    );
  }
}
