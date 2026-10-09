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

const table = (session: Session, path = 'sudoku/hard') =>
  server.api(`/api/v1/rankings/${path}`, { token: session.token });

/** A table's rows as `nickname value` (the axis of the game), top to bottom. */
const rows = async (session: Session, path = 'sudoku/hard', axis = 'elapsedSeconds') =>
  (await table(session, `${path}?top=100`)).json.entries.map(
    (e: { nickname: string; facts: Record<string, number> }) => `${e.nickname} ${e.facts[axis]}`,
  );

const deleteEntry = (session: Session | undefined, id: string, path = 'sudoku/hard') =>
  server.api(`/api/v1/rankings/${path}/entries/${id}`, { method: 'DELETE', token: session?.token });

describe('POST /api/v1/rankings/results (club.md §16)', () => {
  it('inserts a first row: 201, the facts echoed with the row id, no rank', async () => {
    const reply = await send(yoh, { elapsedSeconds: 300, mistakes: 1 });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      gameId: 'sudoku',
      paramsKey: 'hard',
      improved: true,
      entryCount: 1,
      entry: {
        id: expect.stringMatching(/^[1-9][0-9]*$/),
        memberId: yoh.memberId,
        nickname: 'Yoh',
        submittedAt: expect.any(String),
        facts: { elapsedSeconds: 300, mistakes: 1 },
        seed: 'seed-1',
        boardDigest: 'xx1:00000000',
      },
    });
  });

  it('keeps every finished game as its own row; improved only when strictly better than the member’s other rows', async () => {
    const first = await send(yoh, { elapsedSeconds: 300 });
    expect(first.json).toMatchObject({ improved: true, entryCount: 1 });
    const faster = await send(ken, { elapsedSeconds: 250 });
    expect(faster.json).toMatchObject({ entryCount: 2, improved: true });
    // A worse game is a second row of Yoh's, not a no-op.
    const worse = await send(yoh, { elapsedSeconds: 400 });
    expect(worse.status).toBe(201);
    expect(worse.json).toMatchObject({ improved: false, entryCount: 3 });
    expect(worse.json.entry.facts).toEqual({ elapsedSeconds: 400 });
    // Equal to his best: a row, but no improvement.
    const equal = await send(yoh, { elapsedSeconds: 300, mistakes: 9 });
    expect(equal.status).toBe(201);
    expect(equal.json).toMatchObject({ improved: false, entryCount: 4 });
    expect(equal.json.entry.facts).toEqual({ elapsedSeconds: 300, mistakes: 9 });
    const better = await send(yoh, { elapsedSeconds: 200 });
    expect(better.status).toBe(201);
    expect(better.json).toMatchObject({ improved: true, entryCount: 5 });
    // Every row has its own id, in arrival order.
    const ids = [first, faster, worse, equal, better].map((r) => Number(r.json.entry.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(5);

    expect(await rows(mai)).toEqual(['Yoh 200', 'Ken 250', 'Yoh 300', 'Yoh 300', 'Yoh 400']);
    const asYoh = await table(yoh);
    expect(asYoh.json.entryCount).toBe(5);
    expect(asYoh.json.me).toEqual({
      rank: 1,
      entry: expect.objectContaining({ id: better.json.entry.id, facts: { elapsedSeconds: 200 } }),
      nextValue: null,
    });
  });

  it('ranks the higher score first in a desc game and the lower first in hearts', async () => {
    const score = (session: Session, gameId: string, value: number) =>
      send(session, { score: value }, { gameId, paramsKey: 'default' });
    await score(yoh, '2048', 1000);
    await score(ken, '2048', 2000);
    expect((await score(yoh, '2048', 1500)).json).toMatchObject({ improved: true });
    expect((await score(yoh, '2048', 100)).json.improved).toBe(false);
    expect((await score(yoh, '2048', 1500)).json.improved).toBe(false);
    expect(await rows(yoh, '2048/default', 'score')).toEqual([
      'Ken 2000',
      'Yoh 1500',
      'Yoh 1500',
      'Yoh 1000',
      'Yoh 100',
    ]);
    await score(yoh, 'hearts', 40);
    await score(ken, 'hearts', 10);
    await score(mai, 'hearts', 60);
    await score(ken, 'hearts', 50);
    expect(await rows(yoh, 'hearts/default', 'score')).toEqual([
      'Ken 10',
      'Yoh 40',
      'Ken 50',
      'Mai 60',
    ]);
  });

  it("stores nothing for a played result and reports the member's best row as it stands", async () => {
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
    await send(yoh, { elapsedSeconds: 200 });
    const had = await send(yoh, { elapsedSeconds: 1 }, { outcome: 'played' });
    expect(had.status).toBe(200);
    expect(had.json).toMatchObject({ improved: false, entryCount: 2 });
    expect(had.json.entry.facts).toEqual({ elapsedSeconds: 200 });
  });

  it('orders equal values by arrival, not by member id, even in the same instant', async () => {
    // The clock is not advanced: every write shares one submittedAt.
    await send(mai, { elapsedSeconds: 100 });
    await send(ken, { elapsedSeconds: 100 });
    await send(yoh, { elapsedSeconds: 100 });
    await send(mai, { elapsedSeconds: 100 }); // a second row of Mai's, behind them all
    expect(await rows(yoh)).toEqual(['Mai 100', 'Ken 100', 'Yoh 100', 'Mai 100']);
    expect((await table(yoh)).json.me.rank).toBe(3);
    // Mai's best is her first row, not the later equal one.
    expect((await table(mai)).json.me.rank).toBe(1);
  });

  it('puts a later equal row behind an earlier one, the same member’s or another’s', async () => {
    await send(ken, { elapsedSeconds: 100 });
    await send(yoh, { elapsedSeconds: 300 });
    await send(yoh, { elapsedSeconds: 100 }); // ties Ken, arrives later
    expect(await rows(yoh)).toEqual(['Ken 100', 'Yoh 100', 'Yoh 300']);
    expect((await table(yoh)).json.me).toMatchObject({ rank: 2, nextValue: null });
    const list = await server.api('/api/v1/rankings', { token: yoh.token });
    expect(list.json[0]).toMatchObject({ entryCount: 3, leader: { nickname: 'Ken' } });
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
    // None of them stored anything.
    expect((await server.api('/api/v1/rankings', { token: yoh.token })).json).toEqual([]);
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

  it('keeps the rows and nickname of a removed member', async () => {
    await send(ken, { elapsedSeconds: 100 });
    await send(ken, { elapsedSeconds: 120 });
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: yoh.token });
    const reply = await table(yoh);
    expect(reply.json.entries).toEqual([
      expect.objectContaining({ memberId: ken.memberId, nickname: 'Ken' }),
      expect.objectContaining({ memberId: ken.memberId, nickname: 'Ken' }),
    ]);
  });
});

