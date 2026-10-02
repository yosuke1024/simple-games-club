import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('GET /api/v1/health (club.md §5-3)', () => {
  it('answers without auth, names the API version, and says whether the server is claimed', async () => {
    const before = await server.api('/api/v1/health');
    expect(before.status).toBe(200);
    expect(before.json).toEqual({ ok: true, api: 1, claimed: false, open: false });
    expect(before.headers.get('x-club-api')).toBe('1');

    await claimOwner(server);
    const after = await server.api('/api/v1/health');
    expect(after.json).toEqual({ ok: true, api: 1, claimed: true, open: false });
  });

  it('says whether anyone may join without an invite', async () => {
    expect((await server.api('/api/v1/health')).json.open).toBe(false);
    await server.reopen({ openJoin: true });
    expect((await server.api('/api/v1/health')).json.open).toBe(true);
  });

  it('never caches API answers', async () => {
    const reply = await server.api('/api/v1/health');
    expect(reply.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the error envelope (club.md §5-1)', () => {
  it('is { error: { code, message } } with X-Club-Api on every status', async () => {
    const reply = await server.api('/api/v1/nope');
    expect(reply.status).toBe(404);
    expect(reply.headers.get('x-club-api')).toBe('1');
    expect(reply.json).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    });
  });

  it('treats an unknown method on a known path as not found', async () => {
    const reply = await server.api('/api/v1/health', { method: 'DELETE' });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('not_found');
  });
});
