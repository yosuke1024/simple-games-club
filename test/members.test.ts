import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('GET /api/v1/club and PATCH /api/v1/club (club.md §5-3)', () => {
  it('lists the club, the caller, and the members newest first with their total', async () => {
    const owner = await claimOwner(server, 'Yoh');
    await joinMember(server, owner, 'Ken');
    const reply = await server.api('/api/v1/club', { token: owner.token });
    expect(reply.json).toEqual({
      club: { id: owner.clubId, name: "Yoh's Club", createdAt: expect.any(String) },
      me: { id: owner.memberId, nickname: 'Yoh', role: 'owner', joinedAt: expect.any(String) },
      memberCount: 2,
      members: [
        { id: expect.any(String), nickname: 'Ken', role: 'member', joinedAt: expect.any(String) },
        { id: owner.memberId, nickname: 'Yoh', role: 'owner', joinedAt: expect.any(String) },
      ],
    });
  });

  it('does not read every member: the newest membersPage, and memberCount for the rest', async () => {
    await server.reopen({ limits: { membersPage: 2 } });
    const owner = await claimOwner(server, 'Yoh');
    await joinMember(server, owner, 'Ken');
    await joinMember(server, owner, 'Mai');
    const reply = await server.api('/api/v1/club', { token: owner.token });
    expect(reply.json.memberCount).toBe(3);
    expect(reply.json.members.map((m: { nickname: string }) => m.nickname)).toEqual(['Mai', 'Ken']);
  });

  it('lets an owner rename the club within 40 characters', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const renamed = await server.api('/api/v1/club', {
      method: 'PATCH',
      token: owner.token,
      body: { name: 'Suzuki Family' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.name).toBe('Suzuki Family');
    expect((await server.api('/api/v1/club', { token: member.token })).json.club.name).toBe(
      'Suzuki Family',
    );
    expect(
      (
        await server.api('/api/v1/club', {
          method: 'PATCH',
          token: member.token,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await server.api('/api/v1/club', {
          method: 'PATCH',
          token: owner.token,
          body: { name: 'x'.repeat(41) },
        })
      ).status,
    ).toBe(400);
  });
});

describe('DELETE /api/v1/members/:id (club.md §5-3, §8-3)', () => {
  it('removes a member once, and 404s afterwards', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const path = `/api/v1/members/${member.memberId}`;
    expect((await server.api(path, { method: 'DELETE', token: owner.token })).status).toBe(204);
    const again = await server.api(path, { method: 'DELETE', token: owner.token });
    expect(again.status).toBe(404);
    expect(
      (await server.api('/api/v1/members/m_nope', { method: 'DELETE', token: owner.token })).status,
    ).toBe(404);
  });

  it('never removes the last owner, but does remove one of two', async () => {
    const owner = await claimOwner(server);
    const self = await server.api(`/api/v1/members/${owner.memberId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    expect(self.status).toBe(409);
    expect(self.json.error.code).toBe('last_owner');

    const link = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    const second = await server.api('/api/v1/join', {
      body: { inviteToken: link.json.token, nickname: 'Yoh (tablet)' },
    });
    const removed = await server.api(`/api/v1/members/${owner.memberId}`, {
      method: 'DELETE',
      token: second.json.memberToken,
    });
    expect(removed.status).toBe(204);
    expect((await server.api('/api/v1/club', { token: owner.token })).status).toBe(401);
    const last = await server.api(`/api/v1/members/${second.json.member.id}`, {
      method: 'DELETE',
      token: second.json.memberToken,
    });
    expect(last.json.error.code).toBe('last_owner');
  });

  it('is an owner operation', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const reply = await server.api(`/api/v1/members/${owner.memberId}`, {
      method: 'DELETE',
      token: member.token,
    });
    expect(reply.status).toBe(403);
  });
});

// ---------- club.md §17-3: reports, rename, purge ----------

const submitRanking = (
  session: Session,
  gameId: string,
  facts: Record<string, unknown>,
  paramsKey = 'default',
) =>
  server.api('/api/v1/rankings/results', {
    token: session.token,
    body: {
      gameId,
      contractVersion: 1,
      paramsKey,
      params: {},
      seed: '',
      boardDigest: null,
      outcome: 'completed',
      facts,
    },
  });

const createChallenge = (session: Session, seed: string, elapsedSeconds: number) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: {
      gameId: 'sudoku',
      contractVersion: 1,
      params: { difficulty: 'hard' },
      seed,
      boardDigest: 'sd1:00000001',
      title: null,
      result: { outcome: 'completed', facts: { elapsedSeconds } },
    },
  });

const report = (reporter: Session, targetId: string) =>
  server.api(`/api/v1/members/${targetId}/report`, { method: 'POST', token: reporter.token });

describe('POST /api/v1/members/:id/report and GET /api/v1/members/reported (club.md §17-3)', () => {
  it('records one report per reporter; a second changes nothing', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    expect((await report(mai, ken.memberId)).status).toBe(204);
    expect((await report(mai, ken.memberId)).status).toBe(204);
    const list = await server.api('/api/v1/members/reported', { token: owner.token });
    expect(list.json).toEqual([
      {
        member: { id: ken.memberId, nickname: 'Ken', role: 'member', joinedAt: expect.any(String) },
        reportCount: 1,
      },
    ]);
  });

  it('caps the reported list at membersPage', async () => {
    await server.reopen({ limits: { membersPage: 2 } });
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const sam = await joinMember(server, owner, 'Sam', '203.0.113.3');
    await report(owner, ken.memberId);
    await report(owner, mai.memberId);
    await report(owner, sam.memberId);
    await report(ken, sam.memberId);
    const list = await server.api('/api/v1/members/reported', { token: owner.token });
    expect(list.json.map((r: { member: { nickname: string } }) => r.member.nickname)).toEqual([
      'Sam',
      'Ken',
    ]);
  });

  it('refuses a self report (400) and an unknown or removed member (404)', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    expect((await report(ken, ken.memberId)).status).toBe(400);
    expect((await report(ken, 'm_nope')).status).toBe(404);
    await server.api(`/api/v1/members/${mai.memberId}`, { method: 'DELETE', token: owner.token });
    expect((await report(ken, mai.memberId)).status).toBe(404);
    expect((await server.api('/api/v1/members/m_x/report', { method: 'POST' })).status).toBe(401);
  });

  it('lists the most reported first, then the oldest member, and only to an owner', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const sam = await joinMember(server, owner, 'Sam', '203.0.113.3');
    await report(owner, mai.memberId);
    await report(ken, sam.memberId);
    await report(sam, mai.memberId);
    await report(owner, sam.memberId);
    await report(owner, ken.memberId);
    const list = await server.api('/api/v1/members/reported', { token: owner.token });
    expect(
      list.json.map((r: { member: { nickname: string }; reportCount: number }) => [
        r.member.nickname,
        r.reportCount,
      ]),
    ).toEqual([
      ['Mai', 2],
      ['Sam', 2],
      ['Ken', 1],
    ]);
    // A repeat report does not bump the count.
    await report(owner, ken.memberId);
    const again = await server.api('/api/v1/members/reported', { token: owner.token });
    expect(again.json.map((r: { reportCount: number }) => r.reportCount)).toEqual([2, 2, 1]);
    expect((await server.api('/api/v1/members/reported', { token: ken.token })).status).toBe(403);
    // A removed member drops out of the list.
    await server.api(`/api/v1/members/${mai.memberId}`, { method: 'DELETE', token: owner.token });
    const after = await server.api('/api/v1/members/reported', { token: owner.token });
    expect(after.json.map((r: { member: { nickname: string } }) => r.member.nickname)).toEqual([
      'Sam',
      'Ken',
    ]);
  });
});

describe('PATCH /api/v1/members/:id (club.md §17-3)', () => {
  it('renames the member, their results and ranking rows, and clears their reports', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const challenge = await createChallenge(ken, 'seed-a', 300);
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 300 }, 'hard');
    await report(mai, ken.memberId);

    const renamed = await server.api(`/api/v1/members/${ken.memberId}`, {
      method: 'PATCH',
      token: owner.token,
      body: { nickname: '  Kenji   S ' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toEqual({
      id: ken.memberId,
      nickname: 'Kenji S',
      role: 'member',
      joinedAt: expect.any(String),
    });
    expect((await server.api('/api/v1/club', { token: ken.token })).json.me.nickname).toBe(
      'Kenji S',
    );
    const results = await server.api(`/api/v1/challenges/${challenge.json.id}/results`, {
      token: owner.token,
    });
    expect(results.json[0].nickname).toBe('Kenji S');
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: owner.token });
    expect(table.json.entries[0].nickname).toBe('Kenji S');
    expect(
      (await server.api('/api/v1/rankings', { token: owner.token })).json[0].leader.nickname,
    ).toBe('Kenji S');
    expect((await server.api('/api/v1/records', { token: owner.token })).json[0].nickname).toBe(
      'Kenji S',
    );
    expect((await server.api('/api/v1/members/reported', { token: owner.token })).json).toEqual([]);
  });

  it('validates the name, is an owner operation, and 404s an unknown or removed member', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const patch = (token: string, id: string, body: unknown) =>
      server.api(`/api/v1/members/${id}`, { method: 'PATCH', token, body });
    expect((await patch(owner.token, ken.memberId, { nickname: '!!!' })).status).toBe(400);
    expect((await patch(owner.token, ken.memberId, {})).status).toBe(400);
    expect((await patch(ken.token, ken.memberId, { nickname: 'Kenny' })).status).toBe(403);
    expect((await patch(owner.token, 'm_nope', { nickname: 'Kenny' })).status).toBe(404);
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: owner.token });
    expect((await patch(owner.token, ken.memberId, { nickname: 'Kenny' })).status).toBe(404);
  });
});

describe('DELETE /api/v1/members/:id?purge=1 (club.md §17-3)', () => {
  it('removes the results and ranking rows too, and fixes the counts and the leader', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');

    // A challenge Yoh made and both others answered.
    const challenge = await createChallenge(owner, 'seed-a', 300);
    const id = challenge.json.id;
    for (const [who, elapsedSeconds] of [
      [ken, 200],
      [mai, 250],
    ] as const) {
      await server.api(`/api/v1/challenges/${id}/results`, {
        token: who.token,
        body: {
          contractVersion: 1,
          boardDigest: 'sd1:00000001',
          outcome: 'completed',
          facts: { elapsedSeconds },
        },
      });
    }
    // Rankings: Ken leads sudoku/hard (Mai, Yoh behind) and is alone in 2048/default.
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 300 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await submitRanking(mai, 'sudoku', { elapsedSeconds: 250 }, 'hard');
    await submitRanking(ken, '2048', { score: 900 });
    await report(mai, ken.memberId);

    expect(
      (await server.api(`/api/v1/challenges/${id}`, { token: owner.token })).json.resultCount,
    ).toBe(3);

    const removed = await server.api(`/api/v1/members/${ken.memberId}?purge=1`, {
      method: 'DELETE',
      token: owner.token,
    });
    expect(removed.status).toBe(204);

    expect(
      (await server.api(`/api/v1/challenges/${id}`, { token: owner.token })).json.resultCount,
    ).toBe(2);
    const results = await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token });
    expect(results.json.map((r: { nickname: string }) => r.nickname)).toEqual(['Yoh', 'Mai']);

    const tables = await server.api('/api/v1/rankings', { token: owner.token });
    // 2048/default had only Ken: gone. sudoku/hard: two rows, Mai leads now.
    expect(
      tables.json.map((t: { gameId: string; entryCount: number; leader: { nickname: string } }) => [
        t.gameId,
        t.entryCount,
        t.leader.nickname,
      ]),
    ).toEqual([['sudoku', 2, 'Mai']]);
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: mai.token });
    expect(table.json.entryCount).toBe(2);
    expect(table.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual(['Mai', 'Yoh']);
    expect(
      (await server.api('/api/v1/rankings/2048/default', { token: mai.token })).json,
    ).toMatchObject({ entryCount: 0, entries: [] });
    const records = await server.api('/api/v1/records', { token: owner.token });
    expect(
      records.json.map((r: { gameId: string; nickname: string }) => [r.gameId, r.nickname]),
    ).toEqual([['sudoku', 'Mai']]);
    expect((await server.api('/api/v1/members/reported', { token: owner.token })).json).toEqual([]);
    expect((await server.api('/api/v1/club', { token: ken.token })).status).toBe(401);
  });

  it('keeps a table whose leader was someone else untouched but one row shorter', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 100 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await server.api(`/api/v1/members/${ken.memberId}?purge=1`, {
      method: 'DELETE',
      token: owner.token,
    });
    const tables = await server.api('/api/v1/rankings', { token: owner.token });
    expect(tables.json).toMatchObject([{ entryCount: 1, leader: { nickname: 'Yoh' } }]);
  });

  it('without purge (or purge=0) keeps the results, as before', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const challenge = await createChallenge(ken, 'seed-a', 200);
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await server.api(`/api/v1/members/${ken.memberId}?purge=0`, {
      method: 'DELETE',
      token: owner.token,
    });
    await server.api(`/api/v1/members/${mai.memberId}`, { method: 'DELETE', token: owner.token });
    const results = await server.api(`/api/v1/challenges/${challenge.json.id}/results`, {
      token: owner.token,
    });
    expect(results.json.map((r: { nickname: string }) => r.nickname)).toEqual(['Ken']);
    expect(
      (await server.api('/api/v1/rankings', { token: owner.token })).json[0].leader.nickname,
    ).toBe('Ken');
    const bad = await server.api(`/api/v1/members/${owner.memberId}?purge=yes`, {
      method: 'DELETE',
      token: owner.token,
    });
    expect(bad.status).toBe(400);
  });
});
