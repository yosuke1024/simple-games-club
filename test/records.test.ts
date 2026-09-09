import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
let yoh: Session;
let ken: Session;
beforeEach(async () => {
  server = await startServer();
  yoh = await claimOwner(server, 'Yoh');
  ken = await joinMember(server, yoh, 'Ken');
});
afterEach(() => server.close());

const challenge = (
  session: Session,
  gameId: string,
  params: Record<string, unknown>,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      params,
      seed: `${gameId}-${Math.random().toString(36).slice(2)}`,
      boardDigest: 'xx1:00000000',
      result: { outcome, facts },
    },
  });

const submit = (
  session: Session,
  id: string,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api(`/api/v1/challenges/${id}/results`, {
    token: session.token,
    body: { contractVersion: 1, boardDigest: 'xx1:00000000', outcome, facts },
  });

describe('GET /api/v1/records (club.md §5-4, §6-1)', () => {
  it("keeps one record per game and mode: the lowest value on that game's axis", async () => {
    const hard = (await challenge(yoh, 'sudoku', { difficulty: 'hard' }, { elapsedSeconds: 305 }))
      .json.id;
    await submit(ken, hard, { elapsedSeconds: 271, mistakes: 0, hints: 1 });
    await challenge(yoh, 'sudoku', { difficulty: 'easy' }, { elapsedSeconds: 90 });
    const water = (
      await challenge(ken, 'water-sort', { tier: 'medium' }, { moves: 40, elapsedSeconds: 10 })
    ).json.id;
    await submit(yoh, water, { moves: 38, elapsedSeconds: 200 });

    const reply = await server.api('/api/v1/records', { token: ken.token });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual([
      {
        gameId: 'sudoku',
        paramsKey: 'easy',
        facts: { elapsedSeconds: 90 },
        memberId: yoh.memberId,
        nickname: 'Yoh',
        challengeId: expect.any(String),
      },
      {
        gameId: 'sudoku',
        paramsKey: 'hard',
        facts: { elapsedSeconds: 271, mistakes: 0, hints: 1 },
        memberId: ken.memberId,
        nickname: 'Ken',
        challengeId: hard,
      },
      {
        gameId: 'water-sort',
        paramsKey: 'medium',
        facts: { moves: 38, elapsedSeconds: 200 },
        memberId: yoh.memberId,
        nickname: 'Yoh',
        challengeId: water,
      },
    ]);
  });

  it('gives a tie to the earlier result, and ignores played results, unknown games and deleted challenges', async () => {
    const first = (
      await challenge(
        yoh,
        'minesweeper',
        { difficulty: 'medium', firstIndex: 3 },
        { elapsedSeconds: 60 },
      )
    ).json.id;
    await submit(ken, first, { elapsedSeconds: 60, hints: 0 });
    const lost = (
      await challenge(ken, 'minesweeper', { difficulty: 'medium', firstIndex: 3 }, {}, 'played')
    ).json.id;
    await submit(yoh, lost, { elapsedSeconds: 1 }, 'played');
    await challenge(ken, 'chess', { level: 1 }, { elapsedSeconds: 1 });
    const gone = (
      await challenge(
        ken,
        'minesweeper',
        { difficulty: 'easy', firstIndex: 0 },
        { elapsedSeconds: 5 },
      )
    ).json.id;
    await server.api(`/api/v1/challenges/${gone}`, { method: 'DELETE', token: ken.token });

    const reply = await server.api('/api/v1/records', { token: yoh.token });
    expect(reply.json).toEqual([
      {
        gameId: 'minesweeper',
        paramsKey: 'medium',
        facts: { elapsedSeconds: 60 },
        memberId: yoh.memberId,
        nickname: 'Yoh',
        challengeId: first,
      },
    ]);
  });
});