describe('clientId — a result sent again is one row (club.md §16-1)', () => {
  const KEY = 'ab12CD34_-xyz'; // 8..64 of A-Za-z0-9_-

  it('answers a second send of the same member’s same clientId with 200 and the first row, and writes nothing', async () => {
    const first = await send(yoh, { elapsedSeconds: 300, mistakes: 1 }, { clientId: KEY });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ improved: true, entryCount: 1 });

    // The answer was lost; the outbox sends the same body again.
    const again = await send(yoh, { elapsedSeconds: 300, mistakes: 1 }, { clientId: KEY });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({
      gameId: 'sudoku',
      paramsKey: 'hard',
      improved: false, // a resend never claims the improvement a second time
      entryCount: 1,
      entry: first.json.entry, // the same row: same id, same facts, same time
    });
    expect(await rows(yoh)).toEqual(['Yoh 300']);

    // Nothing was spent on it: the next new row is the very next id.
    const next = await send(ken, { elapsedSeconds: 400 });
    expect(Number(next.json.entry.id)).toBe(Number(first.json.entry.id) + 1);

    // A resend after others have come in counts the table as it is now; the row is still the first.
    const later = await send(yoh, { elapsedSeconds: 300, mistakes: 1 }, { clientId: KEY });
    expect(later.status).toBe(200);
    expect(later.json).toMatchObject({ improved: false, entryCount: 2 });
    expect(later.json.entry).toEqual(first.json.entry);
    expect(await rows(yoh)).toEqual(['Yoh 300', 'Ken 400']);
  });

  it('keeps the first row whatever the resend says: the body is not compared, the key decides', async () => {
    const first = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    const again = await send(yoh, { elapsedSeconds: 10 }, { clientId: KEY });
    expect(again.status).toBe(200);
    expect(again.json.entry).toEqual(first.json.entry);
    expect(again.json.entry.facts).toEqual({ elapsedSeconds: 300 });
    expect(await rows(yoh)).toEqual(['Yoh 300']);
  });

  it('answers with the stored row’s own table when a key is reused for another one', async () => {
    const first = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    const other = await send(yoh, { elapsedSeconds: 90 }, { clientId: KEY, paramsKey: 'easy' });
    expect(other.status).toBe(200);
    expect(other.json).toMatchObject({ gameId: 'sudoku', paramsKey: 'hard', entryCount: 1 });
    expect(other.json.entry).toEqual(first.json.entry);
    // Nothing went into 'easy'.
    expect((await table(yoh, 'sudoku/easy')).json.entryCount).toBe(0);
  });

  it('stores two results with different clientIds even when their facts are identical', async () => {
    const one = await send(yoh, { elapsedSeconds: 300 }, { clientId: 'result-one-0001' });
    const two = await send(yoh, { elapsedSeconds: 300 }, { clientId: 'result-two-0002' });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.json.entryCount).toBe(2);
    expect(two.json.entry.id).not.toBe(one.json.entry.id);
    expect(await rows(yoh)).toEqual(['Yoh 300', 'Yoh 300']);
  });

  it('keeps the key per member: two members with the same clientId have a row each', async () => {
    const a = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    const b = await send(ken, { elapsedSeconds: 300 }, { clientId: KEY });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.entryCount).toBe(2);
    expect(b.json.entry.memberId).toBe(ken.memberId);
    expect(await rows(mai)).toEqual(['Yoh 300', 'Ken 300']);
    // Each one's resend finds their own.
    const again = await send(ken, { elapsedSeconds: 300 }, { clientId: KEY });
    expect(again.status).toBe(200);
    expect(again.json.entry).toEqual(b.json.entry);
  });

  it('still inserts every time when there is no clientId (a client from before the key)', async () => {
    const one = await send(yoh, { elapsedSeconds: 300 });
    const two = await send(yoh, { elapsedSeconds: 300 });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.json.entryCount).toBe(2);
    expect(await rows(yoh)).toEqual(['Yoh 300', 'Yoh 300']);
    // A rowless key and a keyed row do not meet either.
    const keyed = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    expect(keyed.status).toBe(201);
    expect(keyed.json.entryCount).toBe(3);
  });

  it('accepts 8..64 characters of A-Za-z0-9_- and refuses everything else with a 400 that stores nothing', async () => {
    for (const ok of ['abcdefgh', 'ABCD_-09', 'x'.repeat(64)]) {
      const reply = await send(yoh, { elapsedSeconds: 300 }, { clientId: ok });
      expect(reply.status, ok).toBe(201);
    }
    expect((await table(yoh)).json.entryCount).toBe(3);

    const bad: unknown[] = [
      'abcdefg', // 7
      'x'.repeat(65),
      '',
      'abcdefg!',
      'has space1',
      'dots.dots.1',
      'ünicode-12',
      'line\nbreak1',
      12345678,
      null,
      ['abcdefgh'],
      { id: 'abcdefgh' },
      true,
    ];
    for (const clientId of bad) {
      const reply = await send(yoh, { elapsedSeconds: 1 }, { clientId });
      expect(reply.status, JSON.stringify(clientId)).toBe(400);
      expect(reply.json.error.code).toBe('invalid_request');
    }
    expect((await table(yoh)).json.entryCount).toBe(3);
  });

  it('ignores a clientId on a played result: nothing is stored, nothing is remembered', async () => {
    const played = await send(yoh, {}, { outcome: 'played', clientId: KEY });
    expect(played.status).toBe(200);
    expect(played.json).toEqual({
      gameId: 'sudoku',
      paramsKey: 'hard',
      improved: false,
      entry: null,
      entryCount: 0,
    });
    // The same key on the completed result later is a first send.
    const done = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    expect(done.status).toBe(201);
    // Its shape is still checked, whatever the outcome.
    expect((await send(yoh, {}, { outcome: 'played', clientId: 'short' })).status).toBe(400);
  });

  it('after the cap: a resend of a dropped result is dropped again; a kept one answers with its row', async () => {
    await server.reopen({ limits: { rankingRowsPerMember: 2 } });
    const keep1 = await send(yoh, { elapsedSeconds: 100 }, { clientId: 'keep-one-0001' });
    const keep2 = await send(yoh, { elapsedSeconds: 200 }, { clientId: 'keep-two-0002' });
    expect(keep1.json.entry).not.toBeNull();
    expect(keep2.json.entry).not.toBeNull();

    // Worse than both: stored and dropped at once, so nothing carries its key.
    const lost = await send(yoh, { elapsedSeconds: 900 }, { clientId: 'dropped-0003' });
    expect(lost.status).toBe(201);
    expect(lost.json).toMatchObject({ entry: null, improved: false, entryCount: 2 });
    // Sent again it is the same answer — the same shape the first had — and the same table.
    const lostAgain = await send(yoh, { elapsedSeconds: 900 }, { clientId: 'dropped-0003' });
    expect(lostAgain.status).toBe(201);
    expect(lostAgain.json).toEqual(lost.json);

    // A row that survived answers 200 with itself.
    const kept = await send(yoh, { elapsedSeconds: 200 }, { clientId: 'keep-two-0002' });
    expect(kept.status).toBe(200);
    expect(kept.json.entry).toEqual(keep2.json.entry);
    expect(kept.json.entryCount).toBe(2);
    expect(await rows(yoh)).toEqual(['Yoh 100', 'Yoh 200']);

    // A better game pushes 'keep-two' out by the cap; its key goes with the row, so a late
    // resend of it is a new result — and the worst of three, dropped again.
    await send(yoh, { elapsedSeconds: 50 }, { clientId: 'better-0004' });
    expect(await rows(yoh)).toEqual(['Yoh 50', 'Yoh 100']);
    const late = await send(yoh, { elapsedSeconds: 200 }, { clientId: 'keep-two-0002' });
    expect(late.status).toBe(201);
    expect(late.json.entry).toBeNull();
    expect(await rows(yoh)).toEqual(['Yoh 50', 'Yoh 100']);
  });

  it('does not remember a row the member deleted: its key is free again', async () => {
    const first = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    expect((await deleteEntry(yoh, first.json.entry.id)).status).toBe(204);
    const again = await send(yoh, { elapsedSeconds: 300 }, { clientId: KEY });
    expect(again.status).toBe(201);
    expect(again.json.entryCount).toBe(1);
    expect(again.json.entry.id).not.toBe(first.json.entry.id);
  });
});

