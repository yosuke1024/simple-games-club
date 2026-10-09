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
    // Rankings: Ken leads sudoku/hard (Mai, Yoh behind; a second row of his among them) and
    // is alone in 2048/default.
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 300 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await submitRanking(mai, 'sudoku', { elapsedSeconds: 250 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 260 }, 'hard');
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
    // Best first: Mai's 250 s before Yoh's 300 s.
    expect(results.json.map((r: { nickname: string }) => r.nickname)).toEqual(['Mai', 'Yoh']);

    const tables = await server.api('/api/v1/rankings', { token: owner.token });
    // 2048/default had only Ken: gone. sudoku/hard: both of Ken's rows gone, Mai leads now.
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

// ---------- club.md §5-3: a member's own levers ----------

const sendChallengeResult = (who: Session, challengeId: string, elapsedSeconds: number) =>
  server.api(`/api/v1/challenges/${challengeId}/results`, {
    token: who.token,
    body: {
      contractVersion: 1,
      boardDigest: 'sd1:00000001',
      outcome: 'completed',
      facts: { elapsedSeconds },
    },
  });

describe('PATCH /api/v1/me', () => {
  it('renames the caller, their results and ranking rows, and keeps the reports against them', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const challenge = await createChallenge(ken, 'seed-a', 300);
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 300 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 320 }, 'hard');
    await report(mai, ken.memberId);

    const renamed = await server.api('/api/v1/me', {
      method: 'PATCH',
      token: ken.token,
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
    // Every row of his, not only the best.
    expect(table.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual([
      'Kenji S',
      'Kenji S',
    ]);
    expect(
      (await server.api('/api/v1/rankings', { token: owner.token })).json[0].leader.nickname,
    ).toBe('Kenji S');
    // The owner's rename clears reports; a member's own does not.
    expect(
      (await server.api('/api/v1/members/reported', { token: owner.token })).json,
    ).toMatchObject([{ member: { id: ken.memberId, nickname: 'Kenji S' }, reportCount: 1 }]);
  });

  it('works for an owner too, and leaves other members alone', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const renamed = await server.api('/api/v1/me', {
      method: 'PATCH',
      token: owner.token,
      body: { nickname: 'Yoh (tablet)' },
    });
    expect(renamed.json).toMatchObject({
      id: owner.memberId,
      nickname: 'Yoh (tablet)',
      role: 'owner',
    });
    const club = await server.api('/api/v1/club', { token: ken.token });
    expect(club.json.me.nickname).toBe('Ken');
    expect(club.json.members.map((m: { nickname: string }) => m.nickname).sort()).toEqual([
      'Ken',
      'Yoh (tablet)',
    ]);
  });

  it('applies the join nickname rules, and needs a live member token', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const patch = (token: string | undefined, body: unknown) =>
      server.api('/api/v1/me', { method: 'PATCH', token, body });
    expect((await patch(ken.token, { nickname: '!!!' })).status).toBe(400);
    expect((await patch(ken.token, { nickname: 'x'.repeat(25) })).status).toBe(400);
    expect((await patch(ken.token, { nickname: 7 })).status).toBe(400);
    expect((await patch(ken.token, {})).status).toBe(400);
    expect((await patch(undefined, { nickname: 'Kenny' })).status).toBe(401);
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: owner.token });
    expect((await patch(ken.token, { nickname: 'Kenny' })).status).toBe(401);
  });
});

const deleteRanking = (who: Session | undefined, gameId: string, paramsKey: string) =>
  server.api(`/api/v1/rankings/${gameId}/${paramsKey}/me`, {
    method: 'DELETE',
    token: who?.token,
  });

const deleteResult = (who: Session | undefined, challengeId: string) =>
  server.api(`/api/v1/challenges/${challengeId}/results/me`, {
    method: 'DELETE',
    token: who?.token,
  });

