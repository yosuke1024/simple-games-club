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

const rank = (
  session: Session,
  gameId: string,
  paramsKey: string,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api('/api/v1/rankings/results', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      paramsKey,
      params: {},
      seed: 's',
      boardDigest: null,
      outcome,
      facts,
    },
  });

const challenge = (session: Session, gameId: string, facts: Record<string, unknown>) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      params: { difficulty: 'hard' },
      seed: 'c-seed',
      boardDigest: 'xx1:00000000',
      result: { outcome: 'completed', facts },
    },
  });

describe('GET /api/v1/records — the rankings leaders in the old shape (club.md §16-1)', () => {
  it('returns one row per table: its leader, with an empty challengeId', async () => {
    await rank(yoh, 'sudoku', 'hard', { elapsedSeconds: 305 });
    await rank(ken, 'sudoku', 'hard', { elapsedSeconds: 271, mistakes: 0 });
    await rank(yoh, 'sudoku', 'easy', { elapsedSeconds: 90 });
    await rank(ken, 'water-sort', 'medium', { moves: 40 });
    await rank(yoh, 'water-sort', 'medium', { moves: 38 });

    const reply = await server.api('/api/v1/records', { token: ken.token });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual([
      {
        gameId: 'sudoku',
        paramsKey: 'easy',
        facts: { elapsedSeconds: 90 },
        memberId: yoh.memberId,
        nickname: 'Yoh',
        challengeId: '',
      },
      {
        gameId: 'sudoku',
        paramsKey: 'hard',
        facts: { elapsedSeconds: 271, mistakes: 0 },
        memberId: ken.memberId,
        nickname: 'Ken',
        challengeId: '',
      },
      {
        gameId: 'water-sort',
        paramsKey: 'medium',
        facts: { moves: 38 },
        memberId: yoh.memberId,
        nickname: 'Yoh',
        challengeId: '',
      },
    ]);
  });

  it('gives a tie to the earlier result and follows direction (higher score leads in 2048)', async () => {
    await rank(yoh, 'minesweeper', 'medium', { elapsedSeconds: 60 });
    server.clock.advance(1000);
    await rank(ken, 'minesweeper', 'medium', { elapsedSeconds: 60 });
    await rank(ken, '2048', 'classic', { score: 900 });
    await rank(yoh, '2048', 'classic', { score: 1200 });

    const reply = await server.api('/api/v1/records', { token: yoh.token });
    expect(
      reply.json.map((r: { gameId: string; nickname: string }) => [r.gameId, r.nickname]),
    ).toEqual([
      ['2048', 'Yoh'],
      ['minesweeper', 'Yoh'],
    ]);
  });

  it('never makes a record of a played result, and does not follow challenges', async () => {
    await rank(yoh, 'sudoku', 'hard', { elapsedSeconds: 10 }, 'played');
    await challenge(yoh, 'sudoku', { elapsedSeconds: 10 });
    expect((await server.api('/api/v1/records', { token: yoh.token })).json).toEqual([]);
  });

  it('survives the deletion of a challenge', async () => {
    const id = (await challenge(yoh, 'sudoku', { elapsedSeconds: 100 })).json.id;
    await rank(yoh, 'sudoku', 'hard', { elapsedSeconds: 100 });
    await server.api(`/api/v1/challenges/${id}`, { method: 'DELETE', token: yoh.token });
    expect((await server.api('/api/v1/records', { token: yoh.token })).json).toHaveLength(1);
  });
});
