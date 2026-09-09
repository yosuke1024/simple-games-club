import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('bearer auth (club.md §5-1)', () => {
  it('requires a member token on every route but health, claim and join', async () => {
    await claimOwner(server);
    const missing = await server.api('/api/v1/club');
    expect(missing.status).toBe(401);
    expect(missing.json.error.code).toBe('unauthorized');
    const garbage = await server.api('/api/v1/club', { token: 'not-a-token' });
    expect(garbage.status).toBe(401);
    const malformed = await server.api('/api/v1/club', {
      headers: { Authorization: 'Basic abc' },
    });
    expect(malformed.status).toBe(401);
  });

  it('keeps owner routes from members', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const reply = await server.api('/api/v1/invite', { token: member.token });
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe('forbidden');
  });

  it("makes a removed member's token a 401 at once", async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    expect((await server.api('/api/v1/club', { token: member.token })).status).toBe(200);
    const removed = await server.api(`/api/v1/members/${member.memberId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    expect(removed.status).toBe(204);
    expect((await server.api('/api/v1/club', { token: member.token })).status).toBe(401);
  });

  it('survives a restart: the token hash, not the token, is what the database holds', async () => {
    const owner = await claimOwner(server);
    await server.reopen();
    const reply = await server.api('/api/v1/club', { token: owner.token });
    expect(reply.status).toBe(200);
    expect(reply.json.me.role).toBe('owner');
  });

  it('limits each member to memberPerMinute requests, counted after auth', async () => {
    await server.reopen({ limits: { memberPerMinute: 2 } });
    const owner = await claimOwner(server);
    // A 401 costs no slot.
    await server.api('/api/v1/club', { token: 'wrong' });
    expect((await server.api('/api/v1/club', { token: owner.token })).status).toBe(200);
    expect((await server.api('/api/v1/club', { token: owner.token })).status).toBe(200);
    const limited = await server.api('/api/v1/club', { token: owner.token });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('rate_limited');
    server.clock.advance(61_000);
    expect((await server.api('/api/v1/club', { token: owner.token })).status).toBe(200);
  });
});