describe('DELETE /api/v1/rankings/:gameId/:paramsKey/me', () => {
  it("deletes the caller's row in that table only, moves the lead, and lets the next game enter again", async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const challenge = await createChallenge(ken, 'seed-a', 200);
    const id = challenge.json.id;
    await sendChallengeResult(mai, id, 250);
    // sudoku is lower-is-better: Ken leads, Mai second, Yoh last.
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 300 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await submitRanking(mai, 'sudoku', { elapsedSeconds: 250 }, 'hard');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 90 }, 'easy');
    await submitRanking(ken, '2048', { score: 900 });
    await report(mai, ken.memberId);

    expect((await deleteRanking(ken, 'sudoku', 'hard')).status).toBe(204);

    const tables = await server.api('/api/v1/rankings', { token: owner.token });
    expect(
      tables.json.map(
        (t: {
          gameId: string;
          paramsKey: string;
          entryCount: number;
          leader: { nickname: string };
        }) => [t.gameId, t.paramsKey, t.entryCount, t.leader.nickname],
      ),
    ).toEqual([
      ['2048', 'default', 1, 'Ken'],
      ['sudoku', 'easy', 1, 'Ken'],
      ['sudoku', 'hard', 2, 'Mai'],
    ]);
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: ken.token });
    expect(table.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual(['Mai', 'Yoh']);
    expect(table.json.me).toBeNull();
    expect(table.json.entryCount).toBe(2);

    // Ken's results in challenges, his other tables, his membership and the reports stay.
    expect(
      (await server.api(`/api/v1/challenges/${id}`, { token: ken.token })).json.resultCount,
    ).toBe(2);
    expect(
      (await server.api('/api/v1/members/reported', { token: owner.token })).json,
    ).toMatchObject([{ member: { id: ken.memberId }, reportCount: 1 }]);
    expect((await server.api('/api/v1/club', { token: ken.token })).status).toBe(200);

    // A later finished game enters the table again, and takes the lead again.
    const again = await submitRanking(ken, 'sudoku', { elapsedSeconds: 210 }, 'hard');
    expect(again.status).toBe(201);
    expect(again.json.entryCount).toBe(3);
    const after = await server.api('/api/v1/rankings/sudoku/hard', { token: ken.token });
    expect(after.json.entries.map((e: { nickname: string }) => e.nickname)).toEqual([
      'Ken',
      'Mai',
      'Yoh',
    ]);
    expect(after.json.me.rank).toBe(1);
  });

  it('keeps the leader when a member behind them deletes, and works for an owner', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 100 }, 'hard');
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    expect((await deleteRanking(owner, 'sudoku', 'hard')).status).toBe(204);
    expect((await server.api('/api/v1/rankings', { token: ken.token })).json).toMatchObject([
      { entryCount: 1, leader: { nickname: 'Ken' } },
    ]);
    expect((await server.api('/api/v1/club', { token: owner.token })).json.me.role).toBe('owner');
  });

  it('gives the lead of a lower-is-better table to the earliest of the entries tied at the next value', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const sam = await joinMember(server, owner, 'Sam', '203.0.113.3');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 100 }, 'hard');
    await submitRanking(sam, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await submitRanking(mai, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 300 }, 'hard');
    const leader = async () =>
      (await server.api('/api/v1/rankings', { token: owner.token })).json[0];
    expect(await leader()).toMatchObject({ entryCount: 4, leader: { nickname: 'Ken' } });
    await deleteRanking(ken, 'sudoku', 'hard');
    expect(await leader()).toMatchObject({ entryCount: 3, leader: { nickname: 'Sam' } });
    await deleteRanking(sam, 'sudoku', 'hard');
    expect(await leader()).toMatchObject({ entryCount: 2, leader: { nickname: 'Mai' } });
  });

  it('gives the lead of a higher-is-better table to the earliest of the entries tied at the next value', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const sam = await joinMember(server, owner, 'Sam', '203.0.113.3');
    // Ken leads 2048; Sam and Mai tie behind him, Sam first; Yoh is last.
    await submitRanking(ken, '2048', { score: 900 });
    await submitRanking(sam, '2048', { score: 500 });
    await submitRanking(mai, '2048', { score: 500 });
    await submitRanking(owner, '2048', { score: 100 });
    const leader = async () =>
      (await server.api('/api/v1/rankings', { token: owner.token })).json[0];
    expect(await leader()).toMatchObject({ entryCount: 4, leader: { nickname: 'Ken' } });
    await deleteRanking(ken, '2048', 'default');
    expect(await leader()).toMatchObject({ entryCount: 3, leader: { nickname: 'Sam' } });
    // A member who is not the leader goes without moving it.
    await deleteRanking(owner, '2048', 'default');
    expect(await leader()).toMatchObject({ entryCount: 2, leader: { nickname: 'Sam' } });
    await deleteRanking(sam, '2048', 'default');
    expect(await leader()).toMatchObject({ entryCount: 1, leader: { nickname: 'Mai' } });
  });

  it("drops the table's summary row when the only entry goes", async () => {
    const owner = await claimOwner(server, 'Yoh');
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 100 }, 'hard');
    expect((await deleteRanking(owner, 'sudoku', 'hard')).status).toBe(204);
    expect((await server.api('/api/v1/rankings', { token: owner.token })).json).toEqual([]);
    expect((await server.api('/api/v1/records', { token: owner.token })).json).toEqual([]);
    const table = await server.api('/api/v1/rankings/sudoku/hard', { token: owner.token });
    expect(table.json).toMatchObject({ entryCount: 0, entries: [], me: null });
    // The table starts again with the next finished game.
    expect((await submitRanking(owner, 'sudoku', { elapsedSeconds: 120 }, 'hard')).status).toBe(
      201,
    );
    expect((await server.api('/api/v1/rankings', { token: owner.token })).json).toMatchObject([
      { entryCount: 1, leader: { nickname: 'Yoh' } },
    ]);
  });

  it('is a 404 when the caller has no row there, and leaves everyone else alone', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    await submitRanking(owner, 'sudoku', { elapsedSeconds: 100 }, 'hard');
    expect((await deleteRanking(ken, 'sudoku', 'hard')).status).toBe(404);
    expect((await deleteRanking(ken, 'sudoku', 'nope')).status).toBe(404);
    expect((await deleteRanking(ken, 'no-such-game', 'hard')).status).toBe(404);
    expect((await deleteRanking(owner, 'sudoku', 'hard')).status).toBe(204);
    expect((await deleteRanking(owner, 'sudoku', 'hard')).status).toBe(404);
    expect((await server.api('/api/v1/rankings', { token: ken.token })).json).toEqual([]);
  });

  it('needs a live member token', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 100 }, 'hard');
    expect((await deleteRanking(undefined, 'sudoku', 'hard')).status).toBe(401);
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: owner.token });
    expect((await deleteRanking(ken, 'sudoku', 'hard')).status).toBe(401);
  });
});

