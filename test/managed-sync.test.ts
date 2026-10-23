import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type NodeDatabase } from '../src/db/database.js';
import type { ApiRequest, ApiResponse } from '../src/http/api.js';
import { readJsonObject } from '../src/http/body.js';
import { createManagedApi } from '../src/managed/api.js';
import { ManagedStore } from '../src/managed/store.js';
import type { ManagedMetadata, ManagedTransport } from '../src/managed/tenant.js';

const databases: NodeDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const CLUB_ID = 'c_123456789012';
const OWNER_ID = 'o_123456789012';
const NOW = new Date('2026-10-23T12:00:00.000Z');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function apiRequest(
  method: string,
  path: string,
  input?: unknown,
  token = 'owner-token',
): ApiRequest {
  const encoded = new TextEncoder().encode(input === undefined ? '' : JSON.stringify(input));
  return {
    method,
    url: new URL(`https://managed.example.test${path}`),
    header: (name) => (name === 'authorization' ? `Bearer ${token}` : undefined),
    clientIp: '192.0.2.1',
    origin: 'https://managed.example.test',
    now: NOW,
    body: {
      contentType: 'application/json',
      contentLength: String(encoded.byteLength),
      async *chunks() {
        yield encoded;
      },
    },
  };
}

function harness(onDescribe?: (snapshot: ManagedMetadata) => Promise<ManagedMetadata>) {
  const database = openDatabase(':memory:');
  databases.push(database);
  const store = new ManagedStore(database.driver);
  store.addOwner({
    id: OWNER_ID,
    reference: 'fixture',
    plan: 'basic',
    tokenHash: 'unused',
    createdAt: NOW.toISOString(),
    validUntil: '2026-11-23T12:00:00.000Z',
    credentialVersion: 1,
  });
  store.reserveClub({
    id: CLUB_ID,
    ownerId: OWNER_ID,
    clientId: 'fixture-01',
    name: 'Club',
    nickname: 'Owner',
    createdAt: NOW.toISOString(),
    memberCount: 1,
    status: 'provisioning',
    visibility: 'private',
    approvalRequired: false,
    allowedGameIds: null,
  });
  const model: { metadata: ManagedMetadata; loseNextResponse: boolean; edits: string[] } = {
    metadata: {
      name: 'Club',
      memberCount: 1,
      settings: { visibility: 'public', approvalRequired: false, allowedGameIds: null },
    },
    loseNextResponse: false,
    edits: [],
  };
  store.syncClub(CLUB_ID, model.metadata);
  const reply = (status: number, body: unknown): ApiResponse => ({
    status,
    headers: {},
    body: JSON.stringify(body),
  });
  const transport: ManagedTransport = {
    initialize: async () => {
      throw new Error('unused');
    },
    connect: async () => {
      throw new Error('unused');
    },
    rekeyOwner: async () => {
      throw new Error('unused');
    },
    authorizeOwner: async (_id, token) => token === 'owner-token',
    describe: async () => {
      const snapshot = structuredClone(model.metadata);
      return onDescribe === undefined ? snapshot : onDescribe(snapshot);
    },
    request: async (_id, request) => {
      if (request.header('authorization') !== 'Bearer owner-token') {
        return reply(401, { error: { code: 'unauthorized' } });
      }
      if (request.method === 'GET') return reply(200, { club: { name: 'Club' } });
      const input = await readJsonObject(request.body, 16 * 1024);
      if (input.visibility !== 'public' && input.visibility !== 'private') {
        return reply(400, { error: { code: 'invalid_request' } });
      }
      model.metadata.settings.visibility = input.visibility;
      model.edits.push(input.visibility);
      if (model.loseNextResponse) {
        model.loseNextResponse = false;
        throw new Error('response lost after the tenant committed the setting');
      }
      return reply(200, model.metadata.settings);
    },
  };
  const api = createManagedApi({
    store,
    config: {
      secret: 'test-managed-secret-0123456789abcdef',
      adminKey: 'test-managed-admin-0123456789abcdef',
      corsOrigins: [],
    },
    transport,
  });
  return {
    model,
    store,
    edit: (visibility: unknown, token?: string) =>
      api.handle(apiRequest('PATCH', `/clubs/${CLUB_ID}/api/v1/settings`, { visibility }, token)),
    read: () => api.handle(apiRequest('GET', `/clubs/${CLUB_ID}/api/v1/club`)),
    listed: () => store.directory(null, NOW.toISOString()).clubs,
  };
}

// This intentionally controls transport timing; the real Node/workerd contract suite
// separately verifies HTTP, authentication and storage on both implementations.
describe.skipIf(process.env.CLUB_IMPL === 'workers')('managed metadata synchronization', () => {
  it('does not republish a newly private club when an earlier public acknowledgement is delayed', async () => {
    const firstDescribe = deferred();
    const release = deferred();
    let reads = 0;
    const h = harness(async (snapshot) => {
      if (++reads === 1) {
        firstDescribe.resolve();
        await release.promise;
      }
      return snapshot;
    });
    const publicEdit = h.edit('public');
    await firstDescribe.promise;
    const privateEdit = h.edit('private');
    // A member read still completes while a metadata mutation awaits its acknowledgement.
    expect((await h.read()).status).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const editsWhileBlocked = [...h.model.edits];
    release.resolve();
    expect((await Promise.all([publicEdit, privateEdit])).map((reply) => reply.status)).toEqual([
      200, 200,
    ]);
    expect(editsWhileBlocked).toEqual(['public']);
    expect(h.listed()).toEqual([]);
    expect(h.store.club(CLUB_ID)?.visibility).toBe('private');
  });

  it('restores the unchanged public listing after an owner edit fails validation', async () => {
    const h = harness();
    expect((await h.edit('invalid')).status).toBe(400);
    expect(h.listed().map((club) => club.id)).toEqual([CLUB_ID]);
  });

  it('does not let an unauthenticated edit remove a public listing', async () => {
    const h = harness();
    expect((await h.edit('private', 'wrong-token')).status).toBe(401);
    expect(h.listed().map((club) => club.id)).toEqual([CLUB_ID]);
  });

  it('keeps a lost acknowledgement hidden and releases the lock for a safe retry', async () => {
    const h = harness();
    h.model.loseNextResponse = true;
    expect((await h.edit('private')).status).toBe(500);
    expect(h.listed()).toEqual([]);
    expect((await h.edit('public')).status).toBe(200);
    expect(h.listed().map((club) => club.id)).toEqual([CLUB_ID]);
  });
});
