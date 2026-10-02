/**
 * The store's SQL on a Durable Object's own SQLite (`ctx.storage.sql`). The
 * cursor reports the rows each statement read and wrote — the two numbers
 * Cloudflare bills SQLite storage by — so the driver can add them up for the
 * cost measurement (`X-Club-Rows` in test mode, docs/cloudflare.md).
 */
import type { Row, SqlDriver } from '../db/driver.js';

export interface RowCounter {
  read: number;
  written: number;
}

export function sqlDriver(sql: SqlStorage, counter?: RowCounter): SqlDriver {
  const drain = (cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Row[] => {
    // toArray() runs the statement to completion; the counters are final after it.
    const rows = cursor.toArray();
    if (counter !== undefined) {
      counter.read += cursor.rowsRead;
      counter.written += cursor.rowsWritten;
    }
    return rows;
  };
  return {
    exec: (script) => {
      drain(sql.exec(script));
    },
    run: (statement, ...params) => {
      drain(sql.exec(statement, ...params));
    },
    get: (statement, ...params) => drain(sql.exec(statement, ...params))[0],
    all: (statement, ...params) => drain(sql.exec(statement, ...params)),
  };
}
