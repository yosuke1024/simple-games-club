import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth/tokens.js';
import { migrate, type SqlDriver } from '../src/db/driver.js';
import { Store } from '../src/db/store.js';
import { createApi, type ApiRequest } from '../src/http/api.js';

/**
 * A request body a route refuses before reading (club.md §5-1, keep-alive): the
 * API drains it after answering, so the connection can carry the next request.
 * Against a Store on node:sqlite directly — the HTTP harnesses cannot observe
 * whether the body was read, only the reset it would cause later, at random.
 */

const SECRET = 'test-secret';
let db: DatabaseSync;
afterEach(() => db.close());

function api() {
  db = new DatabaseSync(':memory:');
  const driver: SqlDriver = {
    exec: (script) => db.exec(script),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
  };
  migrate(driver);
  const store = new Store(driver);
  const token = 'member-token-0123456789abcdef';
  store.createMember('m_1', 'Ken', 'member', hashToken(SECRET, token), '2026-10-10T00:00:00.000Z');
  return {
    token,
    handle: createApi({
      store,
      config: {
        setupKey: null,
        secret: SECRET,
        corsOrigins: [],
        hosting: { provider: null, manageUrl: null },
        openJoin: false,
      },
      limits: {},
    }).handle,
  };
}

/** A request whose body records whether anything read it. */
function request(
  method: string,
  path: string,
  token: string | null,
  text: string,
): { request: ApiRequest; wasRead: () => boolean } {
  let read = false;
  const bytes = new TextEncoder().encode(text);
  return {
    wasRead: () => read,
    request: {
      method,
      url: new URL(`http://club.test${path}`),
      header: (name) =>
        name === 'authorization' && token !== null
          ? `Bearer ${token}`
          : name === 'content-type'
            ? 'application/json'
            : undefined,
      body: {
        contentLength: String(bytes.byteLength),
        contentType: 'application/json',
        async *chunks() {
          read = true;
          yield bytes;
        },
      },
      clientIp: '203.0.113.1',
      origin: 'http://club.test',
      now: new Date('2026-10-10T00:00:00.000Z'),
    },
  };
}

describe('a body the route never read is drained after the answer', () => {
  it('a member refused as not the owner (403)', async () => {
    const { token, handle } = api();
    const r = request('PATCH', '/api/v1/club', token, JSON.stringify({ name: 'x' }));
    const reply = await handle(r.request);
    expect(reply.status).toBe(403);
    expect(r.wasRead()).toBe(true);
  });

  it('no token (401) and no such route (404)', async () => {
    const { handle } = api();
    const unauthorized = request('PATCH', '/api/v1/club', null, '{}');
    expect((await handle(unauthorized.request)).status).toBe(401);
    expect(unauthorized.wasRead()).toBe(true);
    const missing = request('POST', '/api/v1/nothing', null, '{}');
    expect((await handle(missing.request)).status).toBe(404);
    expect(missing.wasRead()).toBe(true);
  });

  it('a GET carries no body to drain', async () => {
    const { handle } = api();
    const r = request('GET', '/api/v1/health', null, '');
    expect((await handle(r.request)).status).toBe(200);
    expect(r.wasRead()).toBe(false);
  });
});
