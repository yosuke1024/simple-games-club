import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
let yoh: Session;
let ken: Session;
let mai: Session;
beforeEach(async () => {
  server = await startServer();
  yoh = await claimOwner(server, 'Yoh');
  ken = await joinMember(server, yoh, 'Ken', '203.0.113.10');
  mai = await joinMember(server, yoh, 'Mai', '203.0.113.11');
});
afterEach(() => server.close());

const send = (
  session: Session,
  facts: Record<string, unknown>,
  over: Record<string, unknown> = {},
) =>
  server.api('/api/v1/rankings/results', {
    token: session.token,
    body: {
      gameId: 'sudoku',
      contractVersion: 1,
      paramsKey: 'hard',
      params: { difficulty: 'hard' },
      seed: 'seed-1',
      boardDigest: 'xx1:00000000',
      outcome: 'completed',
      facts,
      ...over,
    },
  });

describe('POST /api/v1/rankings/results (club.md §16)', () => {
  it('inserts a first row: 201, the facts echoed, no rank', async () => {
    const reply = await send(yoh, { elapsedSeconds: 300, mistakes: 1 });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      gameId: 'sudoku',
      paramsKey: 'hard',
      improved: true,
      entryCount: 1,
      entry: {
        memberId: yoh.memberId,
        nickname: 'Yoh',
        submittedAt: expect.any(String),
        facts: { elapsedSeconds: 300, mistakes: 1 },
        seed: 'seed-1',
        boardDigest: 'xx1:00000000',
      },
    });
  });

  it('ranks a faster member first; keeps the better of one member; ties keep the earlier row', async () => {
    await send(yoh, { elapsedSeconds: 300 });
    const faster = await send(ken, { elapsedSeconds: 250 });
    expect(faster.json).toMatchObject({ entryCount: 2, improved: true });
    const worse = await send(yoh, { elapsedSeconds: 400 });
    expect(worse.status).toBe(200);
    expect(worse.json).toMatchObject({ improved: false, entryCount: 2 });
    expect(worse.json.entry.facts).toEqual({ elapsedSeconds: 300 });
    const equal = await send(yoh, { elapsedSeconds: 300, mistakes: 9 });
    expect(equal.status).toBe(200);
    expect(equal.json.entry.facts).toEqual({ elapsedSeconds: 300 });
    const better = await send(yoh, { elapsedSeconds: 200 });
    expect(better.status).toBe(201);
    expect(better.json).toMatchObject({ improved: true, entryCount: 2 });
    // A tie across members goes to whoever got there first.
    server.clock.advance(1000);
    const tie = await send(mai, { elapsedSeconds: 200 });
    expect(tie.json).toMatchObject({ improved: true, entryCount: 3 });
  });

  it('ranks the higher score first in a desc game and the lower first in hearts', async () => {
    const score = (session: Session, gameId: string, value: number) =>
      send(session, { score: value }, { gameId, paramsKey: 'default' });
    await score(yoh, '2048', 1000);
    await score(ken, '2048', 2000);
    expect((await score(yoh, '2048', 1500)).json).toMatchObject({ improved: true });
    expect((await score(yoh, '2048', 100)).json.improved).toBe(false);
    const names = async (gameId: string) =>
      (
        await server.api(`/api/v1/rankings/${gameId}/default`, { token: yoh.token })
      ).json.entries.map((e: { nickname: string }) => e.nickname);
    expect(await names('2048')).toEqual(['Ken', 'Yoh']);
    await score(yoh, 'hearts', 40);
    await score(ken, 'hearts', 10);
    await score(mai, 'hearts', 60);
    expect(await names('hearts')).toEqual(['Ken', 'Yoh', 'Mai']);
  });

  it('stores nothing for a played result and reports the current standing', async () => {
    const none = await send(yoh, {}, { outcome: 'played' });
    expect(none.status).toBe(200);
    expect(none.json).toEqual({
      gameId: 'sudoku',
      paramsKey: 'hard',
      improved: false,
      entry: null,
      entryCount: 0,
    });
    await send(yoh, { elapsedSeconds: 300 });
    const had = await send(yoh, { elapsedSeconds: 1 }, { outcome: 'played' });
    expect(had.status).toBe(200);
    expect(had.json).toMatchObject({ improved: false, entryCount: 1 });
    expect(had.json.entry.facts).toEqual({ elapsedSeconds: 300 });
  });

  it('orders equal values by arrival, not by member id, even in the same instant', async () => {
    // The clock is not advanced: every write shares one submittedAt.
    await send(mai, { elapsedSeconds: 100 });
    await send(ken, { elapsedSeconds: 100 });
    await send(yoh, { elapsedSeconds: 100 });
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: yoh.token });
    expect(table.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual([
      'Mai',
      'Ken',
      'Yoh',
    ]);
    expect(table.json.me.rank).toBe(3);
  });

  it('puts a replaced best behind an equal value that was already there', async () => {
    await send(ken, { elapsedSeconds: 100 });
    await send(yoh, { elapsedSeconds: 300 });
    await send(yoh, { elapsedSeconds: 100 }); // ties Ken, arrives later
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: yoh.token });
    expect(table.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual(['Ken', 'Yoh']);
    expect(table.json.me.rank).toBe(2);
    const list = await server.api('/api/v1/rankings', { token: yoh.token });
    expect(list.json[0].leader.nickname).toBe('Ken');
  });

  it('rejects an unknown game, a missing axis, a bad paramsKey and a bad version', async () => {
    expect((await send(yoh, { elapsedSeconds: 1 }, { gameId: 'chess' })).status).toBe(400);
    expect((await send(yoh, { elapsedSeconds: 1 }, { gameId: 'gomoku' })).status).toBe(400);
    // Ids of Object.prototype members pass the gameId shape and must not find a contract.
    for (const gameId of ['constructor', 'toString', 'hasownproperty', '__proto__']) {
      expect((await send(yoh, { undefined: 5 }, { gameId })).status, gameId).toBe(400);
    }
    expect((await send(yoh, { moves: 3 })).status).toBe(400);
    expect((await send(yoh, { elapsedSeconds: 'fast' })).status).toBe(400);
    expect((await send(yoh, { elapsedSeconds: 1 }, { paramsKey: 'Hard!' })).status).toBe(400);
    expect((await send(yoh, { elapsedSeconds: 1 }, { paramsKey: 'x'.repeat(41) })).status).toBe(
      400,
    );
    expect((await send(yoh, { elapsedSeconds: 1 }, { contractVersion: 2 })).status).toBe(501);
    expect((await send(yoh, { elapsedSeconds: 1 }, { boardDigest: '' })).status).toBe(400);
    expect((await send(yoh, { elapsedSeconds: 1 }, { outcome: 'won' })).status).toBe(400);
  });

  it('accepts a null boardDigest and an empty seed, and echoes them', async () => {
    // An arcade run names no board (club.md §16-1): no digest, and no seed either.
    const reply = await send(yoh, { elapsedSeconds: 5 }, { boardDigest: null, seed: '' });
    expect(reply.status).toBe(201);
    expect(reply.json.entry.boardDigest).toBeNull();
    expect(reply.json.entry.seed).toBe('');
  });

  it('requires a member', async () => {
    const reply = await server.api('/api/v1/rankings/results', { body: {} });
    expect(reply.status).toBe(401);
  });

  it('keeps the row and nickname of a removed member', async () => {
    await send(ken, { elapsedSeconds: 100 });
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: yoh.token });
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: yoh.token });
    expect(table.json.entries).toEqual([
      expect.objectContaining({ memberId: ken.memberId, nickname: 'Ken' }),
    ]);
  });
});