describe('DELETE /api/v1/challenges/:id/results/me', () => {
  it("deletes the caller's result, fixes the count, and refuses any later submission on both paths", async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const mai = await joinMember(server, owner, 'Mai', '203.0.113.2');
    const challenge = await createChallenge(owner, 'seed-a', 300);
    const id = challenge.json.id;
    await sendChallengeResult(ken, id, 200);
    await sendChallengeResult(mai, id, 250);
    await submitRanking(ken, 'sudoku', { elapsedSeconds: 200 }, 'hard');
    expect((await server.api(`/api/v1/challenges/${id}`, { token: ken.token })).json).toMatchObject(
      { resultCount: 3, mine: true },
    );

    expect((await deleteResult(ken, id)).status).toBe(204);

    const after = await server.api(`/api/v1/challenges/${id}`, { token: ken.token });
    // Withdrawn still reads as `mine`: the app must not offer to send a result here again.
    expect(after.json).toMatchObject({ resultCount: 2, mine: true });
    const maiView = await server.api(`/api/v1/challenges/${id}`, { token: mai.token });
    expect(maiView.json).toMatchObject({ mine: true });
    const results = await server.api(`/api/v1/challenges/${id}/results`, { token: ken.token });
    expect(results.json.map((r: { nickname: string }) => r.nickname)).toEqual(['Mai', 'Yoh']);
    // The others' results, Ken's ranking row, his membership and the challenge itself stay.
    expect((await server.api('/api/v1/rankings', { token: ken.token })).json).toMatchObject([
      { entryCount: 1, leader: { nickname: 'Ken' } },
    ]);
    expect((await server.api('/api/v1/club', { token: ken.token })).status).toBe(200);

    // Deleting a result is leaving that challenge: both ways in answer 409, and store nothing.
    const direct = await sendChallengeResult(ken, id, 150);
    expect(direct.status).toBe(409);
    expect(direct.json.error.code).toBe('already_submitted');
    const viaCreate = await createChallenge(ken, 'seed-a', 150);
    expect(viaCreate.status).toBe(409);
    expect(viaCreate.json.error.code).toBe('already_submitted');
    expect(
      (await server.api(`/api/v1/challenges/${id}`, { token: owner.token })).json.resultCount,
    ).toBe(2);
    expect((await deleteResult(ken, id)).status).toBe(404);

    // Others still send to it, and Ken can still play other challenges.
    const sam = await joinMember(server, owner, 'Sam', '203.0.113.3');
    expect((await sendChallengeResult(sam, id, 260)).status).toBe(201);
    expect((await createChallenge(ken, 'seed-b', 150)).status).toBe(201);
    expect(
      (await server.api(`/api/v1/challenges/${id}`, { token: owner.token })).json.resultCount,
    ).toBe(3);
  });

  it('lets the creator delete their own result and keeps the challenge for the others', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const challenge = await createChallenge(ken, 'seed-k', 200);
    const id = challenge.json.id;
    expect((await deleteResult(ken, id)).status).toBe(204);
    const after = await server.api(`/api/v1/challenges/${id}`, { token: owner.token });
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({ resultCount: 0, createdBy: { id: ken.memberId } });
    expect((await sendChallengeResult(ken, id, 100)).status).toBe(409);
    expect((await sendChallengeResult(owner, id, 400)).status).toBe(201);
    expect(
      (await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token })).json,
    ).toHaveLength(1);
  });

  it('is a 404 with no result of the caller, an unknown challenge, or a deleted one', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const challenge = await createChallenge(owner, 'seed-a', 300);
    const id = challenge.json.id;
    expect((await deleteResult(ken, id)).status).toBe(404);
    // A 404 leaves no mark: Ken may still send his result.
    expect((await sendChallengeResult(ken, id, 200)).status).toBe(201);
    expect((await deleteResult(ken, 'ch_nope')).status).toBe(404);
    expect((await deleteResult(owner, id)).status).toBe(204);
    await server.api(`/api/v1/challenges/${id}`, { method: 'DELETE', token: owner.token });
    expect((await deleteResult(ken, id)).status).toBe(404);
  });

  it('needs a live member token', async () => {
    const owner = await claimOwner(server, 'Yoh');
    const ken = await joinMember(server, owner, 'Ken', '203.0.113.1');
    const challenge = await createChallenge(ken, 'seed-k', 200);
    expect((await deleteResult(undefined, challenge.json.id)).status).toBe(401);
    await server.api(`/api/v1/members/${ken.memberId}`, { method: 'DELETE', token: owner.token });
    expect((await deleteResult(ken, challenge.json.id)).status).toBe(401);
  });
});

