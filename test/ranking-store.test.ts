import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type SqlDriver } from '../src/db/driver.js';
import { Store } from '../src/db/store.js';

/**
 * The ranking store (club.md §16-1) against a plain-array model, over random sequences of
 * every write the API can make: a result in (with or without a `clientId`, a key the model
 * treats as a no-op the second time the member sends it for as long as its row exists), one row
 * out, all of a member's rows in a table out, a member purged. After each step every read the API answers from — the count, the
 * leader, the top N, a member's best with its rank and the next value, "mine" — must equal
 * what sorting the model's rows gives. A seeded generator keeps a failure reproducible.
 */

interface Row {
  seq: number;
  member: string;
  value: number;
  /** The idempotency key the row was stored under, if the send had one. */
  clientId?: string;
}

const GAMES = [
  { gameId: 'sudoku', asc: true }, // elapsedSeconds, lower is better
  { gameId: '2048', asc: false }, // score, higher is better
];
const MODES = ['p', 'q'];
const MEMBERS = ['a', 'b', 'c', 'd'];
const CAP = 4;
const SCAN = 1000;
/** A small pool, so that a member sends the same key again — in the same table or another — often. */
const CLIENT_IDS = ['k1', 'k2', 'k3'];

let db: DatabaseSync;
afterEach(() => db.close());

/** mulberry32: a small seeded generator. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function open(): { driver: SqlDriver; store: Store } {
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
  for (const id of MEMBERS) {
    driver.run(
      `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, 'member', 't', ?)`,
      id,
      `N${id}`,
      `h${id}`,
    );
  }
  return { driver, store: new Store(driver) };
}

/** Best first; equal values by arrival. */
const order = (asc: boolean) => (x: Row, y: Row) =>
  (asc ? x.value - y.value : y.value - x.value) || x.seq - y.seq;

/** The model's drop at the cap: the member's worst row, the latest on a tie. */
const worstOf = (rows: Row[], asc: boolean): Row => [...rows].sort(order(asc)).at(-1)!;

