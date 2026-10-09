import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { resultRank } from '../src/contracts/games.js';
import {
  migrate,
  upgradeToV3,
  upgradeToV4,
  rerankResults,
  upgradeToV5,
  upgradeToV6,
  type SqlDriver,
  type SqlValue,
} from '../src/db/driver.js';
import { Store } from '../src/db/store.js';

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

// The two ranking tables as v5 shipped them (one row per member), and their indexes.
const V5_RANKINGS = `
CREATE TABLE ranking_entries (
  game_id TEXT NOT NULL, params_key TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id),
  nickname TEXT NOT NULL, value REAL NOT NULL, facts_json TEXT NOT NULL, seed TEXT NOT NULL,
  board_digest TEXT, submitted_at TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (game_id, params_key, member_id)
);
CREATE TABLE ranking_tables (
  game_id TEXT NOT NULL, params_key TEXT NOT NULL, entry_count INTEGER NOT NULL,
  leader_member_id TEXT NOT NULL, PRIMARY KEY (game_id, params_key)
);
CREATE INDEX ranking_entries_table ON ranking_entries (game_id, params_key, value, seq);
CREATE INDEX ranking_entries_member ON ranking_entries (member_id);
CREATE INDEX ranking_tables_popular ON ranking_tables (entry_count DESC, game_id, params_key);
`;

/** v5 rows `[seq, game, mode, member, value]`: b bettered his sudoku row (seq 2 → 4). */
const V5_ROWS: [number, string, string, string, number][] = [
  [1, 'sudoku', 'hard', 'a', 300],
  [3, 'sudoku', 'hard', 'c', 200],
  [4, 'sudoku', 'hard', 'b', 200],
  [5, '2048', 'default', 'a', 10],
  [6, '2048', 'default', 'b', 90],
  [7, '2048', 'default', 'c', 90],
  [8, 'hearts', 'x', 'd', 5],
];

let dir: string;
let db: DatabaseSync;

/** A fresh database file behind a driver, without migrating it. */
function openRaw(): SqlDriver {
  dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
  db = new DatabaseSync(join(dir, 'club.sqlite'));
  return {
    exec: (script) => db.exec(script),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
  };
}

/** A current database made to look like v5: the v5 ranking tables, filled as v5 kept them. */
function seedV5(d: SqlDriver): void {
  migrate(d);
  d.exec(`DROP TABLE ranking_entries`);
  d.exec(`DROP TABLE ranking_tables`);
  d.exec(V5_RANKINGS);
  d.run(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`);
  for (const id of ['a', 'b', 'c', 'd']) {
    d.run(
      `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, 'member', 't', ?)`,
      id,
      `N${id}`,
      `h${id}`,
    );
  }
  for (const [seq, game, mode, member, value] of V5_ROWS) {
    d.run(
      `INSERT INTO ranking_entries VALUES (?, ?, ?, ?, ?, ?, '', NULL, ?, ?)`,
      game,
      mode,
      member,
      `N${member}`,
      value,
      `{"v":${value}}`,
      `t${seq}`,
      seq,
    );
  }
  d.run(
    `INSERT INTO ranking_tables VALUES
       ('sudoku', 'hard', 3, 'c'), ('2048', 'default', 3, 'b'), ('hearts', 'x', 1, 'd')`,
  );
  d.run(
    `INSERT INTO meta (key, value) VALUES ('ranking_seq', '9')
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
}

