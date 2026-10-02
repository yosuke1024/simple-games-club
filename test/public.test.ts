import { afterEach, describe, expect, it } from 'vitest';
import { claimOwner, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
afterEach(() => server.close());

let ipCounter = 0;
const joinOpen = async (nickname: string): Promise<Session> => {
  const reply = await server.api('/api/v1/join', {
    body: { nickname },
    headers: { 'X-Forwarded-For': `198.51.100.${++ipCounter}` },
  });
  if (reply.status !== 201) throw new Error(`join failed: ${reply.status} ${reply.text}`);
  return {
    token: reply.json.memberToken,
    memberId: reply.json.member.id,
    clubId: reply.json.club.id,
  };
};

const DAY = '2026-10-02';

const createDaily = (
  session: Session,
  gameId: string,
  seed: string,
  facts: Record<string, unknown>,
  daily: string | null = DAY,
) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      params: {},
      seed,
      boardDigest: `dg:${seed}`,
      title: null,
      daily,
      result: { outcome: 'completed', facts },
    },
  });

const answer = (
  session: Session,
  challengeId: string,
  seed: string,
  facts: Record<string, unknown>,
  outcome = 'completed',
) =>
  server.api(`/api/v1/challenges/${challengeId}/results`, {
    token: session.token,
    body: { contractVersion: 1, boardDigest: `dg:${seed}`, outcome, facts },
  });

const offer = (session: Session, gameId: string, facts: Record<string, unknown>) =>
  server.api('/api/v1/rankings/results', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      paramsKey: 'default',
      params: {},
      seed: '',
      boardDigest: null,
      outcome: 'completed',
      facts,
    },
  });

describe('GET /api/v1/public (club.md §18)', () => {
  it('is not found on a deployment that is not open', async () => {
    server = await startServer({ openJoin: false });
    await claimOwner(server, 'Yoh');
    const reply = await server.api('/api/v1/public');
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('not_found');
  });

  it('lists the day top three by each game axis, the rankings leaders and the member count', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    const ken = await joinOpen('Ken');
    const mai = await joinOpen('Mai');
    const sam = await joinOpen('Sam');

    // sudoku: asc (lower seconds first). Yoh 300, Ken 250, Mai 400; Sam has only a played result, which is never ranked.
    const sudoku = await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 });
    await answer(ken, sudoku.json.id, 's1', { elapsedSeconds: 250 });
    await answer(mai, sudoku.json.id, 's1', { elapsedSeconds: 400 });
    await answer(sam, sudoku.json.id, 's1', { elapsedSeconds: 10 }, 'played'); // not completed: never ranked
    // 2048: desc (higher score first).
    const game = await createDaily(yoh, '2048', 'g1', { score: 500 });
    await answer(ken, game.json.id, 'g1', { score: 2000 });
    await answer(mai, game.json.id, 'g1', { score: 1500 });
    await answer(sam, game.json.id, 'g1', { score: 900 });
    // A game the server has no contract for lists no top; another day's board is not today's.
    await createDaily(yoh, 'checkers', 'c1', { turns: 10 });
    await createDaily(yoh, 'sudoku', 's2', { elapsedSeconds: 1 }, '2026-10-01');
    await createDaily(yoh, 'sudoku', 's3', { elapsedSeconds: 1 }, null);

    await offer(ken, 'sudoku', { elapsedSeconds: 200 });
    await offer(mai, '2048', { score: 4096 });

    const reply = await server.api(`/api/v1/public?date=${DAY}`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('public, max-age=300');
    expect(reply.headers.get('x-club-api')).toBe('1');
    expect(reply.json).toEqual({
      club: { name: "Yoh's Club" },
      memberCount: 4,
      today: [
        {
          gameId: 'sudoku',
          daily: DAY,
          resultCount: 4,
          top: [
            { nickname: 'Ken', facts: { elapsedSeconds: 250 } },
            { nickname: 'Yoh', facts: { elapsedSeconds: 300 } },
            { nickname: 'Mai', facts: { elapsedSeconds: 400 } },
          ],
        },
        {
          gameId: '2048',
          daily: DAY,
          resultCount: 4,
          top: [
            { nickname: 'Ken', facts: { score: 2000 } },
            { nickname: 'Mai', facts: { score: 1500 } },
            { nickname: 'Sam', facts: { score: 900 } },
          ],
        },
        { gameId: 'checkers', daily: DAY, resultCount: 1, top: [] },
      ],
      rankings: [
        {
          gameId: '2048',
          paramsKey: 'default',
          entryCount: 1,
          leader: { nickname: 'Mai', facts: { score: 4096 } },
        },
        {
          gameId: 'sudoku',
          paramsKey: 'default',
          entryCount: 1,
          leader: { nickname: 'Ken', facts: { elapsedSeconds: 200 } },
        },
      ],
    });
    // Names and facts only: no member id leaves this response.
    expect(reply.text).not.toContain(ken.memberId);
  });

  it('defaults the date to the request clock and answers an empty day with empty lists', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 }, '2026-09-09');
    const today = await server.api('/api/v1/public'); // the test clock starts on 2026-09-09
    expect(today.json.today).toHaveLength(1);
    const other = await server.api('/api/v1/public?date=2026-01-01');
    expect(other.json.today).toEqual([]);
    expect(other.json.rankings).toEqual([]);
  });

  it('rejects a date that is not a calendar date', async () => {
    server = await startServer({ openJoin: true });
    await claimOwner(server, 'Yoh');
    for (const date of ['abc', '2026-13-40', '2026-02-30', '']) {
      expect((await server.api(`/api/v1/public?date=${date}`)).status, date).toBe(400);
    }
  });

  it('answers a second request from the cache on the Workers deployment only', async () => {
    server = await startServer({ openJoin: true });
    const yoh = await claimOwner(server, 'Yoh');
    await createDaily(yoh, 'sudoku', 's1', { elapsedSeconds: 300 });
    const first = await server.api(`/api/v1/public?date=${DAY}`);
    expect(first.json.today[0].resultCount).toBe(1);
    const ken = await joinOpen('Ken');
    const list = await server.api('/api/v1/challenges', { token: yoh.token });
    await answer(ken, list.json[0].id, 's1', { elapsedSeconds: 200 });
    const second = await server.api(`/api/v1/public?date=${DAY}`);
    // Workers: caches.default holds the first body for five minutes. Node sets the header only.
    const cached = process.env.CLUB_IMPL === 'workers';
    expect(second.json.today[0].resultCount).toBe(cached ? 1 : 2);
  });
});
