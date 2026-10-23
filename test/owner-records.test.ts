import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
let owner: Session;
let member: Session;

beforeEach(async () => {
  server = await startServer();
  owner = await claimOwner(server, 'Yoh');
  member = await joinMember(server, owner, 'Ken');
});
afterEach(() => server.close());

const send = (session: Session, value: number, gameId = 'sudoku', paramsKey = 'hard') =>
  server.api('/api/v1/rankings/results', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      paramsKey,
      params: { difficulty: paramsKey },
      seed: `seed-${value}`,
      boardDigest: `digest-${value}`,
      outcome: 'completed',
      facts: gameId === '2048' ? { score: value } : { elapsedSeconds: value },
    },
  });

const overview = (query = '') =>
  server.api(`/api/v1/owner/records${query}`, { token: owner.token });

const publish = (extra: Record<string, unknown> = {}, session = owner) =>
  server.api('/api/v1/albums', {
    token: session.token,
    body: { title: 'Our records', tables: [{ gameId: 'sudoku', paramsKey: 'hard' }], ...extra },
  });

const album = (id: string, session = member) =>
  server.api(`/api/v1/albums/${id}`, { token: session.token });

const daily = (session: Session, seed: string, seconds: number, day = '2026-09-09') =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId: 'sudoku',
      contractVersion: 1,
      params: { difficulty: 'hard' },
      seed,
      boardDigest: `digest-${seed}`,
      daily: day,
      result: { outcome: 'completed', facts: { elapsedSeconds: seconds } },
    },
  });

