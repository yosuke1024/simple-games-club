/** Trial onboarding and owner benefits have the same contract on Node and workerd. */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_ADMIN_KEY, START, startServer, type TestServer } from './helpers.js';

const ROOT = '/api/v1/managed';
const UNTIL = '2026-10-09T09:00:00.000Z';
let server: TestServer;

const key = () => randomBytes(32).toString('hex');

async function trial(token = key()) {
  const reply = await server.api(`${ROOT}/trial`, { token, body: {} });
  expect(reply.status).toBe(201);
  return { id: reply.json.owner.id as string, token };
}

async function create(token: string, clientId = 'trial-club-1') {
  const reply = await server.api(`${ROOT}/clubs`, {
    token,
    body: { name: 'Friends', nickname: 'Host', clientId },
  });
  expect(reply.status).toBe(201);
  return {
    id: reply.json.club.id as string,
    memberId: reply.json.member.id as string,
    token: reply.json.memberToken as string,
    path: `/clubs/${reply.json.club.id}/api/v1`,
  };
}

async function upgrade(owner: { id: string }) {
  const reply = await server.api(`${ROOT}/admin/owners/${owner.id}`, {
    method: 'PATCH',
    token: MANAGED_ADMIN_KEY,
    body: { plan: 'basic', validUntil: UNTIL },
  });
  expect(reply.status).toBe(200);
}

async function makePublic(club: { path: string; token: string }, approvalRequired = false) {
  expect(
    (
      await server.api(`${club.path}/settings`, {
        method: 'PATCH',
        token: club.token,
        body: { visibility: 'public', approvalRequired },
      })
    ).status,
  ).toBe(200);
}

beforeEach(async () => {
  server = await startServer({ managed: true });
});
afterEach(async () => {
  await server?.close();
});

