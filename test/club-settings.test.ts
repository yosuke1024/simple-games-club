import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOIN_REQUEST_TTL_MS, MAX_PENDING_REQUESTS } from '../src/db/policy.js';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

let server: TestServer;
let owner: Session;

beforeEach(async () => {
  server = await startServer({ limits: { ipPerMinute: 1000, memberPerMinute: 1000 } });
  owner = await claimOwner(server);
});
afterEach(() => server.close());

const settings = (body: Record<string, unknown>) =>
  server.api('/api/v1/settings', {
    method: 'PATCH',
    token: owner.token,
    body,
  });

const invite = async () =>
  (await server.api('/api/v1/invite', { token: owner.token })).json.token as string;

const request = async (nickname = 'Ken') =>
  server.api('/api/v1/join', {
    body: { nickname, inviteToken: await invite() },
  });

const status = (requestToken: string) =>
  server.api('/api/v1/join-requests/status', { body: { requestToken } });

const decide = (id: string, decision: 'approve' | 'reject' = 'approve') =>
  server.api(`/api/v1/join-requests/${id}/${decision}`, { method: 'POST', token: owner.token });

const sendRanking = () =>
  server.api('/api/v1/rankings/results', {
    token: owner.token,
    body: {
      gameId: 'sudoku',
      contractVersion: 1,
      paramsKey: 'hard',
      params: {},
      seed: 'board',
      boardDigest: 'digest',
      outcome: 'completed',
      facts: { elapsedSeconds: 300 },
    },
  });

const sendChallenge = () =>
  server.api('/api/v1/challenges', {
    token: owner.token,
    body: {
      gameId: 'sudoku',
      contractVersion: 1,
      params: {},
      seed: 'board',
      boardDigest: 'digest',
      result: { outcome: 'completed', facts: { elapsedSeconds: 300 } },
    },
  });

