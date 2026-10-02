import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type SqlDriver } from '../src/db/driver.js';

// The schema as v1 shipped it, copied here: the upgrade must work on exactly this.
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE club (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
  referral_url TEXT, last_activity_at TEXT
);
CREATE TABLE members (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')), joined_at TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT
);
CREATE TABLE invites (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')), token TEXT,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT,
  used_at TEXT, revoked_at TEXT
);
CREATE TABLE setup_keys_used (hash TEXT PRIMARY KEY, used_at TEXT NOT NULL);
CREATE TABLE challenges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, game_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL, params_json TEXT NOT NULL, seed TEXT NOT NULL,
  board_digest TEXT NOT NULL, title TEXT, created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE results (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id TEXT NOT NULL REFERENCES challenges(id),
  member_id TEXT NOT NULL REFERENCES members(id), nickname TEXT NOT NULL,
  submitted_at TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'played')),
  facts_json TEXT NOT NULL, UNIQUE (challenge_id, member_id)
);
`;

let dir: string;
let db: DatabaseSync;
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrate() from schema 1', () => {
  it('adds the columns, counts the results and derives the records', () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
    db = new DatabaseSync(join(dir, 'club.sqlite'));
    // Not openDatabase(): that migrates on open, and this database must start as v1.
    const d: SqlDriver = {
      exec: (script) => db.exec(script),
      run: (sql, ...params) => {
        db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
    };
    d.exec(V1_SCHEMA);
    d.run(`INSERT INTO meta VALUES ('schema_version', '1')`);
    d.run(`INSERT INTO club (id, name, created_at) VALUES ('c1', 'Club', 't0')`);
    d.run(
      `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES
         ('m1', 'Yoh', 'owner', 't0', 'h1'), ('m2', 'Ken', 'member', 't0', 'h2')`,
    );
    d.run(
      `INSERT INTO challenges (id, game_id, contract_version, params_json, seed, board_digest, created_by, created_at)
         VALUES ('ch1', 'sudoku', 1, '{"difficulty":"hard"}', 's', 'd', 'm1', 't1')`,
    );
    d.run(
      `INSERT INTO results (challenge_id, member_id, nickname, submitted_at, outcome, facts_json) VALUES
         ('ch1', 'm1', 'Yoh', 't1', 'completed', '{"elapsedSeconds":300}'),
         ('ch1', 'm2', 'Ken', 't2', 'completed', '{"elapsedSeconds":250}')`,
    );

    migrate(d);
    migrate(d); // idempotent

    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('2');
    expect(d.get(`SELECT result_count, daily FROM challenges WHERE id = 'ch1'`)).toEqual({
      result_count: 2,
      daily: null,
    });
    const records = d.all(`SELECT * FROM records`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      game_id: 'sudoku',
      params_key: 'hard',
      value: 250,
      member_id: 'm2',
      challenge_id: 'ch1',
    });
  });
});