/** `X-Club-Rows` — rows the object read for a request; the Workers harness only (test mode). */
const rowsRead = (reply: { headers: Headers }): number | null => {
  const header = reply.headers.get('x-club-rows');
  const match = header === null ? null : /read=(\d+)/.exec(header);
  return match === null ? null : Number(match[1]);
};

describe("a member's own levers read only their own rows (Workers)", () => {
  it('reads the same rows for a rename and for deleting a record however many rows the others have', async () => {
    await server.reopen({
      openJoin: true,
      limits: { ipPerMinute: 100000, memberPerMinute: 100000 },
    });
    const owner = await claimOwner(server, 'Yoh');
    let ip = 0;
    const joinOpen = async (nickname: string): Promise<Session> => {
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
    const challenge = await createChallenge(owner, 'seed-rows', 100);
    const id = challenge.json.id;

    /**
     * Mai's one result and one ranking row — the best of the table, so deleting it moves the
     * lead — then a rename, a ranking delete and a result delete, measured.
     */
    const measure = async (nickname: string): Promise<(number | null)[]> => {
      const mai = await joinOpen(nickname);
      await sendChallengeResult(mai, id, 900);
      await submitRanking(mai, 'sudoku', { elapsedSeconds: 100 }, 'hard');
      await submitRanking(mai, '2048', { score: 1e9 });
      const renamed = await server.api('/api/v1/me', {
        method: 'PATCH',
        token: mai.token,
        body: { nickname: `${nickname} 2` },
      });
      const lowest = await deleteRanking(mai, 'sudoku', 'hard');
      const highest = await deleteRanking(mai, '2048', 'default');
      const result = await deleteResult(mai, id);
      expect(renamed.status).toBe(200);
      expect(lowest.status).toBe(204);
      expect(highest.status).toBe(204);
      expect(result.status).toBe(204);
      return [renamed, lowest, highest, result].map(rowsRead);
    };

    const fill = async (from: number, to: number): Promise<void> => {
      for (let i = from; i < to; i++) {
        const other = await joinOpen(`A${i}`);
        await sendChallengeResult(other, id, 200 + i);
        await submitRanking(other, 'sudoku', { elapsedSeconds: 200 + i }, 'hard');
        await submitRanking(other, '2048', { score: 1000 + i });
        // Ties at the cut: every other member has the same value in one more table.
        await submitRanking(other, '2048', { score: 5 }, `tie-${i % 2}`);
      }
    };
    await fill(0, 3);
    const small = await measure('MaiA');
    await fill(3, 40);
    const large = await measure('MaiB');
    if (small.includes(null) || large.includes(null)) return; // Node reports no rows
    // The caller's rows are found by their own key or index: the others' rows cost nothing.
    small.forEach((rows, i) => {
      expect(large[i]!).toBeLessThanOrEqual(rows! + 6);
      expect(large[i]!).toBeLessThan(20);
    });
  });
});