describe('per-club settings and discovery', () => {
  it('inherits legacy defaults, restricts edits to owners and persists settings through a restart', async () => {
    const member = await joinMember(server, owner);
    expect((await server.api('/api/v1/settings', { token: member.token })).json).toEqual({
      visibility: 'private',
      approvalRequired: false,
      allowedGameIds: null,
    });
    expect(
      (
        await server.api('/api/v1/settings', {
          method: 'PATCH',
          token: member.token,
          body: { visibility: 'public' },
        })
      ).status,
    ).toBe(403);
    expect((await server.api('/api/v1/settings')).status).toBe(401);
    const saved = await settings({
      visibility: 'public',
      approvalRequired: true,
      allowedGameIds: ['sudoku', 'sudoku', '2048'],
    });
    expect(saved.json).toEqual({
      visibility: 'public',
      approvalRequired: true,
      allowedGameIds: ['2048', 'sudoku'],
    });
    await server.reopen();
    expect((await server.api('/api/v1/settings', { token: owner.token })).json).toEqual(saved.json);
    expect((await server.api('/api/v1/health')).json.open).toBe(true);
  });

  it('public discovery reveals metadata only; a private preview needs a usable invitation', async () => {
    expect((await server.api('/api/v1/admission')).status).toBe(404);
    expect((await server.api('/api/v1/admission', { body: { inviteToken: 'wrong' } })).status).toBe(
      409,
    );
    const preview = await server.api('/api/v1/admission', {
      body: { inviteToken: await invite() },
    });
    expect(preview.json).toEqual({
      club: { id: owner.clubId, name: "Yoh's Club" },
      memberCount: 1,
      visibility: 'private',
      approvalRequired: false,
      allowedGameIds: null,
    });
    await settings({ visibility: 'public', approvalRequired: true });
    const publicView = await server.api('/api/v1/admission');
    expect(publicView.json).toEqual({
      ...preview.json,
      visibility: 'public',
      approvalRequired: true,
    });
    expect(publicView.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([
    {},
    { visibility: 'friends' },
    { approvalRequired: 'yes' },
    { allowedGameIds: ['bad/game'] },
    { allowedGameIds: Array.from({ length: 129 }, () => 'sudoku') },
  ])('rejects malformed settings without changing the club: %j', async (body) => {
    expect((await settings(body)).status).toBe(400);
    expect(
      (await server.api('/api/v1/settings', { token: owner.token })).json.allowedGameIds,
    ).toBeNull();
  });

  it.each([
    { visibility: 'private', approvalRequired: false, status: 201 },
    { visibility: 'private', approvalRequired: true, status: 202 },
    { visibility: 'public', approvalRequired: false, status: 201 },
    { visibility: 'public', approvalRequired: true, status: 202 },
  ])('supports $visibility with approval $approvalRequired', async (policy) => {
    await settings({ visibility: policy.visibility, approvalRequired: policy.approvalRequired });
    const body: Record<string, unknown> = { nickname: 'Ken' };
    if (policy.visibility === 'private') {
      expect((await server.api('/api/v1/join', { body })).status).toBe(400);
      body.inviteToken = await invite();
    }
    const reply = await server.api('/api/v1/join', { body });
    expect(reply.status).toBe(policy.status);
    expect(reply.json.club.id).toBe(owner.clubId);
    const members = await server.api('/api/v1/club', { token: owner.token });
    expect(members.json.memberCount).toBe(policy.approvalRequired ? 1 : 2);
  });
});

describe('approval credentials and decisions', () => {
  beforeEach(async () => {
    await settings({ approvalRequired: true });
  });

  it('keeps pending tokens out of member APIs, approves once and recovers after request history expires', async () => {
    const pending = await request();
    expect(pending.status).toBe(202);
    expect(pending.json.memberToken).toBeUndefined();
    const token = pending.json.requestToken as string;
    const id = pending.json.request.id as string;
    expect((await status(token)).json.status).toBe('pending');
    expect((await server.api('/api/v1/club', { token })).status).toBe(401);
    expect((await server.api('/api/v1/join-requests', { token })).status).toBe(401);
    expect((await server.api('/api/v1/join-requests', { token: owner.token })).json).toEqual([
      pending.json.request,
    ]);
    expect((await decide(id)).json.status).toBe('approved');
    expect((await decide(id)).json.status).toBe('approved');
    const approved = await status(token);
    expect(approved.json).toMatchObject({
      status: 'approved',
      memberToken: token,
      member: { nickname: 'Ken', role: 'member' },
    });
    expect((await server.api('/api/v1/club', { token })).json.memberCount).toBe(2);
    expect((await server.api('/api/v1/join-requests', { token })).status).toBe(403);
    server.clock.advance(JOIN_REQUEST_TTL_MS + 1);
    await server.reopen();
    expect((await status(token)).json).toEqual(approved.json);
  });

  it('distinguishes cancellation, rejection and expiry without ever granting membership', async () => {
    const cancelled = await request('Cancel');
    const rejected = await request('Reject');
    const expired = await request('Expire');
    expect(
      (
        await server.api('/api/v1/join-requests/cancel', {
          body: { requestToken: cancelled.json.requestToken },
        })
      ).status,
    ).toBe(204);
    expect((await status(cancelled.json.requestToken)).json.status).toBe('cancelled');
    expect((await decide(cancelled.json.request.id)).json.error.code).toBe('request_decided');
    expect((await decide(rejected.json.request.id, 'reject')).status).toBe(200);
    expect((await decide(rejected.json.request.id, 'reject')).status).toBe(200);
    expect((await status(rejected.json.requestToken)).json.status).toBe('rejected');
    expect((await decide(rejected.json.request.id)).status).toBe(409);
    server.clock.advance(JOIN_REQUEST_TTL_MS);
    expect((await status(expired.json.requestToken)).json.status).toBe('expired');
    expect((await decide(expired.json.request.id)).status).toBe(409);
    expect((await server.api('/api/v1/club', { token: expired.json.requestToken })).status).toBe(
      401,
    );
    expect((await server.api('/api/v1/club', { token: owner.token })).json.memberCount).toBe(1);
  });

  it('rechecks the member limit when multiple pending requests compete for the last seat', async () => {
    await server.reopen({ limits: { maxMembers: 2, ipPerMinute: 1000, memberPerMinute: 1000 } });
    const a = await request('A');
    const b = await request('B');
    const replies = await Promise.all([decide(a.json.request.id), decide(b.json.request.id)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const full = replies.find((reply) => reply.status === 409)!;
    expect(full.json.error.code).toBe('too_many_members');
    expect((await server.api('/api/v1/club', { token: owner.token })).json.memberCount).toBe(2);
    expect((await server.api('/api/v1/join-requests', { token: owner.token })).json).toHaveLength(
      1,
    );
  });

  it('bounds pending storage and makes room for new applicants after old requests expire', async () => {
    const inviteToken = await invite();
    for (let index = 0; index < MAX_PENDING_REQUESTS; index += 1) {
      const reply = await server.api('/api/v1/join', {
        body: { nickname: `Member ${index}`, inviteToken },
      });
      expect(reply.status).toBe(202);
    }
    expect((await request('Overflow')).json.error.code).toBe('too_many_requests');
    expect((await server.api('/api/v1/join-requests', { token: owner.token })).json).toHaveLength(
      MAX_PENDING_REQUESTS,
    );
    server.clock.advance(JOIN_REQUEST_TTL_MS);
    expect((await request('Later')).status).toBe(202);
    expect((await server.api('/api/v1/join-requests', { token: owner.token })).json).toHaveLength(
      1,
    );
  });

  it('keeps existing applications pending after policy changes, but a one-use owner appointment is explicit approval', async () => {
    const pending = await request();
    await settings({ visibility: 'public', approvalRequired: false });
    expect((await status(pending.json.requestToken)).json.status).toBe('pending');
    await settings({ approvalRequired: true });
    const ownerInvite = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    const appointed = await server.api('/api/v1/join', {
      body: { nickname: 'Co Owner', inviteToken: ownerInvite.json.token },
    });
    expect(appointed.status).toBe(201);
    expect(appointed.json.member.role).toBe('owner');
    expect(
      (
        await server.api('/api/v1/join', {
          body: { nickname: 'Again', inviteToken: ownerInvite.json.token },
        })
      ).json.error.code,
    ).toBe('invite_expired');
  });
});

describe('enabled games', () => {
  it('filters before paging so newer disabled challenges do not hide enabled ones', async () => {
    await server.reopen({ limits: { challengePage: 1, ipPerMinute: 1000, memberPerMinute: 1000 } });
    const sudoku = await sendChallenge();
    await server.api('/api/v1/challenges', {
      token: owner.token,
      body: {
        gameId: 'takuzu',
        contractVersion: 1,
        params: {},
        seed: 'other',
        boardDigest: 'other-digest',
        result: { outcome: 'completed', facts: { elapsedSeconds: 200 } },
      },
    });
    await settings({ allowedGameIds: ['sudoku'] });
    const page = await server.api('/api/v1/challenges', { token: owner.token });
    expect(page.json.map((row: { id: string }) => row.id)).toEqual([sudoku.json.id]);
  });

  it('rejects writes and hides disabled games without deleting their records or blocking self-deletion', async () => {
    const ranking = await sendRanking();
    const challenge = await sendChallenge();
    expect(ranking.status).toBe(201);
    expect(challenge.status).toBe(201);
    const member = await joinMember(server, owner);
    await settings({ allowedGameIds: [] });
    expect((await sendRanking()).json.error.code).toBe('game_disabled');
    expect((await sendChallenge()).json.error.code).toBe('game_disabled');
    expect(
      (
        await server.api(`/api/v1/challenges/${challenge.json.id}/results`, {
          token: member.token,
          body: {
            contractVersion: 1,
            boardDigest: 'digest',
            outcome: 'completed',
            facts: { elapsedSeconds: 250 },
          },
        })
      ).json.error.code,
    ).toBe('game_disabled');
    for (const path of ['/rankings', '/rankings/mine', '/records', '/challenges']) {
      expect((await server.api(`/api/v1${path}`, { token: owner.token })).json).toEqual([]);
    }
    expect(
      (await server.api(`/api/v1/members/${owner.memberId}`, { token: owner.token })).json.rankings,
    ).toEqual([]);
    expect((await server.api('/api/v1/rankings/sudoku/hard', { token: owner.token })).status).toBe(
      403,
    );
    expect(
      (await server.api(`/api/v1/challenges/${challenge.json.id}`, { token: owner.token })).status,
    ).toBe(403);
    expect(
      (await server.api(`/api/v1/challenges/${challenge.json.id}/results`, { token: owner.token }))
        .status,
    ).toBe(403);

    await settings({ allowedGameIds: null });
    expect((await server.api('/api/v1/rankings', { token: owner.token })).json).toHaveLength(1);
    expect((await server.api('/api/v1/challenges', { token: owner.token })).json).toHaveLength(1);
    await settings({ allowedGameIds: [] });
    expect(
      (
        await server.api(`/api/v1/rankings/sudoku/hard/entries/${ranking.json.entry.id}`, {
          method: 'DELETE',
          token: owner.token,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await server.api(`/api/v1/challenges/${challenge.json.id}/results/me`, {
          method: 'DELETE',
          token: owner.token,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await server.api(`/api/v1/challenges/${challenge.json.id}`, {
          method: 'DELETE',
          token: owner.token,
        })
      ).status,
    ).toBe(204);
  });
});