describe('managed Trial', () => {
  it('bootstraps once from a client-held key and retries without losing the entitlement', async () => {
    const token = key();
    const replies = await Promise.all([
      server.api(`${ROOT}/trial`, { token, body: {} }),
      server.api(`${ROOT}/trial`, { token, body: {} }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 201]);
    expect(replies[0]!.json).toEqual(replies[1]!.json);
    expect(replies[0]!.json).toEqual({
      owner: {
        id: expect.stringMatching(/^o_[A-Za-z0-9_-]{12}$/),
        plan: 'trial',
        validUntil: null,
        status: 'active',
      },
      limits: { maxClubs: 1, maxMembersPerClub: 5 },
      clubs: [],
      benefits: {
        adRemoval: { requiredMembers: 50, memberCount: 0, active: false, validUntil: null },
      },
    });
    expect(replies[0]!.text).not.toContain(token);
    const club = await create(token);
    // Trial is capacity-limited, without an invented duration.
    server.clock.advance(365 * 24 * 60 * 60_000);
    await server.reopen();
    const restored = await server.api(`${ROOT}/trial`, { token, body: {} });
    expect(restored.status).toBe(200);
    expect(restored.json.owner).toEqual(replies[0]!.json.owner);
    expect(restored.json.clubs[0].id).toBe(club.id);
    expect(restored.json.benefits.adRemoval.memberCount).toBe(1);
    expect((await server.api(`${ROOT}/owner`, { token })).json).toEqual(restored.json);
  });

  it('requires an empty bootstrap body and a full random-key shape', async () => {
    for (const token of [undefined, 'short', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) {
      expect((await server.api(`${ROOT}/trial`, { token, body: {} })).status).toBe(401);
    }
    const token = key();
    const forged = await server.api(`${ROOT}/trial`, {
      token,
      body: { plan: 'basic', validUntil: UNTIL, maxMembers: 1000 },
    });
    expect(forged.status).toBe(400);
    expect((await server.api(`${ROOT}/owner`, { token })).status).toBe(401);
  });

  it('rate limits new Trial owners per IP while allowing an existing key to retry', async () => {
    const first = await trial();
    for (let i = 1; i < 10; i++) await trial();
    expect((await server.api(`${ROOT}/trial`, { token: key(), body: {} })).status).toBe(429);
    expect((await server.api(`${ROOT}/trial`, { token: first.token, body: {} })).status).toBe(200);
    expect(
      (
        await server.api(`${ROOT}/trial`, {
          token: key(),
          body: {},
          headers: { 'X-Forwarded-For': '203.0.113.10' },
        })
      ).status,
    ).toBe(201);
    server.clock.advance(60_001);
    await trial();
  });

  it('reserves only one club and admits at most five members including the holder', async () => {
    const owner = await trial();
    const clubs = await Promise.all(
      ['first-club', 'second-club'].map((clientId) =>
        server.api(`${ROOT}/clubs`, {
          token: owner.token,
          body: { name: 'Friends', nickname: 'Host', clientId },
        }),
      ),
    );
    expect(clubs.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect(clubs.find((reply) => reply.status === 409)!.json.error.code).toBe('too_many_clubs');
    const ready = clubs.find((reply) => reply.status === 201)!;
    const club = { path: `/clubs/${ready.json.club.id}/api/v1`, token: ready.json.memberToken };
    await makePublic(club);
    for (let i = 0; i < 3; i++) {
      expect(
        (await server.api(`${club.path}/join`, { body: { nickname: `Friend${i}` } })).status,
      ).toBe(201);
    }
    const last = await Promise.all(
      ['LastA', 'LastB'].map((nickname) => server.api(`${club.path}/join`, { body: { nickname } })),
    );
    expect(last.map((reply) => reply.status).sort()).toEqual([201, 409]);
    await server.reopen();
    const forged = await server.api(`${club.path}/join`, {
      body: { nickname: 'Over capacity', maxMembers: 1000 },
      headers: {
        'X-Club-Managed-Max-Members': '50',
        'X-Club-Managed-Owner-Version': '999',
        'X-Club-Managed-Owner-Key': 'forged',
      },
    });
    expect(forged.status).toBe(409);
    expect(forged.json.error.code).toBe('too_many_members');
    const space = await server.api(`${ROOT}/owner`, { token: owner.token });
    expect(space.json.clubs).toHaveLength(1);
    expect(space.json.clubs[0].memberCount).toBe(5);
    expect(space.json.benefits.adRemoval).toEqual({
      requiredMembers: 50,
      memberCount: 5,
      active: false,
      validUntil: null,
    });
  });

  it('rechecks the fifth seat on approval and excludes unapproved requests', async () => {
    const owner = await trial();
    const club = await create(owner.token);
    await makePublic(club);
    for (let i = 0; i < 3; i++) {
      expect(
        (await server.api(`${club.path}/join`, { body: { nickname: `Friend${i}` } })).status,
      ).toBe(201);
    }
    await makePublic(club, true);
    const pending = await Promise.all(
      ['PendingA', 'PendingB'].map((nickname) =>
        server.api(`${club.path}/join`, { body: { nickname } }),
      ),
    );
    expect(pending.map((reply) => reply.status)).toEqual([202, 202]);
    expect(
      (await server.api(`${ROOT}/owner`, { token: owner.token })).json.benefits.adRemoval
        .memberCount,
    ).toBe(4);
    const approved = await Promise.all(
      pending.map((reply) =>
        server.api(`${club.path}/join-requests/${reply.json.request.id}/approve`, {
          token: club.token,
          body: {},
        }),
      ),
    );
    expect(approved.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(
      (await server.api(`${ROOT}/owner`, { token: owner.token })).json.benefits.adRemoval
        .memberCount,
    ).toBe(5);
  });

  it('upgrades the existing clubs and records to Basic while preserving all keys across restart', async () => {
    const owner = await trial();
    const club = await create(owner.token);
    await makePublic(club);
    const member = await server.api(`${club.path}/join`, { body: { nickname: 'Friend' } });
    const ranking = {
      gameId: 'sudoku',
      contractVersion: 1,
      paramsKey: 'easy',
      params: { difficulty: 'easy' },
      seed: 's1',
      boardDigest: 'sd1:9f3a1c07',
      outcome: 'completed',
      facts: { elapsedSeconds: 100 },
    };
    expect(
      (
        await server.api(`${club.path}/rankings/results`, {
          token: member.json.memberToken,
          body: ranking,
        })
      ).status,
    ).toBe(201);
    await upgrade(owner);
    const retry = await server.api(`${ROOT}/trial`, { token: owner.token, body: {} });
    expect(retry.status).toBe(200);
    expect(retry.json.owner).toEqual({
      id: owner.id,
      plan: 'basic',
      status: 'active',
      validUntil: UNTIL,
    });
    expect(retry.json.limits).toEqual({ maxClubs: 3, maxMembersPerClub: 50 });
    const connected = await server.api(`${ROOT}/clubs/${club.id}/connect`, {
      token: owner.token,
      body: {},
    });
    expect(connected.json.member.id).toBe(club.memberId);
    expect(connected.json.memberToken).toBe(club.token);
    for (let i = 0; i < 4; i++) {
      expect(
        (await server.api(`${club.path}/join`, { body: { nickname: `After${i}` } })).status,
      ).toBe(201);
    }
    await create(owner.token, 'second-club');
    await create(owner.token, 'third-club');
    await server.reopen();
    expect((await server.api(`${club.path}/club`, { token: member.json.memberToken })).status).toBe(
      200,
    );
    expect(
      (await server.api(`${club.path}/join`, { body: { nickname: 'After restart' } })).status,
    ).toBe(201);
    const records = await server.api(`${club.path}/owner/records`, { token: club.token });
    expect(records.status).toBe(200);
    expect(records.json.tables[0].participantCount).toBe(1);
    expect((await server.api(`${ROOT}/owner`, { token: owner.token })).json.clubs).toHaveLength(3);
    expect(
      (
        await server.api(`${ROOT}/admin/owners/${owner.id}`, {
          method: 'PATCH',
          token: MANAGED_ADMIN_KEY,
          body: { plan: 'trial', validUntil: null },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await server.api(`${ROOT}/admin/owners/${owner.id}`, {
          method: 'PATCH',
          token: MANAGED_ADMIN_KEY,
          body: { validUntil: null },
        })
      ).status,
    ).toBe(400);
  });

  it('supports operator suspension without letting bootstrap replay renew or recreate a Trial', async () => {
    const owner = await trial();
    await create(owner.token);
    const expired = new Date(START.getTime() - 1).toISOString();
    expect(
      (
        await server.api(`${ROOT}/admin/owners/${owner.id}`, {
          method: 'PATCH',
          token: MANAGED_ADMIN_KEY,
          body: { validUntil: expired },
        })
      ).status,
    ).toBe(200);
    const retry = await server.api(`${ROOT}/trial`, { token: owner.token, body: {} });
    expect(retry.status).toBe(200);
    expect(retry.json.owner).toMatchObject({ status: 'expired', validUntil: expired });
    expect(retry.json.benefits.adRemoval.active).toBe(false);
    const rotated = await server.api(`${ROOT}/admin/owners/${owner.id}/rotate-token`, {
      token: MANAGED_ADMIN_KEY,
      body: {},
    });
    expect(rotated.status).toBe(200);
    expect((await server.api(`${ROOT}/trial`, { token: owner.token, body: {} })).status).toBe(401);
    expect(
      (await server.api(`${ROOT}/owner`, { token: rotated.json.ownerToken })).json.clubs,
    ).toHaveLength(1);
  });
});

describe('managed owner ad removal', () => {
  it('counts active memberships across clubs, turns on at fifty, and follows removals and entitlement expiry', async () => {
    const owner = await trial();
    await upgrade(owner);
    const a = await create(owner.token);
    const b = await create(owner.token, 'second-club');
    await makePublic(a);
    await makePublic(b);
    // Each club's holder contributes one membership; names do not deduplicate people.
    for (let i = 0; i < 47; i++) {
      expect(
        (
          await server.api(`${(i < 24 ? a : b).path}/join`, {
            body: { nickname: 'Friend' },
            headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
          })
        ).status,
      ).toBe(201);
    }
    const assertBenefit = async (count: number, active: boolean, until = UNTIL) => {
      const space = await server.api(`${ROOT}/owner`, { token: owner.token });
      expect(space.status).toBe(200);
      expect(space.json.benefits.adRemoval).toEqual({
        requiredMembers: 50,
        memberCount: count,
        active,
        validUntil: until,
      });
      expect(
        space.json.clubs.reduce(
          (sum: number, item: { memberCount: number }) => sum + item.memberCount,
          0,
        ),
      ).toBe(count);
    };
    await assertBenefit(49, false);
    await makePublic(b, true);
    const pending = await server.api(`${b.path}/join`, { body: { nickname: 'Pending' } });
    expect(pending.status).toBe(202);
    await assertBenefit(49, false);
    const approved = await server.api(
      `${b.path}/join-requests/${pending.json.request.id}/approve`,
      {
        token: b.token,
        body: {},
      },
    );
    expect(approved.status).toBe(200);
    await assertBenefit(50, true);
    const status = await server.api(`${b.path}/join-requests/status`, {
      body: { requestToken: pending.json.requestToken },
    });
    expect(status.json.status).toBe('approved');
    expect(
      (
        await server.api(`${b.path}/members/${status.json.member.id}`, {
          method: 'DELETE',
          token: b.token,
        })
      ).status,
    ).toBe(204);
    await assertBenefit(49, false);
    await makePublic(b);
    expect((await server.api(`${b.path}/join`, { body: { nickname: 'Replacement' } })).status).toBe(
      201,
    );
    await assertBenefit(50, true);
    server.clock.now = new Date(UNTIL);
    await assertBenefit(50, false);
    const renewedUntil = '2026-11-09T09:00:00.000Z';
    expect(
      (
        await server.api(`${ROOT}/admin/owners/${owner.id}`, {
          method: 'PATCH',
          token: MANAGED_ADMIN_KEY,
          body: { validUntil: renewedUntil },
        })
      ).status,
    ).toBe(200);
    await assertBenefit(50, true, renewedUntil);
  }, 20_000);
});
