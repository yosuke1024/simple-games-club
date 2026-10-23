/** Same complete hosting flow against Node SQLite and Cloudflare's real workerd runtime. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_ADMIN_KEY, START, startServer, type TestServer } from './helpers.js';

const ROOT = '/api/v1/managed';
const UNTIL = '2026-10-09T09:00:00.000Z';
let server: TestServer;
let owner: { id: string; token: string };

async function grant(reference = 'billing_owner_1') {
  const reply = await server.api(`${ROOT}/admin/owners`, {
    token: MANAGED_ADMIN_KEY,
    body: { reference, plan: 'basic', validUntil: UNTIL },
  });
  expect(reply.status).toBe(201);
  return { id: reply.json.owner.id as string, token: reply.json.ownerToken as string };
}

async function create(clientId = 'create-club-1', token = owner.token) {
  const reply = await server.api(`${ROOT}/clubs`, {
    token,
    body: { name: 'Family', nickname: 'Host', clientId },
  });
  expect(reply.status).toBe(201);
  return {
    id: reply.json.club.id as string,
    memberId: reply.json.member.id as string,
    token: reply.json.memberToken as string,
    endpoint: reply.json.endpoint as string,
    path: `/clubs/${reply.json.club.id}/api/v1`,
  };
}

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

beforeEach(async () => {
  server = await startServer({ managed: true });
  owner = await grant();
});
afterEach(async () => {
  await server?.close();
});

describe('managed hosting', () => {
  it('defines Trial and Basic capacities while future plans stay unavailable, with no invented prices', async () => {
    const plans = await server.api(`${ROOT}/plans`);
    expect(plans.json.plans).toEqual([
      { id: 'trial', maxMembersPerClub: 5, maxClubs: 1, available: true },
      { id: 'basic', maxMembersPerClub: 50, maxClubs: 3, available: true },
      { id: 'plus', maxMembersPerClub: 100, maxClubs: 5, available: false },
      { id: 'max', maxMembersPerClub: null, maxClubs: 100, available: false },
    ]);
    const unavailable = await server.api(`${ROOT}/admin/owners`, {
      token: MANAGED_ADMIN_KEY,
      body: { reference: 'future_owner', plan: 'max', validUntil: UNTIL },
    });
    expect(unavailable.status).toBe(409);
    expect(unavailable.json.error.code).toBe('plan_unavailable');
  });

  it('never lets an owner key mint or extend its own entitlement', async () => {
    const lookup = `${ROOT}/admin/owners?reference=billing_owner_1`;
    const recovered = await server.api(lookup, { token: MANAGED_ADMIN_KEY });
    expect(recovered.status).toBe(200);
    expect(recovered.json.owner.id).toBe(owner.id);
    expect(recovered.json).not.toHaveProperty('ownerToken');
    expect((await server.api(lookup, { token: owner.token })).status).toBe(401);
    expect(
      (
        await server.api(`${ROOT}/admin/owners?reference=unknown`, {
          token: MANAGED_ADMIN_KEY,
        })
      ).status,
    ).toBe(404);
    const provision = await server.api(`${ROOT}/admin/owners`, {
      token: owner.token,
      body: { reference: 'unpaid_owner', plan: 'basic', validUntil: UNTIL },
    });
    expect(provision.status).toBe(401);
    expect(
      (
        await server.api(`${ROOT}/admin/owners/${owner.id}`, {
          method: 'PATCH',
          token: owner.token,
          body: { validUntil: '2027-01-01T00:00:00Z' },
        })
      ).status,
    ).toBe(401);
    expect((await server.api(`${ROOT}/owner`)).status).toBe(401);
  });

  it('reserves the three-club quota before asynchronous provisioning and keeps other owners isolated', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        server.api(`${ROOT}/clubs`, {
          token: owner.token,
          body: { name: `Club ${i}`, nickname: 'Host', clientId: `parallel-${i}` },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409]);
    expect(results.find((r) => r.status === 409)!.json.error.code).toBe('too_many_clubs');
    const portfolio = await server.api(`${ROOT}/owner`, { token: owner.token });
    expect(portfolio.json.clubs).toHaveLength(3);
    expect(portfolio.json.limits).toEqual({ maxClubs: 3, maxMembersPerClub: 50 });
    const another = await grant('billing_owner_2');
    expect((await server.api(`${ROOT}/owner`, { token: another.token })).json.clubs).toHaveLength(
      0,
    );
    const firstId = portfolio.json.clubs[0].id;
    expect(
      (await server.api(`${ROOT}/clubs/${firstId}/connect`, { token: another.token, body: {} }))
        .status,
    ).toBe(404);
    await create('other-club', another.token);
  });

  it('retries a lost creation response without spending another slot or making another owner', async () => {
    const club = await create();
    const replay = await server.api(`${ROOT}/clubs`, {
      token: owner.token,
      body: { name: 'Changed retry text', nickname: 'Other', clientId: 'create-club-1' },
    });
    expect(replay.status).toBe(200);
    expect(replay.json.club.id).toBe(club.id);
    expect(replay.json.memberToken).toBe(club.token);
    expect(replay.json.club.name).toBe('Family');
    const portfolio = await server.api(`${ROOT}/owner`, { token: owner.token });
    expect(portfolio.json.clubs).toHaveLength(1);
    expect(portfolio.json.clubs[0].memberCount).toBe(1);
  });

  it('isolates member credentials and prevents setup-key claim and public record leaks', async () => {
    const a = await create();
    const b = await create('create-club-2');
    expect((await server.api(`${b.path}/club`, { token: a.token })).status).toBe(401);
    expect((await server.api(`${a.path}/club`, { token: owner.token })).status).toBe(401);
    expect(
      (await server.api(`${a.path}/claim`, { body: { nickname: 'Thief', setupKey: 'irrelevant' } }))
        .status,
    ).toBe(403);
    expect((await server.api(`${a.path}/public`)).status).toBe(404);
    expect((await server.api('/clubs/c_notregistered/api/v1/health')).status).toBe(404);
    const invite = await server.api(`${a.path}/invite`, { token: a.token });
    expect(invite.json.url).toBe(`${server.url}/join#club=${a.id}&invite=${invite.json.token}`);
  });

  it('lists only safe public metadata and keeps pending people out until approval', async () => {
    const club = await create();
    expect((await server.api(`${ROOT}/directory`)).json.clubs).toEqual([]);
    await server.api(`${club.path}/settings`, {
      method: 'PATCH',
      token: club.token,
      body: { visibility: 'public', approvalRequired: true, allowedGameIds: ['sudoku'] },
    });
    const directory = await server.api(`${ROOT}/directory`);
    expect(directory.json.clubs).toHaveLength(1);
    expect(directory.json.clubs[0]).toMatchObject({
      name: 'Family',
      memberCount: 1,
      allowedGameIds: ['sudoku'],
      approvalRequired: true,
    });
    expect(directory.text).not.toContain(club.token);
    expect(directory.text).not.toContain(club.memberId);
    expect(directory.text).not.toContain('facts');
    const pending = await server.api(`${club.path}/join`, { body: { nickname: 'Friend' } });
    expect(pending.status).toBe(202);
    expect(
      (await server.api(`${club.path}/club`, { token: pending.json.requestToken })).status,
    ).toBe(401);
    expect((await server.api(`${ROOT}/directory`)).json.clubs[0].memberCount).toBe(1);
    expect(
      (
        await server.api(`${club.path}/join-requests/${pending.json.request.id}/approve`, {
          token: club.token,
          body: {},
        })
      ).status,
    ).toBe(200);
    const approved = await server.api(`${club.path}/join-requests/status`, {
      body: { requestToken: pending.json.requestToken },
    });
    expect(approved.json.status).toBe('approved');
    expect(
      (await server.api(`${club.path}/club`, { token: approved.json.memberToken })).status,
    ).toBe(200);
    expect((await server.api(`${ROOT}/directory`)).json.clubs[0].memberCount).toBe(2);
    await server.api(`${club.path}/settings`, {
      method: 'PATCH',
      token: club.token,
      body: { visibility: 'private' },
    });
    expect((await server.api(`${ROOT}/directory`)).json.clubs).toEqual([]);
    expect((await server.api(`${club.path}/admission`)).status).toBe(404);
  });

  it('enforces fifty active members including the holder and checks the final seat concurrently', async () => {
    const club = await create();
    await server.api(`${club.path}/settings`, {
      method: 'PATCH',
      token: club.token,
      body: { visibility: 'public' },
    });
    for (let i = 0; i < 48; i++) {
      const reply = await server.api(`${club.path}/join`, {
        body: { nickname: `Member${i}` },
        headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
      });
      expect(reply.status).toBe(201);
    }
    const last = await Promise.all(
      [49, 50].map((i) =>
        server.api(`${club.path}/join`, {
          body: { nickname: `Last${i}` },
          headers: { 'X-Forwarded-For': `203.0.113.${i}` },
        }),
      ),
    );
    expect(last.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await server.api(`${club.path}/club`, { token: club.token })).json.memberCount).toBe(
      50,
    );
    expect(
      (await server.api(`${ROOT}/owner`, { token: owner.token })).json.clubs[0].memberCount,
    ).toBe(50);
  }, 20000);

  it('stops new hosting usage on expiry, including equivalent paths, and preserves read/delete', async () => {
    const club = await create();
    await server.api(`${club.path}/settings`, {
      method: 'PATCH',
      token: club.token,
      body: { visibility: 'public' },
    });
    const sent = await server.api(`${club.path}/rankings/results`, {
      token: club.token,
      body: ranking,
    });
    expect(sent.status).toBe(201);
    const expired = new Date(START.getTime() - 1).toISOString();
    await server.api(`${ROOT}/admin/owners/${owner.id}`, {
      method: 'PATCH',
      token: MANAGED_ADMIN_KEY,
      body: { validUntil: expired },
    });
    expect((await server.api(`${ROOT}/directory`)).json.clubs).toEqual([]);
    expect((await server.api(`${ROOT}/owner`, { token: owner.token })).json.owner.status).toBe(
      'expired',
    );
    for (const path of [
      `${club.path}/join`,
      `${club.path}/join/`,
      `/clubs/${club.id}/api//v1/join`,
    ]) {
      const reply = await server.api(path, { body: { nickname: 'Late' } });
      expect(reply.status).toBe(403);
      expect(reply.json.error.code).toBe('subscription_inactive');
    }
    expect(
      (await server.api(`${club.path}/rankings/results/`, { token: club.token, body: ranking }))
        .status,
    ).toBe(403);
    expect(
      (
        await server.api(`${ROOT}/clubs`, {
          token: owner.token,
          body: { name: 'Late', nickname: 'Host', clientId: 'expired-1' },
        })
      ).status,
    ).toBe(403);
    expect((await server.api(`${club.path}/club`, { token: club.token })).status).toBe(200);
    expect(
      (
        await server.api(`${club.path}/rankings/sudoku/easy/entries/${sent.json.entry.id}`, {
          method: 'DELETE',
          token: club.token,
        })
      ).status,
    ).toBe(204);
    await server.api(`${ROOT}/admin/owners/${owner.id}`, {
      method: 'PATCH',
      token: MANAGED_ADMIN_KEY,
      body: { validUntil: UNTIL },
    });
    expect(
      (await server.api(`${club.path}/rankings/results`, { token: club.token, body: ranking }))
        .status,
    ).toBe(201);
  });

  it('does not let a delegated club owner remove the contract holder', async () => {
    const club = await create();
    const invite = await server.api(`${club.path}/invite`, {
      token: club.token,
      body: { role: 'owner' },
    });
    const delegated = await server.api(`${club.path}/join`, {
      body: { inviteToken: invite.json.token, nickname: 'Coowner' },
    });
    expect(delegated.status).toBe(201);
    expect(
      (
        await server.api(`${club.path}/members/${club.memberId}`, {
          method: 'DELETE',
          token: delegated.json.memberToken,
        })
      ).status,
    ).toBe(403);
    expect((await server.api(`${club.path}/club`, { token: club.token })).status).toBe(200);
  });

  it('recovers the owner key and invalidates earlier owner sessions without revoking ordinary members', async () => {
    const club = await create();
    await server.api(`${club.path}/settings`, {
      method: 'PATCH',
      token: club.token,
      body: { visibility: 'public' },
    });
    const member = await server.api(`${club.path}/join`, { body: { nickname: 'Friend' } });
    const rotated = await server.api(`${ROOT}/admin/owners/${owner.id}/rotate-token`, {
      token: MANAGED_ADMIN_KEY,
      body: {},
    });
    expect(rotated.status).toBe(200);
    expect((await server.api(`${ROOT}/owner`, { token: owner.token })).status).toBe(401);
    expect((await server.api(`${club.path}/club`, { token: club.token })).status).toBe(401);
    expect((await server.api(`${club.path}/club`, { token: member.json.memberToken })).status).toBe(
      200,
    );
    const restored = await server.api(`${ROOT}/clubs/${club.id}/connect`, {
      token: rotated.json.ownerToken,
      body: {},
    });
    expect(restored.status).toBe(200);
    expect(restored.json.member.id).toBe(club.memberId);
    expect(restored.json.memberToken).not.toBe(club.token);
    expect(
      (await server.api(`${club.path}/club`, { token: restored.json.memberToken })).status,
    ).toBe(200);
  });

  it('keeps tenant routing, quotas and member records over a restart', async () => {
    const club = await create();
    await server.api(`${club.path}/rankings/results`, { token: club.token, body: ranking });
    await server.reopen();
    const connected = await server.api(`${ROOT}/clubs/${club.id}/connect`, {
      token: owner.token,
      body: {},
    });
    expect(connected.status).toBe(200);
    expect(connected.json.member.id).toBe(club.memberId);
    expect((await server.api(`${ROOT}/owner`, { token: owner.token })).json.clubs).toHaveLength(1);
    const records = await server.api(`${club.path}/owner/records`, {
      token: connected.json.memberToken,
    });
    expect(records.status).toBe(200);
    expect(records.json.tables[0].participantCount).toBe(1);
    expect(records.json.basis).toBe('retained-member-bests');
  });
});
