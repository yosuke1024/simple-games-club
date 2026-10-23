/**
 * Owner-published record references. No copied names/facts survive a source deletion.
 * The item ids intentionally are not foreign keys: pruning a ranking row must keep
 * working, leaving that item unavailable when the album is read.
 */
export const OWNER_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS owner_albums (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  client_id TEXT UNIQUE,
  selection_json TEXT NOT NULL
);
`;
