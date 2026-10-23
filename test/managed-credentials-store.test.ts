/** Crash and concurrency boundaries that HTTP success-path tests cannot force. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/auth/tokens.js';
import { openDatabase, type NodeDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import type { ApiRequest, ApiResponse } from '../src/http/api.js';
import { createManagedApi } from '../src/managed/api.js';
import { ManagedStore, type ManagedClub } from '../src/managed/store.js';
import {
  ManagedTenant,
  managedMemberToken,
  type ManagedCredential,
  type ManagedSession,
  type ManagedTransport,
} from '../src/managed/tenant.js';

const SECRET = 'managed-credential-test-secret-0123456789';
const ADMIN = 'managed-credential-test-operator-0123456789';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const databases: NodeDatabase[] = [];

const database = () => {
  const db = openDatabase(':memory:');
  databases.push(db);
  return db;
};
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

const club: ManagedClub = {
  id: 'c_000000000001',
  ownerId: 'o_000000000001',
  clientId: 'request-one',
  name: 'Family',
  nickname: 'Host',
  createdAt: NOW.toISOString(),
  memberCount: 1,
  status: 'provisioning',
  visibility: 'private',
  approvalRequired: false,
  allowedGameIds: null,
};

const config = {
  setupKey: null,
  secret: SECRET,
  corsOrigins: [],
  openJoin: false,
  hosting: { provider: 'managed', manageUrl: null },
};
const credential = (version: number): ManagedCredential => ({
  version,
  memberToken: managedMemberToken(SECRET, club.ownerId, club.id, version),
});

function request(path: string, token?: string, data?: unknown): ApiRequest {
  const bytes = data === undefined ? null : new TextEncoder().encode(JSON.stringify(data));
  return {
    method: bytes === null ? 'GET' : 'POST',
    url: new URL(path, 'https://managed.example'),
    origin: 'https://managed.example',
    clientIp: '127.0.0.1',
    now: NOW,
    header(name) {
      if (name === 'authorization') return token === undefined ? undefined : `Bearer ${token}`;
      if (name === 'content-type' && bytes !== null) return 'application/json';
      return undefined;
    },
    body: {
      contentLength: bytes === null ? undefined : String(bytes.byteLength),
      contentType: bytes === null ? undefined : 'application/json',
      async *chunks() {
        if (bytes !== null) yield bytes;
      },
    },
  };
}

const json = (response: ApiResponse): Record<string, unknown> =>
  JSON.parse(response.body!) as Record<string, unknown>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('managed owner credential recovery', () => {
  it('rotates the same owner identity, preserves ordinary members, and cannot roll back a version', async () => {
    const db = database();
    const tenant = new ManagedTenant(db.driver, config);
    const first = credential(1);
    const second = credential(2);
    const session = tenant.initialize({
      club,
      memberToken: first.memberToken,
      credentialVersion: 1,
    });
    const store = new Store(db.driver);
    const guestToken = 'ordinary-member-credential';
    store.createMember(
      'm_ordinary',
      'Guest',
      'member',
      hashToken(SECRET, guestToken),
      NOW.toISOString(),
    );
    tenant.rekeyOwner(second);
    expect(tenant.connect(second).member.id).toBe(session.member.id);
    expect(store.countActive()).toBe(2);
    expect(() => tenant.connect(first)).toThrow('replaced');
    expect(() =>
      tenant.initialize({ club, memberToken: first.memberToken, credentialVersion: 1 }),
    ).toThrow('replaced');
    expect((await tenant.handle(request('/api/v1/club', first.memberToken), first)).status).toBe(
      401,
    );
    expect((await tenant.handle(request('/api/v1/club', second.memberToken), first)).status).toBe(
      200,
    );
    expect((await tenant.handle(request('/api/v1/club', guestToken), second)).status).toBe(200);
  });

  it('recovers an interrupted hash update without restoring the old hash', async () => {
    const db = database();
    const tenant = new ManagedTenant(db.driver, config);
    const first = credential(1);
    const second = credential(2);
    const session = tenant.initialize({
      club,
      memberToken: first.memberToken,
      credentialVersion: 1,
    });
    // Simulate a process stopping between the two durable writes of rekeyOwner.
    db.driver.run(
      'UPDATE members SET token_hash = ? WHERE id = ?',
      hashToken(SECRET, second.memberToken),
      session.member.id,
    );
    const reopened = new ManagedTenant(db.driver, config);
    expect(() => reopened.connect(first)).toThrow('replaced');
    expect((await reopened.handle(request('/api/v1/club', first.memberToken), first)).status).toBe(
      401,
    );
    expect(reopened.connect(second).member.id).toBe(session.member.id);
    expect(
      db.driver.get("SELECT value FROM meta WHERE key = 'managed_owner_credential_version'")?.value,
    ).toBe('2');
  });

  it('completes a reserved holder identity after a crash, including a newer credential', () => {
    const db = database();
    const store = new Store(db.driver);
    store.createClub(club.id, club.name, club.createdAt);
    db.driver.run("INSERT INTO meta (key, value) VALUES ('managed_owner_member', 'm_reserved')");
    const tenant = new ManagedTenant(db.driver, config);
    const second = credential(2);
    const session = tenant.initialize({
      club,
      memberToken: second.memberToken,
      credentialVersion: 2,
    });
    expect(session.member.id).toBe('m_reserved');
    expect(store.countActive()).toBe(1);
    expect(
      tenant.initialize({ club, memberToken: second.memberToken, credentialVersion: 2 }).member.id,
    ).toBe('m_reserved');
    expect(store.countActive()).toBe(1);
  });

  it('does not hand a fresh member key to an owner key rotated during club creation', async () => {
    const registry = new ManagedStore(database().driver);
    const tenantDb = database();
    const tenant = new ManagedTenant(tenantDb.driver, config);
    const reached = deferred();
    const resume = deferred();
    let hold = true;
    let initialSession: ManagedSession | undefined;
    const transport: ManagedTransport = {
      initialize: async (input) => {
        const session = tenant.initialize(input);
        if (hold) {
          hold = false;
          initialSession = session;
          reached.resolve();
          await resume.promise;
        }
        return session;
      },
      connect: async (_id, key) => tenant.connect(key),
      describe: async () => tenant.describe(),
      rekeyOwner: async (_id, key) => tenant.rekeyOwner(key),
      authorizeOwner: async (_id, token, key) => tenant.authorizeOwner(token, key),
      request: async (_id, input, key) => tenant.handle(input, key),
    };
    const api = createManagedApi({
      store: registry,
      config: { secret: SECRET, adminKey: ADMIN, corsOrigins: [] },
      transport,
    });
    const grant = json(
      await api.handle(
        request('/api/v1/managed/admin/owners', ADMIN, {
          reference: 'owner-one',
          plan: 'basic',
          validUntil: '2026-11-23T12:00:00.000Z',
        }),
      ),
    );
    const ownerId = (grant.owner as { id: string }).id;
    const creation = api.handle(
      request('/api/v1/managed/clubs', grant.ownerToken as string, {
        name: 'Family',
        nickname: 'Host',
        clientId: 'first-creation',
      }),
    );
    await reached.promise;
    const rotated = await api.handle(
      request(`/api/v1/managed/admin/owners/${ownerId}/rotate-token`, ADMIN, {}),
    );
    expect(rotated.status).toBe(200);
    resume.resolve();
    expect((await creation).status).toBe(401);
    const reserved = registry.clubs(ownerId)[0]!;
    expect(reserved.status).toBe('provisioning');
    const connected = await api.handle(
      request(
        `/api/v1/managed/clubs/${reserved.id}/connect`,
        json(rotated).ownerToken as string,
        {},
      ),
    );
    expect(connected.status).toBe(200);
    expect((json(connected).member as { id: string }).id).toBe(initialSession!.member.id);
    expect(json(connected).memberToken).not.toBe(initialSession!.memberToken);
    expect(registry.club(reserved.id)!.status).toBe('ready');
    expect(
      (await api.handle(request(`/clubs/${reserved.id}/api/v1/club`, initialSession!.memberToken)))
        .status,
    ).toBe(401);
  });

  it('rejects old holder credentials even when an operator rotation was only partly applied', async () => {
    const registry = new ManagedStore(database().driver);
    const tenant = new ManagedTenant(database().driver, config);
    let failRekey = false;
    const transport: ManagedTransport = {
      initialize: async (input) => tenant.initialize(input),
      connect: async (_id, key) => tenant.connect(key),
      describe: async () => tenant.describe(),
      rekeyOwner: async (_id, key) => {
        if (failRekey) throw new Error('unavailable');
        tenant.rekeyOwner(key);
      },
      authorizeOwner: async (_id, token, key) => tenant.authorizeOwner(token, key),
      request: async (_id, input, key) => tenant.handle(input, key),
    };
    const api = createManagedApi({
      store: registry,
      config: { secret: SECRET, adminKey: ADMIN, corsOrigins: [] },
      transport,
    });
    const grant = json(
      await api.handle(
        request('/api/v1/managed/admin/owners', ADMIN, {
          reference: 'owner-two',
          plan: 'basic',
          validUntil: '2026-11-23T12:00:00.000Z',
        }),
      ),
    );
    const ownerId = (grant.owner as { id: string }).id;
    const created = json(
      await api.handle(
        request('/api/v1/managed/clubs', grant.ownerToken as string, {
          name: 'Family',
          nickname: 'Host',
          clientId: 'second-creation',
        }),
      ),
    );
    const clubId = (created.club as { id: string }).id;
    failRekey = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      (await api.handle(request(`/api/v1/managed/admin/owners/${ownerId}/rotate-token`, ADMIN, {})))
        .status,
    ).toBe(500);
    expect(
      (await api.handle(request('/api/v1/managed/owner', grant.ownerToken as string))).status,
    ).toBe(401);
    // No successful rekey RPC happened. The next registry-forwarded request applies it.
    expect(
      (await api.handle(request(`/clubs/${clubId}/api/v1/club`, created.memberToken as string)))
        .status,
    ).toBe(401);
    failRekey = false;
    const recovery = await api.handle(
      request(`/api/v1/managed/admin/owners/${ownerId}/rotate-token`, ADMIN, {}),
    );
    expect(recovery.status).toBe(200);
    const connected = await api.handle(
      request(`/api/v1/managed/clubs/${clubId}/connect`, json(recovery).ownerToken as string, {}),
    );
    expect(connected.status).toBe(200);
    expect((json(connected).member as { id: string }).id).toBe(
      (created.member as { id: string }).id,
    );
  });
});