describe('GET /api/v1/rankings', () => {
  it('lists one row per table with its leader, direction-aware', async () => {
    await send(yoh, { elapsedSeconds: 300 });
    await send(ken, { elapsedSeconds: 250 });
    await send(yoh, { elapsedSeconds: 90 }, { paramsKey: 'easy' });
    await send(yoh, { score: 10 }, { gameId: '2048', paramsKey: 'classic' });
    await send(ken, { score: 70 }, { gameId: '2048', paramsKey: 'classic' });

    const reply = await server.api('/api/v1/rankings', { token: mai.token });
    expect(reply.status).toBe(200);
    expect(
      reply.json.map(
        (t: {
          gameId: string;
          paramsKey: string;
          entryCount: number;
          leader: { nickname: string };
        }) => [t.gameId, t.paramsKey, t.entryCount, t.leader.nickname],
      ),
    ).toEqual([
      ['2048', 'classic', 2, 'Ken'],
      ['sudoku', 'easy', 1, 'Yoh'],
      ['sudoku', 'hard', 2, 'Ken'],
    ]);
    expect(reply.json[2].leader).toEqual({
      memberId: ken.memberId,
      nickname: 'Ken',
      submittedAt: expect.any(String),
      facts: { elapsedSeconds: 250 },
      seed: 'seed-1',
      boardDigest: 'xx1:00000000',
    });
  });

  it('keeps the leader and count right through inserts, replacements and overtakes', async () => {
    const lead = async () => {
      const t = (await server.api('/api/v1/rankings', { token: mai.token })).json[0];
      return [t.leader.nickname, t.entryCount];
    };
    await send(yoh, { elapsedSeconds: 300 });
    expect(await lead()).toEqual(['Yoh', 1]);
    await send(ken, { elapsedSeconds: 300 }); // equal: the earlier leader stays
    expect(await lead()).toEqual(['Yoh', 2]);
    await send(yoh, { elapsedSeconds: 200 }); // the leader improves
    expect(await lead()).toEqual(['Yoh', 2]);
    await send(ken, { elapsedSeconds: 250 }); // a non-leader improves, not past
    expect(await lead()).toEqual(['Yoh', 2]);
    await send(ken, { elapsedSeconds: 200 }); // equal to the leader: behind
    expect(await lead()).toEqual(['Yoh', 2]);
    await send(ken, { elapsedSeconds: 150 }); // past the leader
    expect(await lead()).toEqual(['Ken', 2]);
    await send(mai, { elapsedSeconds: 100 });
    expect(await lead()).toEqual(['Mai', 3]);
    const records = await server.api('/api/v1/records', { token: mai.token });
    expect(records.json[0]).toMatchObject({ nickname: 'Mai', facts: { elapsedSeconds: 100 } });
  });

  it('is empty before anyone sends', async () => {
    expect((await server.api('/api/v1/rankings', { token: yoh.token })).json).toEqual([]);
  });
});

