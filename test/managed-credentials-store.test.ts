/** Crash and concurrency boundaries that HTTP success-path tests cannot force. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/auth/tokens.js';
import { openDatabase, type NodeDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import type { ApiRequest, ApiResponse } from '../src/http/api.js';
import { createManagedApi } from '../src/managed/api.js';
import { ManagedStore, type ManagedClub, type ManagedOwner } from '../src/managed/store.js';
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
  maxMembers: 50,
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
  it('upgrades capacity independently of keys and never rolls it back on delayed requests or restart', async () => {
    const db = database();
    const tenant = new ManagedTenant(db.driver, config);
    const trial = { ...credential(1), maxMembers: 5 };
    const session = tenant.initialize({
      club,
      memberToken: trial.memberToken,
      credentialVersion: 1,
      maxMembers: 5,
    });
    const store = new Store(db.driver);
    store.policy.saveSettings({
      visibility: 'public',
      approvalRequired: false,
      allowedGameIds: null,
    });
    for (let i = 0; i < 4; i++) {
      store.createMember(`m_guest${i}`, 'Guest', 'member', `guest-hash-${i}`, NOW.toISOString());
    }
    const join = () => request('/api/v1/join', undefined, { nickname: 'Another' });
    expect((await tenant.handle(join(), trial)).status).toBe(409);
    const basic = { ...trial, maxMembers: 50 };
    expect(tenant.connect(basic).member.id).toBe(session.member.id);
    expect(tenant.connect(basic).memberToken).toBe(trial.memberToken);
    expect((await tenant.handle(join(), trial)).status).toBe(201);
    const restarted = new ManagedTenant(db.driver, config);
    expect((await restarted.handle(join(), trial)).status).toBe(201);
    expect(restarted.describe().memberCount).toBe(7);
    expect(() => restarted.connect({ ...basic, maxMembers: 1000 })).toThrow(
      'invalid managed member limit',
    );
    // Pre-Trial Basic tenants have no capacity metadata; a deploy must keep their 50 seats.
    db.driver.run("DELETE FROM meta WHERE key = 'managed_max_members'");
    const legacy = new ManagedTenant(db.driver, config);
    expect((await legacy.handle(join(), trial)).status).toBe(201);
  });

  it('rotates the same owner identity, preserves ordinary members, and cannot roll back a version', async () => {
    const db = database();
    const tenant = new ManagedTenant(db.driver, config);
    const first = credential(1);
    const second = credential(2);
    const session = tenant.initialize({
      club,
      memberToken: first.memberToken,
      credentialVersion: 1,
      maxMembers: 50,
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
      tenant.initialize({
        club,
        memberToken: first.memberToken,
        credentialVersion: 1,
        maxMembers: 50,
      }),
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
      maxMembers: 50,
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
      maxMembers: 50,
    });
    expect(session.member.id).toBe('m_reserved');
    expect(store.countActive()).toBe(1);
    expect(
      tenant.initialize({
        club,
        memberToken: second.memberToken,
        credentialVersion: 2,
        maxMembers: 50,
      }).member.id,
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

// This is the schema already deployed by the first managed preview, deliberately
// kept independent of the new schema so the old CHECK/NOT NULL constraints are exercised.
const LEGACY_MANAGED_SCHEMA = `
  CREATE TABLE managed_owners (
    id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL CHECK (plan = 'basic'), valid_until TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    credential_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE managed_clubs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES managed_owners(id), client_id TEXT NOT NULL,
    name TEXT NOT NULL, nickname TEXT NOT NULL, created_at TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'provisioning',
    visibility TEXT NOT NULL DEFAULT 'private', approval_required INTEGER NOT NULL DEFAULT 0,
    allowed_game_ids TEXT, listed INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id, client_id)
  );
  CREATE INDEX managed_clubs_owner ON managed_clubs(owner_id, seq);
  CREATE INDEX managed_clubs_directory ON managed_clubs(listed, seq);
`;
const legacyOwner: ManagedOwner = {
  id: club.ownerId,
  reference: 'existing-billing-reference',
  plan: 'basic',
  validUntil: '2026-11-23T12:00:00.000Z',
  tokenHash: 'existing-owner-hash',
  createdAt: NOW.toISOString(),
  credentialVersion: 7,
};

function legacyRegistry() {
  const db = database();
  db.driver.exec(LEGACY_MANAGED_SCHEMA);
  db.driver.run(
    'INSERT INTO managed_owners VALUES (?, ?, ?, ?, ?, ?, ?)',
    legacyOwner.id,
    legacyOwner.reference,
    legacyOwner.plan,
    legacyOwner.validUntil,
    legacyOwner.tokenHash,
    legacyOwner.createdAt,
    legacyOwner.credentialVersion,
  );
  db.driver.run(
    `INSERT INTO managed_clubs
      (seq, id, owner_id, client_id, name, nickname, created_at, member_count, status,
       visibility, approval_required, allowed_game_ids, listed)
      VALUES (7, ?, ?, ?, ?, ?, ?, 50, 'ready', 'public', 1, '["sudoku"]', 1)`,
    club.id,
    club.ownerId,
    club.clientId,
    club.name,
    club.nickname,
    club.createdAt,
  );
  return db;
}

function expectMigrated(db: NodeDatabase) {
  const registry = new ManagedStore(db.driver);
  expect(registry.owner(legacyOwner.id)).toEqual(legacyOwner);
  expect(registry.ownerByReference(legacyOwner.reference)?.id).toBe(legacyOwner.id);
  expect(registry.ownerByToken(legacyOwner.tokenHash)?.id).toBe(legacyOwner.id);
  expect(registry.clubs(legacyOwner.id)).toEqual([
    {
      ...club,
      status: 'ready',
      memberCount: 50,
      visibility: 'public',
      approvalRequired: true,
      allowedGameIds: ['sudoku'],
    },
  ]);
  expect(registry.directory(null, NOW.toISOString()).clubs[0]?.id).toBe(club.id);
  expect(db.driver.get('SELECT seq FROM managed_clubs WHERE id = ?', club.id)?.seq).toBe(7);
  expect(db.driver.all('PRAGMA foreign_key_check')).toEqual([]);
  expect(db.driver.all('PRAGMA index_list(managed_clubs)').map((row) => row.name)).toEqual(
    expect.arrayContaining(['managed_clubs_owner', 'managed_clubs_directory']),
  );
  const trial: ManagedOwner = {
    ...legacyOwner,
    id: 'o_trial0000001',
    reference: 'new-trial',
    tokenHash: 'trial-owner-hash',
    plan: 'trial',
    validUntil: null,
    credentialVersion: 1,
  };
  registry.addOwner(trial);
  expect(registry.owner(trial.id)).toEqual(trial);
  expect(() =>
    registry.addOwner({
      ...trial,
      id: 'o_invalid00001',
      reference: 'invalid-basic',
      tokenHash: 'invalid-hash',
      plan: 'basic',
    }),
  ).toThrow();
  registry.reserveClub({ ...club, id: 'c_new00000001', ownerId: trial.id, clientId: 'new-club' });
  expect(
    Number(db.driver.get('SELECT seq FROM managed_clubs WHERE owner_id = ?', trial.id)?.seq),
  ).toBeGreaterThan(7);
  // A second normal startup is harmless and keeps both old and new entitlements.
  expect(new ManagedStore(db.driver).owner(trial.id)).toEqual(trial);
}

describe('managed registry upgrade from Basic-only storage', () => {
  it('preserves existing IDs, keys, capacity metadata and directory order while admitting Trial', () => {
    expectMigrated(legacyRegistry());
  });

  it.each([
    'ALTER TABLE managed_clubs RENAME',
    'ALTER TABLE managed_owners RENAME',
    'INSERT OR IGNORE INTO managed_owners',
    'INSERT OR IGNORE INTO managed_clubs',
    'DROP TABLE managed_clubs_v1',
  ])('recovers if migration stops after %s', (stopAfter) => {
    const db = legacyRegistry();
    const exec = db.driver.exec;
    const interrupted = vi.spyOn(db.driver, 'exec').mockImplementation((script) => {
      exec(script);
      if (script.startsWith(stopAfter)) throw new Error('simulated restart');
    });
    expect(() => new ManagedStore(db.driver)).toThrow('simulated restart');
    interrupted.mockRestore();
    expectMigrated(db);
  });

  it('adds the credential version for older previews before rebuilding their constraints', () => {
    const db = legacyRegistry();
    db.driver.exec('ALTER TABLE managed_owners DROP COLUMN credential_version');
    const store = new ManagedStore(db.driver);
    expect(store.owner(legacyOwner.id)).toEqual({ ...legacyOwner, credentialVersion: 1 });
    expect(db.driver.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
