import { afterEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
afterEach(() => server.close());

type Row = { memberId: string; nickname: string; outcome: string; facts: Record<string, unknown> };

let ip = 0;
/** An owner and `names.length` members, in that arrival order. */
const club = async (names: string[]): Promise<Session[]> => {
  const owner = await claimOwner(server, 'Owner');
  const members = [];
  for (const name of names)
    members.push(await joinMember(server, owner, name, `203.0.113.${++ip}`));
  return [owner, ...members];
};

const create = (
  session: Session,
  gameId: string,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      params: {},
      seed: `seed-${gameId}`,
      boardDigest: `dg:${gameId}`,
      title: null,
      daily: null,
      result: { outcome, facts },
    },
  });

const answer = (
  session: Session,
  id: string,
  gameId: string,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api(`/api/v1/challenges/${id}/results`, {
    token: session.token,
    body: { contractVersion: 1, boardDigest: `dg:${gameId}`, outcome, facts },
  });

const results = async (session: Session, id: string): Promise<Row[]> => {
  const reply = await server.api(`/api/v1/challenges/${id}/results`, { token: session.token });
  expect(reply.status).toBe(200);
  return reply.json as Row[];
};
const names = (rows: Row[]) => rows.map((row) => row.nickname);

describe('GET /api/v1/challenges/:id/results — best first (club.md §5-3)', () => {
  it('orders a lower-is-better game by its axis, ties by arrival', async () => {
    server = await startServer();
    const [owner, ken, mai, sam, lee] = await club(['Ken', 'Mai', 'Sam', 'Lee']);
    const first = await create(owner!, 'sudoku', { elapsedSeconds: 300 });
    const id = first.json.id;
    await answer(ken!, id, 'sudoku', { elapsedSeconds: 250 });
    await answer(mai!, id, 'sudoku', { elapsedSeconds: 300 }); // ties the owner, arrived later
    await answer(sam!, id, 'sudoku', { elapsedSeconds: 90 });
    await answer(lee!, id, 'sudoku', { elapsedSeconds: 250 }); // ties Ken, arrived later
    expect(names(await results(owner!, id))).toEqual(['Sam', 'Ken', 'Lee', 'Owner', 'Mai']);
  });

  it('orders a higher-is-better game the other way round, and keeps a zero score in place', async () => {
    server = await startServer();
    const [owner, ken, mai, sam] = await club(['Ken', 'Mai', 'Sam']);
    const id = (await create(owner!, '2048', { score: 0 })).json.id;
    await answer(ken!, id, '2048', { score: 2048 });
    await answer(mai!, id, '2048', { score: 512 });
    await answer(sam!, id, '2048', { score: 512 }); // ties Mai, arrived later
    const rows = await results(owner!, id);
    expect(names(rows)).toEqual(['Ken', 'Mai', 'Sam', 'Owner']);
    expect(rows.map((row) => row.facts.score)).toEqual([2048, 512, 512, 0]);
  });

  it('puts completed results before played ones, and played ones in arrival order', async () => {
    server = await startServer();
    const [owner, ken, mai, sam] = await club(['Ken', 'Mai', 'Sam']);
    const id = (await create(owner!, 'sudoku', {}, 'played')).json.id; // the creator lost
    await answer(ken!, id, 'sudoku', { elapsedSeconds: 800 });
    await answer(mai!, id, 'sudoku', {}, 'played');
    await answer(sam!, id, 'sudoku', { elapsedSeconds: 100 });
    const rows = await results(owner!, id);
    expect(names(rows)).toEqual(['Sam', 'Ken', 'Owner', 'Mai']);
    expect(rows.map((row) => row.outcome)).toEqual(['completed', 'completed', 'played', 'played']);
  });

  it('puts a completed result without a usable axis after those with one and before the played', async () => {
    server = await startServer();
    const [owner, ken, mai, sam] = await club(['Ken', 'Mai', 'Sam']);
    const id = (await create(owner!, 'sudoku', {}, 'played')).json.id;
    await answer(ken!, id, 'sudoku', { mistakes: 2 }); // completed, no elapsedSeconds
    await answer(mai!, id, 'sudoku', { elapsedSeconds: 'fast' }); // completed, not a number
    await answer(sam!, id, 'sudoku', { elapsedSeconds: 999 });
    expect(names(await results(owner!, id))).toEqual(['Sam', 'Ken', 'Mai', 'Owner']);
  });

  it('keeps arrival order for a game the server has no axis for', async () => {
    server = await startServer();
    const [owner, ken, mai] = await club(['Ken', 'Mai']);
    const id = (await create(owner!, 'checkers', { turns: 40 })).json.id;
    await answer(ken!, id, 'checkers', {}, 'played');
    await answer(mai!, id, 'checkers', { turns: 10 });
    // Completed before played; no axis, so arrival within each.
    expect(names(await results(owner!, id))).toEqual(['Owner', 'Mai', 'Ken']);
  });

  it("gives the best N, and always the asker's own row after them when it ranks lower", async () => {
    server = await startServer({ limits: { resultsPage: 3 } });
    const [owner, ...rest] = await club(['A', 'B', 'C', 'D', 'E']);
    const [a, b, c, d, e] = rest;
    // Seconds: A 50, B 60, C 70, D 80, E 90, Owner 100 — six results, a page of three.
    const id = (await create(owner!, 'sudoku', { elapsedSeconds: 100 })).json.id;
    for (const [session, seconds] of [
      [a, 50],
      [b, 60],
      [c, 70],
      [d, 80],
      [e, 90],
    ] as const) {
      await answer(session!, id, 'sudoku', { elapsedSeconds: seconds });
    }
    // The best three, nothing more, for someone who is among them…
    expect(names(await results(a!, id))).toEqual(['A', 'B', 'C']);
    expect(names(await results(c!, id))).toEqual(['A', 'B', 'C']);
    // …and the best three, then their own, for everyone else.
    expect(names(await results(d!, id))).toEqual(['A', 'B', 'C', 'D']);
    expect(names(await results(e!, id))).toEqual(['A', 'B', 'C', 'E']);
    expect(names(await results(owner!, id))).toEqual(['A', 'B', 'C', 'Owner']);
    // Within the page the answer is the same set whoever asks; only the tail differs.
    const own = (await results(owner!, id)).at(-1)!;
    expect(own).toMatchObject({ memberId: owner!.memberId, facts: { elapsedSeconds: 100 } });
  });

  it("does not repeat the asker's row, and a member with no row gets just the best N", async () => {
    server = await startServer({ limits: { resultsPage: 2 } });
    const [owner, ken, mai, sam] = await club(['Ken', 'Mai', 'Sam']);
    const id = (await create(owner!, 'sudoku', { elapsedSeconds: 10 })).json.id;
    await answer(ken!, id, 'sudoku', { elapsedSeconds: 20 });
    await answer(mai!, id, 'sudoku', { elapsedSeconds: 30 });
    const stranger = await results(sam!, id); // Sam sent nothing
    expect(names(stranger)).toEqual(['Owner', 'Ken']);
    expect(names(await results(owner!, id))).toEqual(['Owner', 'Ken']);
    expect(names(await results(mai!, id))).toEqual(['Owner', 'Ken', 'Mai']);
  });

  it("puts an asker's played result after the best N too", async () => {
    server = await startServer({ limits: { resultsPage: 2 } });
    const [owner, ken, mai, sam] = await club(['Ken', 'Mai', 'Sam']);
    const id = (await create(owner!, '2048', { score: 100 })).json.id;
    await answer(ken!, id, '2048', { score: 300 });
    await answer(mai!, id, '2048', { score: 200 });
    await answer(sam!, id, '2048', {}, 'played');
    expect(names(await results(sam!, id))).toEqual(['Ken', 'Mai', 'Sam']);
    expect(names(await results(owner!, id))).toEqual(['Ken', 'Mai', 'Owner']);
  });

  it('keeps the Result shape and the 404 for a challenge that is not there', async () => {
    server = await startServer();
    const [owner] = await club([]);
    const id = (await create(owner!, 'sudoku', { elapsedSeconds: 5 })).json.id;
    const [row] = await results(owner!, id);
    expect(Object.keys(row!).sort()).toEqual([
      'facts',
      'memberId',
      'nickname',
      'outcome',
      'submittedAt',
    ]);
    const missing = await server.api('/api/v1/challenges/ch_nope/results', { token: owner!.token });
    expect(missing.status).toBe(404);
  });

  it('reads a bounded number of rows however many members answered (Workers)', async () => {
    server = await startServer({
      limits: { resultsPage: 5, ipPerMinute: 100000, memberPerMinute: 100000, maxMembers: 1000 },
    });
    const owner = await claimOwner(server, 'Owner');
    const id = (await create(owner, 'sudoku', { elapsedSeconds: 1000 })).json.id;
    const rowsRead = async (): Promise<number | null> => {
      const reply = await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token });
      const match = /read=(\d+)/.exec(reply.headers.get('x-club-rows') ?? '');
      return match === null ? null : Number(match[1]);
    };
    const join = async (n: number) => {
      const session = await joinMember(server, owner, `P${n}`, `198.51.100.${(n % 250) + 1}`);
      await answer(session, id, 'sudoku', { elapsedSeconds: 100 + n });
    };
    for (let n = 0; n < 10; n++) await join(n);
    const small = await rowsRead();
    for (let n = 10; n < 60; n++) await join(n);
    const large = await rowsRead();
    if (small === null || large === null) return; // Node reports no rows
    // Six rows are returned (five and the asker's own) whatever the number submitted.
    expect(large).toBeLessThanOrEqual(small + 4);
    expect(large).toBeLessThan(40);
  });
});
