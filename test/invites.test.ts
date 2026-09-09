import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('the invite URL (club.md §7-1)', () => {
  it('puts the token in the fragment of /join on the request host', async () => {
    const owner = await claimOwner(server);
    const invite = await server.api('/api/v1/invite', { token: owner.token });
    expect(invite.json.url).toBe(`${server.url}/join#invite=${invite.json.token}`);
  });

  it('prefers the configured public origin, then the proxy headers', async () => {
    const owner = await claimOwner(server);
    const forwarded = await server.api('/api/v1/invite', {
      token: owner.token,
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'club.example.com' },
    });
    expect(forwarded.json.url).toMatch(/^https:\/\/club\.example\.com\/join#invite=/);

    await server.reopen({ publicOrigin: 'https://suzuki.up.railway.app' });
    const configured = await server.api('/api/v1/invite', {
      token: owner.token,
      headers: { 'X-Forwarded-Host': 'ignored.example.com' },
    });
    expect(configured.json.url).toMatch(/^https:\/\/suzuki\.up\.railway\.app\/join#invite=/);
  });
});

describe('POST /api/v1/invite { role: "owner" } — owner links (club.md §8-3)', () => {
  it('mints a one-use link that expires in a day and makes the device that opens it an owner', async () => {
    const owner = await claimOwner(server);
    const link = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    expect(link.status).toBe(201);
    expect(link.json).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      url: `${server.url}/join#invite=${link.json.token}`,
      expiresAt: new Date(server.clock.now.getTime() + 24 * 3_600_000).toISOString(),
    });

    const second = await server.api('/api/v1/join', {
      body: { inviteToken: link.json.token, nickname: 'Yoh (tablet)' },
    });
    expect(second.status).toBe(201);
    expect(second.json.member.role).toBe('owner');
    expect((await server.api('/api/v1/invite', { token: second.json.memberToken })).status).toBe(
      200,
    );

    const reuse = await server.api('/api/v1/join', {
      body: { inviteToken: link.json.token, nickname: 'Eve' },
    });
    expect(reuse.status).toBe(409);
    expect(reuse.json.error.code).toBe('invite_expired');
  });

  it('is dead after 24 hours, unused', async () => {
    const owner = await claimOwner(server);
    const link = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    server.clock.advance(24 * 3_600_000 + 1);
    const late = await server.api('/api/v1/join', {
      body: { inviteToken: link.json.token, nickname: 'Yoh (tablet)' },
    });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe('invite_expired');
  });

  it('does not mint, and does not admit, a sixth owner', async () => {
    await server.reopen({ limits: { maxOwners: 2 } });
    const owner = await claimOwner(server);
    const link = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    // A second link before the first is used: allowed to mint (still one owner).
    const spare = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    expect(spare.status).toBe(201);
    await server.api('/api/v1/join', { body: { inviteToken: link.json.token, nickname: 'Two' } });

    const third = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    expect(third.status).toBe(409);
    expect(third.json.error.code).toBe('too_many_owners');
    const viaSpare = await server.api('/api/v1/join', {
      body: { inviteToken: spare.json.token, nickname: 'Three' },
    });
    expect(viaSpare.status).toBe(409);
    expect(viaSpare.json.error.code).toBe('too_many_owners');
  });

  it('leaves the member invite alone', async () => {
    const owner = await claimOwner(server);
    const before = (await server.api('/api/v1/invite', { token: owner.token })).json.token;
    await server.api('/api/v1/invite', { token: owner.token, body: { role: 'owner' } });
    const after = (await server.api('/api/v1/invite', { token: owner.token })).json.token;
    expect(after).toBe(before);
    expect((await joinMember(server, owner, 'Ken')).memberId).toMatch(/^m_/);
  });

  it('rejects any other role', async () => {
    const owner = await claimOwner(server);
    const reply = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'admin' },
    });
    expect(reply.status).toBe(400);
  });
});