describe('the per-member cap (rankingRowsPerMember, club.md §16-1)', () => {
  it("drops the member's worst row on the 51st, and the new row itself when it is the worst", async () => {
    await server.reopen({ limits: { memberPerMinute: 100000 } });
    await send(ken, { elapsedSeconds: 500 });
    // Fifty rows of Yoh's: 101 … 150.
    for (let i = 101; i <= 150; i++) {
      const reply = await send(yoh, { elapsedSeconds: i });
      expect(reply.status).toBe(201);
    }
    expect((await table(yoh)).json.entryCount).toBe(51);

    // The 51st is better than all of them: it stays, and his worst (150) goes.
    const best = await send(yoh, { elapsedSeconds: 100 });
    expect(best.status).toBe(201);
    expect(best.json).toMatchObject({ improved: true, entryCount: 51 });
    expect(best.json.entry.facts).toEqual({ elapsedSeconds: 100 });
    let mine = (await rows(yoh)).filter((row: string) => row.startsWith('Yoh'));
    expect(mine).toHaveLength(50);
    expect(mine[0]).toBe('Yoh 100');
    expect(mine.at(-1)).toBe('Yoh 149');

    // Worse than all fifty: stored and dropped at once — no row, no improvement, same count.
    const worst = await send(yoh, { elapsedSeconds: 900 });
    expect(worst.status).toBe(201);
    expect(worst.json).toEqual({
      gameId: 'sudoku',
      paramsKey: 'hard',
      improved: false,
      entry: null,
      entryCount: 51,
    });
    // Equal to his worst (149): the later of the two is the worse, so the new one goes.
    expect((await send(yoh, { elapsedSeconds: 149 })).json.entry).toBeNull();
    mine = (await rows(yoh)).filter((row: string) => row.startsWith('Yoh'));
    expect(mine).toHaveLength(50);
    expect(mine.at(-1)).toBe('Yoh 149');
    // Another member's rows are never touched by Yoh's cap.
    expect(await rows(ken)).toContain('Ken 500');
    expect((await table(ken)).json.entryCount).toBe(51);
  }, 60_000);

  it('follows the direction, moves the lead when the dropped row led, and leaves others alone', async () => {
    await server.reopen({ limits: { rankingRowsPerMember: 1 } });
    const score = (session: Session, value: number) =>
      send(session, { score: value }, { gameId: '2048', paramsKey: 'default' });
    const lead = async () => {
      const t = (await server.api('/api/v1/rankings', { token: mai.token })).json[0];
      return [t.leader.nickname, t.leader.facts.score, t.entryCount];
    };
    await score(yoh, 10);
    await score(ken, 5);
    expect(await lead()).toEqual(['Yoh', 10, 2]);
    // One row each: Yoh's better game replaces his leading row, and leads in its place.
    const better = await score(yoh, 20);
    expect(better.json).toMatchObject({ improved: true, entryCount: 2 });
    expect(await lead()).toEqual(['Yoh', 20, 2]);
    // A worse game (lower, in 2048) is the worst of his two rows and goes at once.
    const worse = await score(yoh, 15);
    expect(worse.json).toMatchObject({ improved: false, entry: null, entryCount: 2 });
    expect(await rows(mai, '2048/default', 'score')).toEqual(['Yoh 20', 'Ken 5']);
  });
});

