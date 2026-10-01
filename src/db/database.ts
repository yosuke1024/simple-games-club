/**
 * Opening the one SQLite file on Node. `node:sqlite` is the runtime's own
 * binding — no native module to build in the container, no dependency to
 * keep patched — which is why the Node server has zero runtime dependencies
 * (README). The Durable Object deployment opens nothing: its database is the
 * object's own storage (src/worker/driver.ts).
 */
import { DatabaseSync } from 'node:sqlite';
import { migrate, type SqlDriver } from './driver.js';

export interface NodeDatabase {
  driver: SqlDriver;
  close(): void;
}

export function openDatabase(path: string): NodeDatabase {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const driver: SqlDriver = {
    exec: (script) => db.exec(script),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
  };
  migrate(driver);
  return { driver, close: () => db.close() };
}