describe('owner record book', () => {
  it('requires owner authentication and counts each retained member best once', async () => {
    expect((await server.api('/api/v1/owner/records')).status).toBe(401);
    expect((await server.api('/api/v1/owner/records', { token: member.token })).status).toBe(403);
    await send(owner, 300);
    await send(owner, 250);
    await send(owner, 400);
    await send(member, 200);
    await send(member, 220);
    const response = await overview();
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      club: { id: owner.clubId },
      basis: 'retained-member-bests',
      memberCount: 2,
      nextAfter: null,
      daily: [],
      nextDailyAfter: null,
      tables: [
        {
          gameId: 'sudoku',
          paramsKey: 'hard',
          participantCount: 2,
          axis: { fact: 'elapsedSeconds', direction: 'asc' },
          medianBestValue: 225,
          leader: { memberId: member.memberId, facts: { elapsedSeconds: 200 } },
          me: { rank: 2, entry: { memberId: owner.memberId, facts: { elapsedSeconds: 250 } } },
        },
      ],
    });
    // Ken has two rows before Yoh in ordinary ranking, but only one member best here.
    const regular = await server.api('/api/v1/rankings/sudoku/hard', { token: owner.token });
    expect(regular.json.me.rank).toBe(3);
    expect(response.text).not.toContain('entryCount');
    expect(response.text).not.toContain('token');
  });

  it('keeps descending games, ties, median and game-mode pages separate', async () => {
    const earlier = await send(owner, 1000, '2048', 'default');
    await send(owner, 900, '2048', 'default');
    await send(member, 1000, '2048', 'default');
    await send(owner, 100, 'sudoku', 'easy');
    await send(member, 200, 'sudoku', 'hard');
    const first = await overview('?limit=1');
    expect(first.json.tables).toHaveLength(1);
    expect(first.json.tables[0]).toMatchObject({
      gameId: '2048',
      participantCount: 2,
      axis: { fact: 'score', direction: 'desc' },
      medianBestValue: 1000,
      leader: { id: earlier.json.entry.id },
      me: { rank: 1 },
    });
    expect(first.json.nextAfter).toBe('2048:default');
    const second = await overview(`?limit=1&after=${first.json.nextAfter}`);
    expect(second.json.tables[0].paramsKey).toBe('easy');
    const third = await overview(`?limit=1&after=${second.json.nextAfter}`);
    expect(third.json.tables[0]).toMatchObject({ paramsKey: 'hard', me: null });
    expect(third.json.nextAfter).toBeNull();
  });

  it('filters disabled games and excludes revoked member bests', async () => {
    await send(owner, 300);
    await send(member, 100);
    await send(owner, 500, '2048', 'default');
    await server.api(`/api/v1/members/${member.memberId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    const retained = await overview();
    const sudoku = retained.json.tables.find(
      (table: { gameId: string }) => table.gameId === 'sudoku',
    );
    expect(sudoku).toMatchObject({
      participantCount: 1,
      medianBestValue: 300,
      leader: { nickname: 'Yoh' },
    });
    await server.api('/api/v1/settings', {
      method: 'PATCH',
      token: owner.token,
      body: { allowedGameIds: ['2048'] },
    });
    expect((await overview()).json.tables.map((table: { gameId: string }) => table.gameId)).toEqual(
      ['2048'],
    );
    await server.api('/api/v1/settings', {
      method: 'PATCH',
      token: owner.token,
      body: { allowedGameIds: [] },
    });
    expect((await overview()).json.tables).toEqual([]);
  });

  it('reports matching daily boards individually and paginates without mixing seeds', async () => {
    const a = await daily(owner, 'board-a', 300);
    await daily(member, 'board-a', 250);
    const b = await daily(owner, 'board-b', 180);
    await daily(owner, 'other-date', 100, '2026-09-08');
    const first = await overview('?daily=2026-09-09&limit=1');
    expect(first.json.daily).toHaveLength(1);
    expect(first.json.daily[0]).toMatchObject({
      challengeId: a.json.id,
      gameId: 'sudoku',
      contractVersion: 1,
      params: { difficulty: 'hard' },
      seed: 'board-a',
      boardDigest: 'digest-board-a',
      participantCount: 2,
      leader: { memberId: member.memberId },
      me: { rank: 2 },
    });
    expect(first.json.nextDailyAfter).toBe(a.json.id);
    const second = await overview(
      `?daily=2026-09-09&dailyAfter=${first.json.nextDailyAfter}&limit=1`,
    );
    expect(second.json.daily[0].challengeId).toBe(b.json.id);
    expect(second.json.nextDailyAfter).toBeNull();
  });

  it('rejects malformed cursors, dates and limits', async () => {
    for (const query of [
      '?limit=0',
      '?limit=-2',
      '?after=sudoku',
      '?after=sudoku:hard:other',
      '?daily=2026-02-30',
      '?dailyAfter=missing',
      '?daily=2026-09-09&dailyAfter=missing',
    ]) {
      expect((await overview(query)).status, query).toBe(400);
    }
  });
});

describe('record albums', () => {
  it('lets owners publish and members read, while unauthenticated visitors see no album', async () => {
    const original = await send(member, 200);
    expect((await publish({}, member)).status).toBe(403);
    const published = await publish({ clientId: 'album-request-01' });
    expect(published.status).toBe(201);
    const id = published.json.id as string;
    expect(published.json).toMatchObject({
      title: 'Our records',
      itemCount: 1,
      unavailableCount: 0,
      tables: [{ gameId: 'sudoku', paramsKey: 'hard', entry: { id: original.json.entry.id } }],
      daily: [],
    });
    expect((await server.api('/api/v1/albums')).status).toBe(401);
    expect((await server.api(`/api/v1/albums/${id}`)).status).toBe(401);
    expect((await album(id)).json).toEqual(published.json);
    expect((await server.api('/api/v1/albums', { token: member.token })).json.albums).toEqual([
      { id, title: 'Our records', createdAt: published.json.createdAt, itemCount: 1 },
    ]);
    // A retry never silently captures the new leader or creates another album.
    await send(owner, 150);
    const retry = await publish({ clientId: 'album-request-01' });
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual(published.json);
    expect((await server.api('/api/v1/albums', { token: member.token })).json.albums).toHaveLength(
      1,
    );
    expect(
      (await server.api(`/api/v1/albums/${id}`, { method: 'DELETE', token: member.token })).status,
    ).toBe(403);
    expect(
      (await server.api(`/api/v1/albums/${id}`, { method: 'DELETE', token: owner.token })).status,
    ).toBe(204);
    expect((await album(id)).status).toBe(404);
  });

  it('follows a nickname correction and forgets a deleted source without replacing it', async () => {
    const source = await send(member, 100);
    await send(owner, 200);
    const published = await publish();
    await server.api('/api/v1/me', {
      method: 'PATCH',
      token: member.token,
      body: { nickname: 'Kai' },
    });
    expect((await album(published.json.id)).json.tables[0].entry.nickname).toBe('Kai');
    await server.api(`/api/v1/rankings/sudoku/hard/entries/${source.json.entry.id}`, {
      method: 'DELETE',
      token: member.token,
    });
    const after = await album(published.json.id);
    expect(after.json).toMatchObject({ itemCount: 1, tables: [], unavailableCount: 1 });
    expect(after.text).not.toContain(member.memberId);
    expect(after.text).not.toContain('Kai');
    // Yoh now leads, but that was not the record selected at publication.
    expect(after.text).not.toContain('Yoh');
  });

  it('hides disabled games reversibly and omits revoked member records', async () => {
    await send(member, 100);
    const published = await publish();
    await server.api('/api/v1/settings', {
      method: 'PATCH',
      token: owner.token,
      body: { allowedGameIds: [] },
    });
    expect((await album(published.json.id)).json).toMatchObject({
      tables: [],
      unavailableCount: 1,
    });
    await server.api('/api/v1/settings', {
      method: 'PATCH',
      token: owner.token,
      body: { allowedGameIds: null },
    });
    expect((await album(published.json.id)).json.tables).toHaveLength(1);
    await server.api(`/api/v1/members/${member.memberId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    const after = await album(published.json.id, owner);
    expect(after.json).toMatchObject({ tables: [], unavailableCount: 1 });
    expect(after.text).not.toContain('Ken');
  });

  it('does not keep an independent copy after the best-row retention cap removes the source', async () => {
    await server.reopen({ limits: { rankingRowsPerMember: 2 } });
    await send(member, 300);
    const published = await publish();
    await send(member, 200);
    await send(member, 100);
    expect((await album(published.json.id)).json).toMatchObject({
      tables: [],
      unavailableCount: 1,
    });
    await server.reopen();
    expect((await album(published.json.id)).json).toMatchObject({
      tables: [],
      unavailableCount: 1,
    });
  });

  it('captures a daily board, then respects result deletion and board deletion', async () => {
    const a = await daily(member, 'daily-one', 200);
    const b = await daily(owner, 'daily-two', 300);
    const published = await publish({ tables: [], challengeIds: [a.json.id, b.json.id] });
    expect(published.status).toBe(201);
    expect(published.json.daily.map((entry: { seed: string }) => entry.seed)).toEqual([
      'daily-one',
      'daily-two',
    ]);
    await server.api(`/api/v1/challenges/${a.json.id}/results/me`, {
      method: 'DELETE',
      token: member.token,
    });
    await server.api(`/api/v1/challenges/${b.json.id}`, { method: 'DELETE', token: owner.token });
    const after = await album(published.json.id);
    expect(after.json).toMatchObject({ daily: [], unavailableCount: 2 });
    expect(after.text).not.toContain('digest-');
  });

  it('bounds publication and validates selection instead of trusting supplied snapshots', async () => {
    await send(owner, 200);
    for (const body of [
      { title: '' },
      { title: 'x'.repeat(61) },
      { tables: [] },
      { tables: [{ gameId: 'sudoku', paramsKey: 'missing' }] },
      { challengeIds: ['missing'] },
      {
        tables: [
          { gameId: 'sudoku', paramsKey: 'hard' },
          { gameId: 'sudoku', paramsKey: 'hard' },
        ],
      },
      { clientId: 'short' },
    ])
      expect((await publish(body)).status).toBe(400);
    expect(
      (await publish({ tables: Array(51).fill({ gameId: 'sudoku', paramsKey: 'hard' }) })).status,
    ).toBe(413);
    await server.api('/api/v1/settings', {
      method: 'PATCH',
      token: owner.token,
      body: { allowedGameIds: ['2048'] },
    });
    expect((await publish()).status).toBe(400);
  });

  it('keeps at most 24 albums and requires the owner to remove one before another', async () => {
    await send(owner, 200);
    let firstId = '';
    for (let i = 0; i < 24; i++) {
      const response = await publish({ title: `Record ${i}` });
      expect(response.status).toBe(201);
      if (i === 0) firstId = response.json.id;
    }
    expect((await publish()).status).toBe(413);
    expect((await server.api('/api/v1/albums', { token: member.token })).json.albums).toHaveLength(
      24,
    );
    await server.api(`/api/v1/albums/${firstId}`, { method: 'DELETE', token: owner.token });
    expect((await publish()).status).toBe(201);
  });
});
