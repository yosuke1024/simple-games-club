import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type SqlDriver } from '../src/db/driver.js';
import { Store } from '../src/db/store.js';

/**
 * The member list's cursor (club.md §17-2) at the store: `MemberRow.seq` is the arrival number,
 * and a member just created carries the one a later read gives back — `GET /members?before=`
 * never sees the row `createMember` returned, but the type promises it is the same.
 */
let db: DatabaseSync;
afterEach(() => db.close());

function open(): Store {
  db = new DatabaseSync(':memory:');
  const driver: SqlDriver = {
    exec: (script) => db.exec(script),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
  };
  migrate(driver);
  return new Store(driver);
}

describe('MemberRow.seq', () => {
  it('is the number createMember returns and memberById reads, rising with each member', () => {
    const store = open();
    const made = ['a', 'b', 'c'].map((id) =>
      store.createMember(id, id.toUpperCase(), 'member', `hash-${id}`, 't'),
    );
    expect(made.map((m) => m.seq)).toEqual(made.map((m) => store.memberById(m.id)!.seq));
    expect(made[1]!.seq).toBeGreaterThan(made[0]!.seq);
    expect(made[2]!.seq).toBeGreaterThan(made[1]!.seq);
  });

  it('is the cursor membersBefore walks down from, skipping the removed', () => {
    const store = open();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) =>
      store.createMember(id, id.toUpperCase(), 'member', `hash-${id}`, 't'),
    );
    store.revokeMember('b', 't');
    expect(store.membersBefore(d!.seq, 10).map((m) => m.id)).toEqual(['c', 'a']);
    expect(store.membersBefore(d!.seq, 1).map((m) => m.id)).toEqual(['c']);
    // A removed member is a valid cursor: the page continues below them.
    expect(store.membersBefore(b!.seq, 10).map((m) => m.id)).toEqual(['a']);
    expect(store.membersBefore(a!.seq, 10)).toEqual([]);
    expect(c!.seq).toBeLessThan(d!.seq);
  });
});

describe('members_active (the partial index of the active members)', () => {
  it('is what newestMembers, membersBefore and countActive walk, so removed members cost nothing', () => {
    const store = open();
    for (const id of ['a', 'b', 'c']) {
      store.createMember(id, id.toUpperCase(), 'member', `hash-${id}`, 't');
    }
    store.revokeMember('b', 't');
    const plan = (sql: string, ...params: (string | number)[]) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String((row as { detail: string }).detail))
        .join(' | ');
    expect(
      plan(`SELECT * FROM members WHERE revoked_at IS NULL ORDER BY seq DESC LIMIT ?`, 50),
    ).toContain('members_active');
    expect(
      plan(
        `SELECT * FROM members WHERE revoked_at IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?`,
        3,
        50,
      ),
    ).toContain('members_active');
    expect(plan(`SELECT COUNT(*) AS n FROM members WHERE revoked_at IS NULL`)).toContain(
      'members_active',
    );
    expect(store.membersBefore(3, 10).map((m) => m.id)).toEqual(['a']);
    expect(store.countActive()).toBe(2);
  });
});