describe('GET /api/v1/rankings', () => {
  it('lists one row per table with its leader, direction-aware', async () => {
    await send(yoh, { elapsedSeconds: 300 });
    await send(ken, { elapsedSeconds: 250 });
    await send(yoh, { elapsedSeconds: 90 }, { paramsKey: 'easy' });
    await send(yoh, { score: 10 }, { gameId: '2048', paramsKey: 'classic' });
    await send(ken, { score: 70 }, { gameId: '2048', paramsKey: 'classic' });
    await send(ken, { score: 40 }, { gameId: '2048', paramsKey: 'classic' });

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
      ['2048', 'classic', 3, 'Ken'],
      ['sudoku', 'easy', 1, 'Yoh'],
      ['sudoku', 'hard', 2, 'Ken'],
    ]);
    expect(reply.json[2].leader).toEqual({
      id: expect.stringMatching(/^[1-9][0-9]*$/),
      memberId: ken.memberId,
      nickname: 'Ken',
      submittedAt: expect.any(String),
      facts: { elapsedSeconds: 250 },
      seed: 'seed-1',
      boardDigest: 'xx1:00000000',
    });
  });

  it('keeps the leader and the row count right through every new row and overtake', async () => {
    const lead = async () => {
      const t = (await server.api('/api/v1/rankings', { token: mai.token })).json[0];
      return [t.leader.nickname, t.leader.facts.elapsedSeconds, t.entryCount];
    };
    await send(yoh, { elapsedSeconds: 300 });
    expect(await lead()).toEqual(['Yoh', 300, 1]);
    await send(ken, { elapsedSeconds: 300 }); // equal: the earlier leader stays
    expect(await lead()).toEqual(['Yoh', 300, 2]);
    await send(yoh, { elapsedSeconds: 200 }); // the leader betters his own row
    expect(await lead()).toEqual(['Yoh', 200, 3]);
    await send(ken, { elapsedSeconds: 250 }); // better than Ken's other row, not past
    expect(await lead()).toEqual(['Yoh', 200, 4]);
    await send(ken, { elapsedSeconds: 200 }); // equal to the leader: behind
    expect(await lead()).toEqual(['Yoh', 200, 5]);
    await send(ken, { elapsedSeconds: 150 }); // past the leader
    expect(await lead()).toEqual(['Ken', 150, 6]);
    await send(mai, { elapsedSeconds: 100 });
    expect(await lead()).toEqual(['Mai', 100, 7]);
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
      nextValue: 200,
    });
    const all = await table(yoh);
    expect(all.json.entries).toHaveLength(3);
    expect(all.json.me).toMatchObject({ rank: 1, nextValue: null });
  });

  it("answers `me` with the member's best row however many rows they have", async () => {
    await send(yoh, { elapsedSeconds: 300 });
    await send(ken, { elapsedSeconds: 150 });
    const best = await send(yoh, { elapsedSeconds: 100 });
    await send(yoh, { elapsedSeconds: 200 });
    const reply = await table(yoh);
    expect(await rows(yoh)).toEqual(['Yoh 100', 'Ken 150', 'Yoh 200', 'Yoh 300']);
    expect(reply.json.me).toEqual({ rank: 1, entry: best.json.entry, nextValue: null });
    expect((await table(ken)).json.me).toMatchObject({ rank: 2, nextValue: 100 });
  });

  it('gives the nearest strictly better value: an equal earlier row is skipped, and the top has none', async () => {
    await send(ken, { elapsedSeconds: 100 });
    await send(mai, { elapsedSeconds: 200 });
    await send(yoh, { elapsedSeconds: 200 }); // ties Mai, later
    await send(ken, { elapsedSeconds: 150 });
    expect((await table(yoh)).json.me).toMatchObject({ rank: 4, nextValue: 150 });
    expect((await table(mai)).json.me).toMatchObject({ rank: 3, nextValue: 150 });
    expect((await table(ken)).json.me).toMatchObject({ rank: 1, nextValue: null });
    // Tied with the first but behind it: second, and nothing strictly better to reach.
    const sam = await joinMember(server, yoh, 'Sam', '203.0.113.12');
    await send(sam, { elapsedSeconds: 100 });
    expect((await table(sam)).json.me).toMatchObject({ rank: 2, nextValue: null });

    // Higher is better: the nearest higher score.
    const score = (session: Session, value: number) =>
      send(session, { score: value }, { gameId: '2048', paramsKey: 'default' });
    await score(yoh, 50);
    await score(ken, 90);
    await score(mai, 90);
    await score(ken, 70);
    expect((await table(yoh, '2048/default')).json.me).toMatchObject({ rank: 4, nextValue: 70 });
    expect((await table(mai, '2048/default')).json.me).toMatchObject({ rank: 2, nextValue: null });
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
    expect(asDana.json.me).toEqual({ rank: null, entry: expect.any(Object), nextValue: 300 });
    // One better row is under the ceiling of 2: the rank is known.
    expect((await table(ken)).json.me.rank).toBe(2);
    // Two better rows reach the ceiling: unknown.
    expect((await table(mai)).json.me.rank).toBeNull();
    // The ceiling counts better rows and earlier equal ones together.
    await send(yoh, { elapsedSeconds: 200 });
    await send(dana, { elapsedSeconds: 200 });
    expect((await table(dana)).json.me.rank).toBeNull();
  });

  it('orders a desc game best first', async () => {
    await send(yoh, { score: 10 }, { gameId: 'yacht', paramsKey: 'cpu' });
    await send(ken, { score: 90 }, { gameId: 'yacht', paramsKey: 'cpu' });
    const reply = await table(yoh, 'yacht/cpu');
    expect(reply.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual(['Ken', 'Yoh']);
    expect(reply.json.me).toMatchObject({ rank: 2, nextValue: 90 });
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

describe('GET /api/v1/rankings/mine (club.md §5-4)', () => {
  it('lists the tables the caller has rows in, by game then mode, with the best row and where it stands', async () => {
    await send(yoh, { elapsedSeconds: 300 });
    await send(ken, { elapsedSeconds: 200 });
    const best = await send(yoh, { elapsedSeconds: 250 });
    await send(ken, { elapsedSeconds: 90 }, { paramsKey: 'easy' }); // a table Yoh is not in
    const mine2048 = await send(yoh, { score: 50 }, { gameId: '2048', paramsKey: 'default' });
    const leader2048 = await send(ken, { score: 90 }, { gameId: '2048', paramsKey: 'default' });

    const reply = await server.api('/api/v1/rankings/mine', { token: yoh.token });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual([
      {
        gameId: '2048',
        paramsKey: 'default',
        entryCount: 2,
        leader: leader2048.json.entry,
        best: { rank: 2, entry: mine2048.json.entry, nextValue: 90 },
      },
      {
        gameId: 'sudoku',
        paramsKey: 'hard',
        entryCount: 3,
        leader: expect.objectContaining({ nickname: 'Ken', facts: { elapsedSeconds: 200 } }),
        best: { rank: 2, entry: best.json.entry, nextValue: 200 },
      },
    ]);
    // `best` is the same as the table's `me`.
    expect((await table(yoh)).json.me).toEqual(reply.json[1].best);
  });

  it('is empty for a member with no rows, and loses a table when its last row goes', async () => {
    expect((await server.api('/api/v1/rankings/mine', { token: mai.token })).json).toEqual([]);
    const only = await send(mai, { elapsedSeconds: 100 });
    expect((await server.api('/api/v1/rankings/mine', { token: mai.token })).json).toHaveLength(1);
    expect((await deleteEntry(mai, only.json.entry.id)).status).toBe(204);
    expect((await server.api('/api/v1/rankings/mine', { token: mai.token })).json).toEqual([]);
  });

  it('counts the rank only to rankingMineScan, while the table counts on', async () => {
    await server.reopen({ limits: { rankingMineScan: 2 } });
    await send(ken, { elapsedSeconds: 100 });
    await send(mai, { elapsedSeconds: 200 });
    await send(yoh, { elapsedSeconds: 300 });
    const mine = await server.api('/api/v1/rankings/mine', { token: yoh.token });
    expect(mine.json[0].best).toMatchObject({ rank: null, nextValue: 200 });
    expect((await table(yoh)).json.me).toMatchObject({ rank: 3, nextValue: 200 });
    const kens = await server.api('/api/v1/rankings/mine', { token: ken.token });
    expect(kens.json[0].best).toMatchObject({ rank: 1, nextValue: null });
  });

  it('requires a member', async () => {
    expect((await server.api('/api/v1/rankings/mine')).status).toBe(401);
  });
});

describe('DELETE /api/v1/rankings/:gameId/:paramsKey/entries/:id (club.md §5-4)', () => {
  it("deletes one of the caller's rows, keeps the others, and fixes the count and the lead", async () => {
    const leading = await send(yoh, { elapsedSeconds: 100 });
    const second = await send(yoh, { elapsedSeconds: 200 });
    await send(ken, { elapsedSeconds: 150 });
    expect((await deleteEntry(yoh, leading.json.entry.id)).status).toBe(204);
    expect(await rows(mai)).toEqual(['Ken 150', 'Yoh 200']);
    const asYoh = await table(yoh);
    expect(asYoh.json.entryCount).toBe(2);
    expect(asYoh.json.me).toEqual({ rank: 2, entry: second.json.entry, nextValue: 150 });
    expect((await server.api('/api/v1/rankings', { token: yoh.token })).json).toMatchObject([
      { entryCount: 2, leader: { nickname: 'Ken' } },
    ]);
    // Gone is gone; the next finished game enters again.
    expect((await deleteEntry(yoh, leading.json.entry.id)).status).toBe(404);
    expect((await send(yoh, { elapsedSeconds: 120 })).json).toMatchObject({ entryCount: 3 });
    expect(await rows(mai)).toEqual(['Yoh 120', 'Ken 150', 'Yoh 200']);
  });

  it("is a 404 for another member's row, a row of another table, and an unknown or malformed id — and changes nothing", async () => {
    const kens = await send(ken, { elapsedSeconds: 150 });
    const yohs = await send(yoh, { elapsedSeconds: 100 });
    await send(yoh, { elapsedSeconds: 90 }, { paramsKey: 'easy' });
    expect((await deleteEntry(yoh, kens.json.entry.id)).status).toBe(404);
    // Yoh's own row, named under a table it is not in.
    expect((await deleteEntry(yoh, yohs.json.entry.id, 'sudoku/easy')).status).toBe(404);
    for (const id of ['0', '-1', 'abc', '1.5', '01', '1e3', '99999999', '123456789012345678901']) {
      const reply = await deleteEntry(yoh, id);
      expect(reply.status, id).toBe(404);
      expect(reply.json.error.code, id).toBe('not_found');
    }
    expect(await rows(mai)).toEqual(['Yoh 100', 'Ken 150']);
    expect((await table(mai, 'sudoku/easy')).json.entryCount).toBe(1);
  });

  it("drops the table's summary row when its last row goes", async () => {
    const only = await send(yoh, { elapsedSeconds: 100 });
    expect((await deleteEntry(yoh, only.json.entry.id)).status).toBe(204);
    expect((await server.api('/api/v1/rankings', { token: yoh.token })).json).toEqual([]);
    expect((await table(yoh)).json).toMatchObject({ entryCount: 0, entries: [], me: null });
  });

  it('works for an owner and needs a live member token', async () => {
    const kens = await send(ken, { elapsedSeconds: 150 });
    expect((await deleteEntry(undefined, kens.json.entry.id)).status).toBe(401);
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: yoh.token });
    expect((await deleteEntry(ken, kens.json.entry.id)).status).toBe(401);
    const yohs = await send(yoh, { elapsedSeconds: 100 });
    expect((await deleteEntry(yoh, yohs.json.entry.id)).status).toBe(204);
  });
});

describe('DELETE /api/v1/rankings/:gameId/:paramsKey/me (compatibility)', () => {
  it("deletes every row of the caller's in that table and nothing else", async () => {
    await send(yoh, { elapsedSeconds: 100 });
    await send(ken, { elapsedSeconds: 150 });
    await send(yoh, { elapsedSeconds: 200 });
    await send(yoh, { elapsedSeconds: 300 });
    await send(yoh, { elapsedSeconds: 90 }, { paramsKey: 'easy' });
    const reply = await server.api('/api/v1/rankings/sudoku/hard/me', {
      method: 'DELETE',
      token: yoh.token,
    });
    expect(reply.status).toBe(204);
    expect(await rows(mai)).toEqual(['Ken 150']);
    expect((await server.api('/api/v1/rankings', { token: mai.token })).json).toMatchObject([
      { paramsKey: 'easy', entryCount: 1, leader: { nickname: 'Yoh' } },
      { paramsKey: 'hard', entryCount: 1, leader: { nickname: 'Ken' } },
    ]);
    const again = await server.api('/api/v1/rankings/sudoku/hard/me', {
      method: 'DELETE',
      token: yoh.token,
    });
    expect(again.status).toBe(404);
  });
});

/** `X-Club-Rows` — rows the object read for a request; the Workers harness only (test mode). */
const rowsRead = (reply: { headers: Headers }): number | null => {
  const header = reply.headers.get('x-club-rows');
  const match = header === null ? null : /read=(\d+)/.exec(header);
  return match === null ? null : Number(match[1]);
};

/** The same header's `written=`: rows the object wrote for the request (Workers only). */
const rowsWritten = (reply: { headers: Headers }): number | null => {
  const header = reply.headers.get('x-club-rows');
  const match = header === null ? null : /written=(\d+)/.exec(header);
  return match === null ? null : Number(match[1]);
};

/** Joins members on an open deployment, each from an address of its own. */
const openJoiner = () => {
  let ip = 0;
  return async (nickname: string): Promise<Session> => {
    const reply = await server.api('/api/v1/join', {
      body: { nickname },
      headers: { 'X-Forwarded-For': `198.51.100.${++ip}` },
    });
    if (reply.status !== 201) throw new Error(`join failed: ${reply.status} ${reply.text}`);
    return {
      token: reply.json.memberToken,
      memberId: reply.json.member.id,
      clubId: reply.json.club.id,
    };
  };
};

/** Members `A<from>` … `A<to - 1>`, two rows each in sudoku/hard and in 2048 (one tied at 500). */
const fillOthers = async (
  joinOpen: (nickname: string) => Promise<Session>,
  from: number,
  to: number,
): Promise<void> => {
  for (let i = from; i < to; i++) {
    const other = await joinOpen(`A${i}`);
    await send(other, { elapsedSeconds: 200 + i });
    await send(other, { elapsedSeconds: 300 + i });
    await send(other, { score: 1000 + i }, { gameId: '2048', paramsKey: 'default' });
    // Ties: every other member has the same score in one more row.
    await send(other, { score: 500 }, { gameId: '2048', paramsKey: 'default' });
  }
};

describe('a table and "mine" read the same rows however many rows the others have (Workers)', () => {
  it('bounds GET /rankings/:gameId/:paramsKey and GET /rankings/mine by the caller, not the table', async () => {
    await server.reopen({
      openJoin: true,
      limits: { ipPerMinute: 100000, memberPerMinute: 100000 },
    });
    const joinOpen = openJoiner();

    /**
     * A fresh member with two rows in each of two tables — the best of sudoku/hard and of
     * 2048, better than any before (so the rank counts nothing above it), and one at the
     * bottom — then the table read
     * (`?top=1`, so the top-N part is fixed) and `mine`, measured.
     */
    const measure = async (nickname: string, best: number): Promise<(number | null)[]> => {
      const who = await joinOpen(nickname);
      await send(who, { elapsedSeconds: best });
      await send(who, { elapsedSeconds: 9000 });
      await send(who, { score: 1e9 / best }, { gameId: '2048', paramsKey: 'default' });
      await send(who, { score: 1 }, { gameId: '2048', paramsKey: 'default' });
      const tableRead = await server.api('/api/v1/rankings/sudoku/hard?top=1', {
        token: who.token,
      });
      const scoreRead = await server.api('/api/v1/rankings/2048/default?top=1', {
        token: who.token,
      });
      const mineRead = await server.api('/api/v1/rankings/mine', { token: who.token });
      expect(tableRead.json.me).toMatchObject({ rank: 1, nextValue: null });
      expect(scoreRead.json.me).toMatchObject({ rank: 1, nextValue: null });
      expect(mineRead.json).toHaveLength(2);
      return [tableRead, scoreRead, mineRead].map(rowsRead);
    };

    const fill = (from: number, to: number) => fillOthers(joinOpen, from, to);
    await fill(0, 3);
    const small = await measure('MaiA', 10);
    await fill(3, 40);
    const large = await measure('MaiB', 5);
    if (small.includes(null) || large.includes(null)) return; // Node reports no rows
    small.forEach((read, i) => {
      expect(large[i]!, `read ${i}`).toBeLessThanOrEqual(read! + 2);
      expect(large[i]!, `read ${i}`).toBeLessThan(30);
    });
  }, 60_000);

  it('stops counting a viewer who is far below at the ceilings, whatever the table holds (Workers)', async () => {
    await server.reopen({
      openJoin: true,
      limits: {
        ipPerMinute: 100000,
        memberPerMinute: 100000,
        rankingRankScan: 6,
        rankingMineScan: 4,
      },
    });
    const joinOpen = openJoiner();
    // A viewer with the worst time and the lowest score: every other row is above them.
    const measure = async (nickname: string): Promise<(number | null)[]> => {
      const who = await joinOpen(nickname);
      await send(who, { elapsedSeconds: 99999 });
      await send(who, { score: 1 }, { gameId: '2048', paramsKey: 'default' });
      const tableRead = await server.api('/api/v1/rankings/sudoku/hard?top=1', {
        token: who.token,
      });
      const mineRead = await server.api('/api/v1/rankings/mine', { token: who.token });
      expect(tableRead.json.me.rank).toBeNull();
      expect(mineRead.json.map((t: { best: { rank: number | null } }) => t.best.rank)).toEqual([
        null,
        null,
      ]);
      return [tableRead, mineRead].map(rowsRead);
    };
    await fillOthers(joinOpen, 0, 8);
    const small = await measure('LowA');
    await fillOthers(joinOpen, 8, 40);
    const large = await measure('LowB');
    if (small.includes(null) || large.includes(null)) return; // Node reports no rows
    small.forEach((read, i) => {
      // The ceilings, not the 32 members added between the two, set what is read.
      expect(large[i]!, `read ${i}`).toBeLessThanOrEqual(read! + 2);
    });
  }, 60_000);

  it('answers a resent clientId from one indexed lookup and writes nothing, whatever the table holds (Workers)', async () => {
    await server.reopen({
      openJoin: true,
      limits: { ipPerMinute: 100000, memberPerMinute: 100000 },
    });
    const joinOpen = openJoiner();
    // A member's keyed result, then the same body again: the second is measured.
    const measure = async (
      nickname: string,
      clientId: string,
    ): Promise<[number, number] | null> => {
      const who = await joinOpen(nickname);
      const first = await send(who, { elapsedSeconds: 100 }, { clientId });
      expect(first.status).toBe(201);
      const again = await send(who, { elapsedSeconds: 100 }, { clientId });
      expect(again.status).toBe(200);
      expect(again.json.entry).toEqual(first.json.entry);
      const read = rowsRead(again);
      const written = rowsWritten(again);
      return read === null || written === null ? null : [read, written];
    };
    await fillOthers(joinOpen, 0, 3);
    const small = await measure('DupA', 'dup-key-small-1');
    await fillOthers(joinOpen, 3, 40);
    const large = await measure('DupB', 'dup-key-large-1');
    if (small === null || large === null) return; // Node reports no rows
    // Nothing is written (not the row, the counter, the summary, nor the activity stamp), and
    // what is read is the key's entry and its row — not the 37 members' 148 rows added between.
    expect(small[1]).toBe(0);
    expect(large[1]).toBe(0);
    expect(large[0]).toBeLessThanOrEqual(small[0] + 2);
    expect(large[0]).toBeLessThan(10);
  }, 60_000);
});
