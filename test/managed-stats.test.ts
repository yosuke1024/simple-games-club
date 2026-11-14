/** The operator statistics read the registry alone, with the same contract on Node and workerd. */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_ADMIN_KEY, START, startServer, type TestServer } from './helpers.js';

const ROOT = '/api/v1/managed';
const UNTIL = '2026-10-09T09:00:00.000Z';
let server: TestServer;

const key = () => randomBytes(32).toString('hex');

async function trial() {
  const token = key();
  const reply = await server.api(`${ROOT}/trial`, { token, body: {} });
  expect(reply.status).toBe(201);
  return { id: reply.json.owner.id as string, token };
}

async function create(token: string) {
  const reply = await server.api(`${ROOT}/clubs`, {
    token,
    body: { name: 'Friends', nickname: 'Host', clientId: 'stats-club-1' },
  });
  expect(reply.status).toBe(201);
  return {
    id: reply.json.club.id as string,
    token: reply.json.memberToken as string,
    path: `/clubs/${reply.json.club.id}/api/v1`,
  };
}

/** Joins a (private) club through a fresh invite, from a distinct address. */
async function join(club: { path: string; token: string }, n: number) {
  const invite = await server.api(`${club.path}/invite`, { token: club.token });
  expect(invite.status).toBe(200);
  const reply = await server.api(`${club.path}/join`, {
    body: { inviteToken: invite.json.token, nickname: `Friend${n}` },
    headers: { 'X-Forwarded-For': `203.0.113.${n + 1}` },
  });
  expect(reply.status).toBe(201);
}

const stats = () => server.api(`${ROOT}/admin/stats`, { token: MANAGED_ADMIN_KEY });

async function patch(ownerId: string, body: Record<string, unknown>) {
  const reply = await server.api(`${ROOT}/admin/owners/${ownerId}`, {
    method: 'PATCH',
    token: MANAGED_ADMIN_KEY,
    body,
  });
  expect(reply.status).toBe(200);
}

beforeEach(async () => {
  server = await startServer({ managed: true });
});
afterEach(async () => {
  await server?.close();
});

describe('managed operator statistics', () => {
  it('requires the operator key, like the other admin routes', async () => {
    for (const token of [undefined, 'wrong-operator-key-0123456789abcdef0123']) {
      const reply = await server.api(`${ROOT}/admin/stats`, { token });
      expect(reply.status).toBe(401);
      expect(reply.json.error.code).toBe('unauthorized');
    }
    // An owner key is not an operator key.
    const owner = await trial();
    expect((await server.api(`${ROOT}/admin/stats`, { token: owner.token })).status).toBe(401);
  });

  it('reports zeros for an empty registry', async () => {
    const reply = await stats();
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      generatedAt: START.toISOString(),
      owners: { total: 0, trial: 0, basic: 0, active: 0, expired: 0 },
      clubs: { total: 0, ready: 0, provisioning: 0, public: 0, private: 0, atCapacity: 0 },
      perClub: [],
    });
  });

  it('counts a self-started Trial club, its members, capacity, upgrade and expiry', async () => {
    const owner = await trial();
    const club = await create(owner.token);
    await join(club, 0);
    // A join is a directory-changing request, so the registry's cached count is
    // synced in the same request: no GET /owner is needed before reading it.
    let reply = await stats();
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      generatedAt: START.toISOString(),
      owners: { total: 1, trial: 1, basic: 0, active: 1, expired: 0 },
      clubs: { total: 1, ready: 1, provisioning: 0, public: 0, private: 1, atCapacity: 0 },
      perClub: [
        {
          id: club.id,
          name: 'Friends',
          plan: 'trial',
          ownerActive: true,
          createdAt: START.toISOString(),
          memberCount: 2,
          maxMembers: 5,
          atCapacity: false,
          visibility: 'private',
          approvalRequired: false,
          status: 'ready',
        },
      ],
    });
    // Secrets never appear: neither the owner key, its hash-bearing reference, nor member keys.
    expect(reply.text).not.toContain(owner.token);
    expect(reply.text).not.toContain('trial_');
    expect(reply.text).not.toContain(club.token);

    // Fill the Trial's five seats, holder included.
    for (let n = 1; n <= 3; n++) await join(club, n);
    reply = await stats();
    expect(reply.json.perClub[0]).toMatchObject({
      memberCount: 5,
      maxMembers: 5,
      atCapacity: true,
    });
    expect(reply.json.clubs.atCapacity).toBe(1);

    // Upgrading lifts the limit without touching the club.
    await patch(owner.id, { plan: 'basic', validUntil: UNTIL });
    reply = await stats();
    expect(reply.json.owners).toEqual({ total: 1, trial: 0, basic: 1, active: 1, expired: 0 });
    expect(reply.json.perClub[0]).toMatchObject({
      plan: 'basic',
      ownerActive: true,
      memberCount: 5,
      maxMembers: 50,
      atCapacity: false,
    });
    expect(reply.json.clubs.atCapacity).toBe(0);

    // Suspension shows as expired; the club and its cached count remain.
    const expired = new Date(START.getTime() - 1).toISOString();
    await patch(owner.id, { validUntil: expired });
    reply = await stats();
    expect(reply.json.owners).toEqual({ total: 1, trial: 0, basic: 1, active: 0, expired: 1 });
    expect(reply.json.perClub[0]).toMatchObject({ ownerActive: false, memberCount: 5 });

    // Expiry is judged on the request clock, not the wall clock.
    await patch(owner.id, { validUntil: UNTIL });
    expect((await stats()).json.owners.active).toBe(1);
    server.clock.now = new Date(UNTIL);
    reply = await stats();
    expect(reply.json.generatedAt).toBe(UNTIL);
    expect(reply.json.owners).toMatchObject({ active: 0, expired: 1 });
    expect(reply.json.perClub[0].ownerActive).toBe(false);
  }, 20_000);
});