describe('the ranking store against a model (club.md §16-1)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`agrees after every step (seed ${seed})`, () => {
      const { store } = open();
      const next = generator(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const tables = new Map<string, Row[]>();
      const keyOf = (gameId: string, paramsKey: string) => `${gameId}/${paramsKey}`;
      let counter = 0;
      /** The member's stored row that carries this key, in whichever table it is. */
      const keyed = (member: string, clientId: string | undefined) => {
        if (clientId === undefined) return undefined;
        for (const [key, list] of tables) {
          const row = list.find((r) => r.member === member && r.clientId === clientId);
          if (row !== undefined) return { key, row };
        }
        return undefined;
      };

      const check = (step: string) => {
        for (const { gameId, asc } of GAMES) {
          for (const paramsKey of MODES) {
            const rows = tables.get(keyOf(gameId, paramsKey)) ?? [];
            const sorted = [...rows].sort(order(asc));
            const label = `${step} ${gameId}/${paramsKey}`;
            expect(store.rankingCount(gameId, paramsKey), label).toBe(rows.length);
            expect(
              store.rankingTop(gameId, paramsKey, 100).map((e) => e.seq),
              label,
            ).toEqual(sorted.map((r) => r.seq));
            const cut = 1 + Math.floor(next() * 5);
            expect(
              store.rankingTop(gameId, paramsKey, cut).map((e) => e.seq),
              `${label} top ${cut}`,
            ).toEqual(sorted.slice(0, cut).map((r) => r.seq));
            const listed = store
              .rankingTables()
              .find((t) => t.gameId === gameId && t.paramsKey === paramsKey);
            if (rows.length === 0) expect(listed, label).toBeUndefined();
            else {
              expect(listed?.entryCount, label).toBe(rows.length);
              expect(listed?.leader.seq, label).toBe(sorted[0]!.seq);
            }
            for (const member of MEMBERS) {
              const mine = sorted.filter((r) => r.member === member);
              const best = store.bestOf(gameId, paramsKey, member);
              expect(best?.seq ?? null, `${label} best of ${member}`).toBe(mine[0]?.seq ?? null);
              if (best === null) continue;
              const standing = store.standing(gameId, paramsKey, best, SCAN);
              expect(standing.rank, `${label} rank of ${member}`).toBe(
                sorted.findIndex((r) => r.seq === best.seq) + 1,
              );
              const better = sorted
                .filter((r) => (asc ? r.value < best.value : r.value > best.value))
                .map((r) => r.value);
              expect(standing.nextValue, `${label} next of ${member}`).toBe(
                better.length === 0 ? null : asc ? Math.max(...better) : Math.min(...better),
              );
              // Counting to a ceiling: the exact rank below it, null at or past it.
              const ceiling = 1 + Math.floor(next() * 6);
              const rank = sorted.findIndex((r) => r.seq === best.seq) + 1;
              expect(store.rankOf(gameId, paramsKey, best, ceiling), `${label} ceiling`).toBe(
                rank <= ceiling ? rank : null,
              );
            }
          }
        }
        for (const member of MEMBERS) {
          const expected = [...tables.entries()]
            .filter(([, rows]) => rows.some((r) => r.member === member))
            .map(([key]) => key)
            .sort((x, y) => {
              const [gx, px] = x.split('/') as [string, string];
              const [gy, py] = y.split('/') as [string, string];
              return gx < gy ? -1 : gx > gy ? 1 : px < py ? -1 : px > py ? 1 : 0;
            });
          const mine = store.rankingsMine(member, SCAN);
          expect(
            mine.map((t) => keyOf(t.gameId, t.paramsKey)),
            `${step} mine of ${member}`,
          ).toEqual(expected);
          for (const t of mine) {
            const rows = tables.get(keyOf(t.gameId, t.paramsKey))!;
            const asc = GAMES.find((g) => g.gameId === t.gameId)!.asc;
            const sorted = [...rows].sort(order(asc));
            expect(t.entryCount, `${step} mine count`).toBe(rows.length);
            expect(t.leader.seq, `${step} mine leader`).toBe(sorted[0]!.seq);
            expect(t.best.entry.seq, `${step} mine best`).toBe(
              sorted.find((r) => r.member === member)!.seq,
            );
          }
        }
        expect(
          store.popularRankingTables(100).reduce((sum, t) => sum + t.entryCount, 0),
          `${step} popular`,
        ).toBe([...tables.values()].reduce((sum, rows) => sum + rows.length, 0));
      };

      for (let step = 1; step <= 150; step++) {
        const { gameId, asc } = pick(GAMES);
        const paramsKey = pick(MODES);
        const key = keyOf(gameId, paramsKey);
        const rows = tables.get(key) ?? [];
        const member = pick(MEMBERS);
        const roll = next();
        let what: string;
        if (roll < 0.7) {
          // A few values only, so that ties — equal to the member's own row, or another's — are common.
          const value = 1 + Math.floor(next() * 6);
          const mine = rows.filter((r) => r.member === member);
          const improves = mine.every((r) => (asc ? value < r.value : value > r.value));
          // Without a key about a third of the time (a client from before it); else one of three.
          const clientId = next() < 0.35 ? undefined : pick(CLIENT_IDS);
          const stored = keyed(member, clientId);
          const added = store.addRanking({
            gameId,
            paramsKey,
            memberId: member,
            nickname: `N${member}`,
            value,
            facts: { value },
            seed: '',
            boardDigest: null,
            now: 't',
            rowsPerMember: CAP,
            clientId,
          });
          if (stored !== undefined) {
            // The member's row with this key is there: nothing is written, whatever the value
            // or the table named now, and the answer is that row in its own table.
            what = `resend ${member} ${clientId} (${value} -> ${key}) of #${stored.row.seq} in ${stored.key}`;
            expect(added.duplicate, what).toBe(true);
            expect(added.improved, what).toBe(false);
            expect(added.entry?.seq ?? null, what).toBe(stored.row.seq);
            expect(`${added.gameId}/${added.paramsKey}`, what).toBe(stored.key);
            expect(added.entryCount, what).toBe(tables.get(stored.key)!.length);
          } else {
            const row: Row = { seq: ++counter, member, value, clientId };
            const kept = [...rows, row];
            const own = kept.filter((r) => r.member === member);
            let dropped: Row | null = null;
            if (own.length > CAP) {
              dropped = worstOf(own, asc);
              kept.splice(kept.indexOf(dropped), 1);
            }
            tables.set(key, kept);
            what = `add ${member} ${value} ${clientId ?? '-'} -> ${key}`;
            expect(added.duplicate, what).toBe(false);
            expect(`${added.gameId}/${added.paramsKey}`, what).toBe(key);
            expect(added.entry?.seq ?? null, what).toBe(dropped === row ? null : row.seq);
            expect(added.improved, what).toBe(dropped === row ? false : improves);
            expect(added.entryCount, what).toBe(kept.length);
            if (dropped === null || dropped !== row) {
              expect(added.entry?.value, what).toBe(value);
            }
          }
        } else if (roll < 0.88) {
          const mine = rows.filter((r) => r.member === member);
          // Sometimes an id that is not theirs (another member's, or one that never was).
          const others: { seq: number }[] = rows.length === 0 ? [{ seq: 999 }] : rows;
          const own: { seq: number }[] = mine.length === 0 ? [{ seq: 998 }] : mine;
          const target = next() < 0.25 ? pick(others) : pick(own);
          const owned = mine.some((r) => r.seq === target.seq);
          what = `delete ${member} #${target.seq} in ${key}`;
          expect(store.removeRankingEntryById(gameId, paramsKey, member, target.seq), what).toBe(
            owned,
          );
          if (owned)
            tables.set(
              key,
              rows.filter((r) => r.seq !== target.seq),
            );
        } else if (roll < 0.96) {
          const had = rows.some((r) => r.member === member);
          what = `delete all of ${member} in ${key}`;
          expect(store.removeRankingEntries(gameId, paramsKey, member), what).toBe(had);
          tables.set(
            key,
            rows.filter((r) => r.member !== member),
          );
        } else {
          what = `purge ${member}`;
          store.purgeMember(member);
          for (const [k, list] of tables)
            tables.set(
              k,
              list.filter((r) => r.member !== member),
            );
        }
        for (const [k, list] of tables) if (list.length === 0) tables.delete(k);
        check(`#${step} ${what}`);
      }
    }, 60_000);
  }
});

describe('the cap after it was lowered (club.md §16-1)', () => {
  it('drops every row past the new cap at the next write, worst first', () => {
    const { store } = open();
    const add = (value: number, rowsPerMember: number) =>
      store.addRanking({
        gameId: 'sudoku',
        paramsKey: 'p',
        memberId: 'a',
        nickname: 'Na',
        value,
        facts: { elapsedSeconds: value },
        seed: '',
        boardDigest: null,
        now: 't',
        rowsPerMember,
      });
    for (const value of [50, 10, 40, 20, 30]) add(value, 50);
    expect(store.rankingCount('sudoku', 'p')).toBe(5);
    // The cap is now 2: the new row and the three worst of the old ones go in one write.
    const reply = add(60, 2);
    expect(reply.entry).toBeNull();
    expect(reply.improved).toBe(false);
    expect(reply.entryCount).toBe(2);
    expect(store.rankingTop('sudoku', 'p', 10).map((row) => row.value)).toEqual([10, 20]);
    expect(store.rankingCount('sudoku', 'p')).toBe(2);
  });
});