const keyOf = (d: SqlDriver, table: string): string[] =>
  d
    .all(`PRAGMA table_info(${table})`)
    .filter((column) => Number(column.pk) > 0)
    .map((column) => String(column.name));

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrate() from schema 1', () => {
  it('adds the columns, counts the results and ends at the current version, without records', () => {
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

    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('6');
    expect(d.get(`SELECT result_count, daily FROM challenges WHERE id = 'ch1'`)).toEqual({
      result_count: 2,
      daily: null,
    });
    expect(d.get(`SELECT name FROM sqlite_master WHERE name = 'records'`)).toBeUndefined();
    expect(d.get(`SELECT name FROM sqlite_master WHERE name = 'ranking_entries'`)).toBeDefined();
  });

  it('drops the v2 records table and creates ranking_entries (schema 2 → 3)', () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
    db = new DatabaseSync(join(dir, 'club.sqlite'));
    const d: SqlDriver = {
      exec: (script) => db.exec(script),
      run: (sql, ...params) => {
        db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
    };
    d.exec(V1_SCHEMA);
    d.exec(`ALTER TABLE challenges ADD COLUMN daily TEXT`);
    d.exec(`ALTER TABLE challenges ADD COLUMN result_count INTEGER NOT NULL DEFAULT 0`);
    d.exec(`CREATE TABLE records (
      game_id TEXT NOT NULL, params_key TEXT NOT NULL, value REAL NOT NULL,
      challenge_id TEXT NOT NULL, member_id TEXT NOT NULL, nickname TEXT NOT NULL,
      facts_json TEXT NOT NULL, submitted_at TEXT NOT NULL, PRIMARY KEY (game_id, params_key)
    )`);
    d.run(`INSERT INTO records VALUES ('sudoku', 'hard', 250, 'ch1', 'm2', 'Ken', '{}', 't2')`);
    d.run(`INSERT INTO meta VALUES ('schema_version', '2')`);

    migrate(d);
    migrate(d); // idempotent

    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('6');
    expect(d.get(`SELECT name FROM sqlite_master WHERE name = 'records'`)).toBeUndefined();
    expect(d.all(`SELECT * FROM ranking_entries`)).toEqual([]);
    expect(
      d.get(`SELECT name FROM sqlite_master WHERE name = 'ranking_entries_table'`),
    ).toBeDefined();
  });

  it('upgradeToV3 adds seq, backfills it, and builds ranking_tables from existing rows', () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
    db = new DatabaseSync(join(dir, 'club.sqlite'));
    const d: SqlDriver = {
      exec: (script) => db.exec(script),
      run: (sql, ...params) => {
        db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
    };
    d.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    d.exec(`CREATE TABLE ranking_entries (
      game_id TEXT NOT NULL, params_key TEXT NOT NULL, member_id TEXT NOT NULL,
      nickname TEXT NOT NULL, value REAL NOT NULL, facts_json TEXT NOT NULL, seed TEXT NOT NULL,
      board_digest TEXT, submitted_at TEXT NOT NULL, PRIMARY KEY (game_id, params_key, member_id)
    )`);
    d.exec(`CREATE TABLE ranking_tables (
      game_id TEXT NOT NULL, params_key TEXT NOT NULL, entry_count INTEGER NOT NULL,
      leader_member_id TEXT NOT NULL, PRIMARY KEY (game_id, params_key)
    )`);
    d.run(`INSERT INTO meta VALUES ('schema_version', '3')`);
    const put = (game: string, member: string, value: number) =>
      d.run(
        `INSERT INTO ranking_entries VALUES (?, 'k', ?, ?, ?, '{}', '', NULL, 't')`,
        game,
        member,
        member,
        value,
      );
    put('sudoku', 'a', 300); // asc: lower leads, ties keep the earlier row
    put('sudoku', 'b', 200);
    put('sudoku', 'c', 200);
    put('2048', 'a', 10); // desc: higher leads
    put('2048', 'b', 90);
    put('2048', 'c', 50);
    put('hearts', 'a', 5);

    upgradeToV3(d);
    upgradeToV3(d); // idempotent

    expect(d.get(`SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM ranking_entries`)).toEqual({
      lo: 1,
      hi: 7,
    });
    expect(d.get(`SELECT value FROM meta WHERE key = 'ranking_seq'`)?.value).toBe('7');
    expect(
      d.all(`SELECT game_id, entry_count, leader_member_id FROM ranking_tables ORDER BY game_id`),
    ).toEqual([
      { game_id: '2048', entry_count: 3, leader_member_id: 'b' },
      { game_id: 'hearts', entry_count: 1, leader_member_id: 'a' },
      { game_id: 'sudoku', entry_count: 3, leader_member_id: 'b' },
    ]);
  });

  it('upgradeToV4 adds reports and the daily index, and runs again to the same result', () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
    db = new DatabaseSync(join(dir, 'club.sqlite'));
    const d: SqlDriver = {
      exec: (script) => db.exec(script),
      run: (sql, ...params) => {
        db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
    };
    migrate(d); // a current database…
    d.exec(`DROP TABLE reports`);
    d.exec(`DROP INDEX members_reported`);
    d.exec(`ALTER TABLE members DROP COLUMN report_count`);
    d.exec(`DROP INDEX challenges_daily`);
    d.run(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`); // …made to look like v3
    for (const id of ['a', 'b', 'c']) {
      d.run(
        `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, 'member', 't', ?)`,
        id,
        id,
        `h${id}`,
      );
    }
    migrate(d);
    expect(d.all(`SELECT * FROM reports`)).toEqual([]);
    expect(d.all(`SELECT id, report_count FROM members ORDER BY id`)).toEqual([
      { id: 'a', report_count: 0 },
      { id: 'b', report_count: 0 },
      { id: 'c', report_count: 0 },
    ]);
    // Backfill: reports that exist when the upgrade runs are counted per target.
    d.run(`INSERT INTO reports VALUES ('a', 'b', 't'), ('a', 'c', 't'), ('b', 'c', 't')`);
    d.run(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    d.exec(`UPDATE members SET report_count = 0`);
    migrate(d);
    migrate(d);
    upgradeToV4(d);
    expect(d.all(`SELECT id, report_count FROM members ORDER BY id`)).toEqual([
      { id: 'a', report_count: 2 },
      { id: 'b', report_count: 1 },
      { id: 'c', report_count: 0 },
    ]);
    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('4');
    expect(d.get(`SELECT name FROM sqlite_master WHERE name = 'members_reported'`)).toBeDefined();
    expect(d.get(`SELECT name FROM sqlite_master WHERE name = 'challenges_daily'`)).toBeDefined();
  });

  it('upgradeToV5 ranks every result like resultRank does, adds the indexes, and runs again to the same result', () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
    db = new DatabaseSync(join(dir, 'club.sqlite'));
    const d: SqlDriver = {
      exec: (script) => db.exec(script),
      run: (sql, ...params) => {
        db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
    };
    migrate(d); // a current database…
    d.exec(`DROP INDEX results_rank`);
    d.exec(`DROP INDEX ranking_tables_popular`);
    d.exec(`ALTER TABLE results DROP COLUMN rank_class`);
    d.exec(`ALTER TABLE results DROP COLUMN rank_key`);
    d.run(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`); // …made to look like v4
    for (const id of ['a', 'b', 'c', 'e', 'f', 'g', 'h']) {
      d.run(
        `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, 'member', 't', ?)`,
        id,
        id,
        `h${id}`,
      );
    }
    for (const game of ['sudoku', '2048', 'hearts', 'checkers', 'water-sort']) {
      d.run(
        `INSERT INTO challenges (id, game_id, contract_version, params_json, seed, board_digest, created_by, created_at)
         VALUES (?, ?, 1, '{}', 's', ?, 'a', 't')`,
        `ch-${game}`,
        game,
        `d-${game}`,
      );
    }
    const put = (game: string, member: string, outcome: string, facts: string) =>
      d.run(
        `INSERT INTO results (challenge_id, member_id, nickname, submitted_at, outcome, facts_json)
         VALUES (?, ?, ?, 't', ?, ?)`,
        `ch-${game}`,
        member,
        member,
        outcome,
        facts,
      );
    put('sudoku', 'a', 'completed', '{"elapsedSeconds":300}');
    put('sudoku', 'b', 'completed', '{"elapsedSeconds":12.5,"mistakes":1}');
    put('sudoku', 'c', 'completed', '{"mistakes":2}'); // no axis
    put('sudoku', 'e', 'played', '{"elapsedSeconds":1}'); // never ranked
    // SQLite's json_extract reads a JSON boolean as the integer 1/0; resultRank must not.
    put('sudoku', 'f', 'completed', '{"elapsedSeconds":true}');
    put('sudoku', 'g', 'completed', '{"elapsedSeconds":false}');
    put('sudoku', 'h', 'completed', 'not json');
    put('2048', 'a', 'completed', '{"score":0}');
    put('2048', 'b', 'completed', '{"score":4096}');
    put('2048', 'c', 'completed', '{"score":"high"}'); // not a number
    put('hearts', 'a', 'completed', '{"score":-3}');
    put('hearts', 'b', 'completed', '{"score":20}');
    put('checkers', 'a', 'completed', '{"turns":40}'); // no contract
    put('checkers', 'b', 'played', '{}');
    put('water-sort', 'a', 'completed', '{"moves":31}');

    migrate(d);
    migrate(d);
    upgradeToV5(d);

    const rows = d.all(
      `SELECT r.rank_class, r.rank_key, r.outcome, r.facts_json, c.game_id
       FROM results r JOIN challenges c ON c.id = r.challenge_id`,
    );
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      const expected = resultRank(
        String(row.game_id),
        String(row.outcome),
        (() => {
          try {
            return JSON.parse(String(row.facts_json));
          } catch {
            return null; // the one unreadable row above
          }
        })(),
      );
      expect(
        { rank_class: row.rank_class, rank_key: row.rank_key },
        String(row.facts_json),
      ).toEqual({ rank_class: expected.rankClass, rank_key: expected.rankKey });
    }
    // The cases are not all the trivial class: ascending, descending (negated), none, played.
    const keyOf = (game: string, member: string) =>
      d.get(
        `SELECT rank_class, rank_key FROM results WHERE challenge_id = ? AND member_id = ?`,
        `ch-${game}`,
        member,
      );
    expect(keyOf('sudoku', 'b')).toEqual({ rank_class: 0, rank_key: 12.5 });
    expect(keyOf('2048', 'b')).toEqual({ rank_class: 0, rank_key: -4096 });
    expect(keyOf('2048', 'a')).toEqual({ rank_class: 0, rank_key: 0 });
    expect(keyOf('hearts', 'a')).toEqual({ rank_class: 0, rank_key: -3 });
    expect(keyOf('sudoku', 'c')).toEqual({ rank_class: 1, rank_key: null });
    expect(keyOf('checkers', 'a')).toEqual({ rank_class: 1, rank_key: null });
    expect(keyOf('sudoku', 'e')).toEqual({ rank_class: 2, rank_key: null });
    expect(keyOf('sudoku', 'f')).toEqual({ rank_class: 1, rank_key: null });
    expect(keyOf('sudoku', 'g')).toEqual({ rank_class: 1, rank_key: null });
    expect(keyOf('sudoku', 'h')).toEqual({ rank_class: 1, rank_key: null });

    // rerankResults puts a stale rank right, and leaves a right one alone.
    d.run(`UPDATE results SET rank_class = 2, rank_key = 99 WHERE member_id = 'b'`);
    rerankResults(d);
    expect(keyOf('sudoku', 'b')).toEqual({ rank_class: 0, rank_key: 12.5 });
    expect(keyOf('2048', 'b')).toEqual({ rank_class: 0, rank_key: -4096 });

    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('5');
    // The best-N read and the most-entered tables are read off their indexes, with no sort.
    const plan = (sql: string) =>
      d.all(`EXPLAIN QUERY PLAN ${sql}`).map((row) => String(row.detail));
    expect(
      plan(
        `SELECT * FROM results WHERE challenge_id = 'x' ORDER BY rank_class, rank_key, seq LIMIT 5`,
      ),
    ).toEqual([expect.stringContaining('results_rank')]);
    expect(
      plan(
        `SELECT game_id, params_key, entry_count FROM ranking_tables
         ORDER BY entry_count DESC, game_id, params_key LIMIT 8`,
      ),
    ).toEqual([expect.stringContaining('ranking_tables_popular')]);
  });

  it('upgradeToV6 turns each v5 best into a first result row, names leaders by row, and rebuilds the member index', () => {
    const d = openRaw();
    seedV5(d);

    migrate(d);
    migrate(d); // idempotent
    upgradeToV6(d); // and once more by hand: still the same

    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('6');
    // Every row, as it was: the arrival counter is now the key.
    expect(
      d.all(
        `SELECT seq, game_id, member_id, nickname, value, facts_json FROM ranking_entries ORDER BY seq`,
      ),
    ).toEqual(
      V5_ROWS.map(([seq, game_id, , member_id, value]) => ({
        seq,
        game_id,
        member_id,
        nickname: `N${member_id}`,
        value,
        facts_json: `{"v":${value}}`,
      })),
    );
    expect(keyOf(d, 'ranking_entries')).toEqual(['seq']);
    expect(d.all(`PRAGMA table_info(ranking_entries_v5)`)).toEqual([]);
    // Leaders by row: the best value, the earliest on a tie (c's 200 arrived before b's).
    expect(
      d.all(
        `SELECT game_id, params_key, entry_count, leader_seq FROM ranking_tables ORDER BY game_id`,
      ),
    ).toEqual([
      { game_id: '2048', params_key: 'default', entry_count: 3, leader_seq: 6 },
      { game_id: 'hearts', params_key: 'x', entry_count: 1, leader_seq: 8 },
      { game_id: 'sudoku', params_key: 'hard', entry_count: 3, leader_seq: 3 },
    ]);
    expect(
      d.all(`PRAGMA table_info(ranking_tables)`).map((column) => String(column.name)),
    ).not.toContain('leader_member_id');
    expect(
      d.all(`PRAGMA index_info(ranking_entries_member)`).map((column) => String(column.name)),
    ).toEqual(['member_id', 'game_id', 'params_key', 'value']);
    for (const index of ['ranking_entries_table', 'ranking_tables_popular']) {
      expect(d.get(`SELECT name FROM sqlite_master WHERE name = ?`, index), index).toBeDefined();
    }
    // The counter is where v5 left it (a deleted row once took 9): the next row is 10.
    expect(d.get(`SELECT value FROM meta WHERE key = 'ranking_seq'`)?.value).toBe('9');

    // The store reads the upgraded database: c plays again and is in the table twice.
    const store = new Store(d);
    const added = store.addRanking({
      gameId: 'sudoku',
      paramsKey: 'hard',
      memberId: 'c',
      nickname: 'Nc',
      value: 250,
      facts: { v: 250 },
      seed: '',
      boardDigest: null,
      now: 't9',
      rowsPerMember: 50,
    });
    expect(added).toMatchObject({ improved: false, entryCount: 4, entry: { seq: 10 } });
    expect(store.rankingTop('sudoku', 'hard', 10).map((e) => [e.memberId, e.value])).toEqual([
      ['c', 200],
      ['b', 200],
      ['c', 250],
      ['a', 300],
    ]);
    expect(store.rankingTables().map((t) => [t.gameId, t.entryCount, t.leader.memberId])).toEqual([
      ['2048', 3, 'b'],
      ['hearts', 1, 'd'],
      ['sudoku', 4, 'c'],
    ]);
  });

  it('upgradeToV6 finishes a copy that stopped half-way, and moves the counter past every row', () => {
    for (const stop of ['after the rename', 'after the copy'] as const) {
      const d = openRaw();
      seedV5(d);
      d.run(`DELETE FROM meta WHERE key = 'ranking_seq'`); // a counter behind the rows
      d.exec(`DROP INDEX ranking_entries_member`);
      d.exec(`DROP INDEX ranking_entries_table`);
      d.exec(`ALTER TABLE ranking_entries RENAME TO ranking_entries_v5`);
      if (stop === 'after the copy') {
        d.exec(`CREATE TABLE ranking_entries (
          game_id TEXT NOT NULL, params_key TEXT NOT NULL, member_id TEXT NOT NULL,
          nickname TEXT NOT NULL, value REAL NOT NULL, facts_json TEXT NOT NULL, seed TEXT NOT NULL,
          board_digest TEXT, submitted_at TEXT NOT NULL, seq INTEGER PRIMARY KEY
        )`);
        d.exec(`INSERT INTO ranking_entries SELECT * FROM ranking_entries_v5`);
      }
      // The next start: SCHEMA_SQL makes an empty v6 table if there is none, then the upgrade.
      migrate(d);
      expect(d.all(`SELECT seq FROM ranking_entries ORDER BY seq`), stop).toEqual(
        V5_ROWS.map(([seq]) => ({ seq })),
      );
      expect(d.all(`PRAGMA table_info(ranking_entries_v5)`), stop).toEqual([]);
      expect(d.get(`SELECT value FROM meta WHERE key = 'ranking_seq'`)?.value, stop).toBe('8');
      expect(d.get(`SELECT COUNT(*) AS n FROM ranking_tables`)?.n, stop).toBe(3);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // afterEach closes the last one.
    openRaw();
  });

  it('upgradeToV6 gives the copied rows no client_id, and the partial unique index lets a keyed result in once', () => {
    const d = openRaw();
    seedV5(d);
    migrate(d);

    expect(
      d.all(`PRAGMA table_info(ranking_entries)`).map((column) => String(column.name)),
    ).toContain('client_id');
    expect(d.get(`SELECT COUNT(*) AS n FROM ranking_entries WHERE client_id IS NOT NULL`)?.n).toBe(
      0,
    );
    // The index is unique over (member_id, client_id) and partial: rows without a key are not in it.
    const index = d
      .all(`PRAGMA index_list(ranking_entries)`)
      .find((i) => i.name === 'ranking_entries_client');
    expect(index).toMatchObject({ unique: 1, partial: 1 });
    expect(
      d.all(`PRAGMA index_info(ranking_entries_client)`).map((column) => String(column.name)),
    ).toEqual(['member_id', 'client_id']);
    expect(
      String(
        d.get(`SELECT sql FROM sqlite_master WHERE name = 'ranking_entries_client'`)?.sql,
      ).replace(/\s+/g, ' '),
    ).toContain('WHERE client_id IS NOT NULL');

    // Rows with no key never collide, however many a member has; a key is stored once.
    const store = new Store(d);
    const add = (memberId: string, clientId?: string) =>
      store.addRanking({
        gameId: 'sudoku',
        paramsKey: 'hard',
        memberId,
        nickname: `N${memberId}`,
        value: 250,
        facts: { v: 250 },
        seed: '',
        boardDigest: null,
        now: 't9',
        rowsPerMember: 50,
        clientId,
      });
    expect(add('c').duplicate).toBe(false);
    expect(add('c').duplicate).toBe(false); // no key: legacy behaviour, a row each time
    const keyed = add('c', 'k-0123456789');
    expect(keyed).toMatchObject({ duplicate: false, entryCount: 6 });
    const resent = add('c', 'k-0123456789');
    expect(resent).toMatchObject({ duplicate: true, improved: false, entryCount: 6 });
    expect(resent.entry?.seq).toBe(keyed.entry?.seq);
    // The key is per member.
    expect(add('a', 'k-0123456789')).toMatchObject({ duplicate: false, entryCount: 7 });
    // The unique index itself refuses a second row with the pair, whatever the store checks.
    expect(() =>
      d.run(
        `INSERT INTO ranking_entries
           (game_id, params_key, member_id, nickname, value, facts_json, seed, submitted_at, seq, client_id)
         VALUES ('sudoku', 'hard', 'c', 'Nc', 1, '{}', '', 't', 999, 'k-0123456789')`,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('adds client_id to a v6 database from before the key, keeps its rows, and runs again to the same result', () => {
    const d = openRaw();
    migrate(d);
    for (const id of ['a', 'b']) {
      d.run(
        `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, 'member', 't', ?)`,
        id,
        `N${id}`,
        `h${id}`,
      );
    }
    new Store(d).addRanking({
      gameId: 'sudoku',
      paramsKey: 'hard',
      memberId: 'a',
      nickname: 'Na',
      value: 300,
      facts: { v: 300 },
      seed: '',
      boardDigest: null,
      now: 't1',
      rowsPerMember: 50,
    });
    // The table as the unreleased v6 first had it: no client_id, no key index.
    d.exec(`DROP INDEX ranking_entries_client`);
    d.exec(`ALTER TABLE ranking_entries DROP COLUMN client_id`);
    expect(
      d.all(`PRAGMA table_info(ranking_entries)`).map((column) => String(column.name)),
    ).not.toContain('client_id');

    migrate(d);
    migrate(d); // and again: nothing changes

    expect(d.get(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value).toBe('6');
    expect(d.all(`SELECT seq, member_id, value, client_id FROM ranking_entries`)).toEqual([
      { seq: 1, member_id: 'a', value: 300, client_id: null },
    ]);
    expect(d.get(`SELECT name FROM sqlite_master WHERE name = 'ranking_entries_client'`)).toEqual({
      name: 'ranking_entries_client',
    });
    const store = new Store(d);
    const send = () =>
      store.addRanking({
        gameId: 'sudoku',
        paramsKey: 'hard',
        memberId: 'b',
        nickname: 'Nb',
        value: 200,
        facts: { v: 200 },
        seed: '',
        boardDigest: null,
        now: 't2',
        rowsPerMember: 50,
        clientId: 'after-upgrade-1',
      });
    expect(send()).toMatchObject({ duplicate: false, entryCount: 2, entry: { seq: 2 } });
    expect(send()).toMatchObject({ duplicate: true, entryCount: 2, entry: { seq: 2 } });
  });

  it("reads a rank with two range counts and the member's rows off ranking_entries_member, never a scan or a sort", () => {
    const d = openRaw();
    migrate(d);
    const issued: { sql: string; params: SqlValue[] }[] = [];
    const spy: SqlDriver = {
      exec: (script) => d.exec(script),
      run: (sql, ...params) => {
        issued.push({ sql, params });
        d.run(sql, ...params);
      },
      get: (sql, ...params) => {
        issued.push({ sql, params });
        return d.get(sql, ...params);
      },
      all: (sql, ...params) => {
        issued.push({ sql, params });
        return d.all(sql, ...params);
      },
    };
    d.run(
      `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES ('m', 'm', 'member', 't', 'h')`,
    );
    const store = new Store(spy);
    const plans = (): string[][] =>
      issued
        .filter(
          ({ sql }) => /^\s*(SELECT|UPDATE|DELETE)/i.test(sql) && sql.includes('ranking_entries'),
        )
        .map(({ sql, params }) =>
          d.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => String(row.detail)),
        );
    for (const gameId of ['sudoku', '2048']) {
      const add = (value: number, clientId?: string) =>
        store.addRanking({
          gameId,
          paramsKey: 'p',
          memberId: 'm',
          nickname: 'm',
          value,
          facts: {},
          seed: '',
          boardDigest: null,
          now: 't',
          rowsPerMember: 1,
          clientId,
        });
      add(5);
      add(7); // over the cap of one: the worst goes
      const best = store.bestOf(gameId, 'p', 'm')!;
      issued.length = 0;
      store.rankOf(gameId, 'p', best, 1000);
      // Both counts are ranges on the value, not the whole table (an OR of the two was).
      expect(plans()).toEqual(
        [
          [
            expect.stringMatching(
              /ranking_entries_table \(game_id=\? AND params_key=\? AND value[<>]\?\)/,
            ),
          ],
          [
            expect.stringMatching(
              /ranking_entries_table \(game_id=\? AND params_key=\? AND value=\? AND seq<\?\)/,
            ),
          ],
        ].map((plan) => ['CO-ROUTINE (subquery-1)', ...plan, 'SCAN (subquery-1)']),
      );
      issued.length = 0;
      add(6);
      store.standing(gameId, 'p', best, 50);
      store.rankingsMine('m', 50);
      store.removeRankingEntryById(gameId, 'p', 'm', best.seq);
      store.removeRankingEntries(gameId, 'p', 'm');
      // A keyed result, then the same key again: the first finds no row and stores one, the
      // second finds it by the key's own index and answers with it, writing nothing.
      const first = add(1, `client-key-${gameId}`);
      const again = add(1, `client-key-${gameId}`);
      expect(first).toMatchObject({ duplicate: false, entryCount: 1 });
      expect(again).toMatchObject({ duplicate: true, improved: false, entryCount: 1 });
      expect(again.entry?.seq).toBe(first.entry?.seq);
      const read = plans();
      expect(read.length).toBeGreaterThan(15);
      for (const plan of read) {
        const text = plan.join(' | ');
        expect(text).not.toMatch(/SCAN ranking_entries|TEMP B-TREE/);
        // The key lookup is an equality on the partial unique index (one row); the rest of a
        // member's reads walk `ranking_entries_member`.
        if (/client_id=/.test(text)) {
          expect(text).toMatch(/ranking_entries_client \(member_id=\? AND client_id=\?\)/);
        } else if (/member_id=/.test(text)) {
          expect(text).toContain('ranking_entries_member');
        }
      }
      // It ran for the two sends with the key (the first finds nothing, the second the row).
      expect(read.filter((plan) => /client_id=/.test(plan.join(' | ')))).toHaveLength(2);
    }
  });

  it('refuses a database newer than this server', () => {
    dir = mkdtempSync(join(tmpdir(), 'sg-club-migrate-'));
    db = new DatabaseSync(join(dir, 'club.sqlite'));
    const d: SqlDriver = {
      exec: (script) => db.exec(script),
      run: (sql, ...params) => {
        db.prepare(sql).run(...params);
      },
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
    };
    d.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    d.run(`INSERT INTO meta VALUES ('schema_version', '99')`);
    expect(() => migrate(d)).toThrow(/newer than this server/);
  });
});