describe('GET /api/v1/rankings/:gameId/:paramsKey', () => {
  it('returns the top N, the total, and the viewer outside the top', async () => {
    await send(yoh, { elapsedSeconds: 100 });
    await send(ken, { elapsedSeconds: 200 });
    await send(mai, { elapsedSeconds: 300 });
    const reply = await server.api('/api/v1/rankings/sudoku/hard?top=2', { token: mai.token });
    expect(reply.status).toBe(200);
    expect(reply.json.gameId).toBe('sudoku');
    expect(reply.json.paramsKey).toBe('hard');
    expect(reply.json.entryCount).toBe(3);
    expect(reply.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual(['Yoh', 'Ken']);
    expect(reply.json.me).toEqual({
      rank: 3,
      entry: expect.objectContaining({ memberId: mai.memberId, facts: { elapsedSeconds: 300 } }),
    });
    const all = await server.api('/api/v1/rankings/sudoku/hard', { token: yoh.token });
    expect(all.json.entries).toHaveLength(3);
    expect(all.json.me.rank).toBe(1);
  });

  it('reports rank null below the scan ceiling, and still bounds entries by ?top', async () => {
    await server.reopen({ limits: { rankingRankScan: 2 } });
    const dana = await joinMember(server, yoh, 'Dana', '203.0.113.12');
    await send(yoh, { elapsedSeconds: 100 });
    await send(ken, { elapsedSeconds: 200 });
    await send(mai, { elapsedSeconds: 300 });
    await send(dana, { elapsedSeconds: 400 });
    const asDana = await server.api('/api/v1/rankings/sudoku/hard?top=1', { token: dana.token });
    expect(asDana.json.entryCount).toBe(4);
    expect(asDana.json.entries).toHaveLength(1);
    expect(asDana.json.me).toEqual({ rank: null, entry: expect.any(Object) });
    // One better row is under the ceiling of 2: the rank is known.
    const asKen = await server.api('/api/v1/rankings/sudoku/hard', { token: ken.token });
    expect(asKen.json.me.rank).toBe(2);
    // Two better rows reach the ceiling: unknown.
    const asMai = await server.api('/api/v1/rankings/sudoku/hard', { token: mai.token });
    expect(asMai.json.me.rank).toBeNull();
  });

  it('orders a desc game best first', async () => {
    await send(yoh, { score: 10 }, { gameId: 'yacht', paramsKey: 'cpu' });
    await send(ken, { score: 90 }, { gameId: 'yacht', paramsKey: 'cpu' });
    const reply = await server.api('/api/v1/rankings/yacht/cpu', { token: yoh.token });
    expect(reply.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual(['Ken', 'Yoh']);
    expect(reply.json.me.rank).toBe(2);
  });

  it('rejects a bad ?top and caps a large one', async () => {
    for (const top of ['0', 'abc', '-1', '1.5']) {
      const reply = await server.api(`/api/v1/rankings/sudoku/hard?top=${top}`, {
        token: yoh.token,
      });
      expect(reply.status).toBe(400);
    }
    expect(
      (await server.api('/api/v1/rankings/sudoku/hard?top=100000', { token: yoh.token })).status,
    ).toBe(200);
  });

  it('answers an unknown game or table as an empty one', async () => {
    for (const path of ['/api/v1/rankings/sudoku/nobody', '/api/v1/rankings/chess/x']) {
      const reply = await server.api(path, { token: yoh.token });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ entryCount: 0, entries: [], me: null });
    }
  });
});
