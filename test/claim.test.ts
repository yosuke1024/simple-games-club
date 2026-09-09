import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_KEY, claimOwner, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('POST /api/v1/claim (club.md §8-3)', () => {
  it('turns the setup key into the first owner and names the club after them', async () => {
    const reply = await server.api('/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'Yoh' },
    });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      club: { id: expect.stringMatching(/^c_/), name: "Yoh's Club", createdAt: expect.any(String) },
      member: {
        id: expect.stringMatching(/^m_/),
        nickname: 'Yoh',
        role: 'owner',
        joinedAt: expect.any(String),
      },
      memberToken: expect.any(String),
    });
    // 256 bit, base64url.
    expect(reply.json.memberToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('takes a club name when one is given', async () => {
    const reply = await server.api('/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'Yoh', clubName: 'Suzuki Family' },
    });
    expect(reply.json.club.name).toBe('Suzuki Family');
  });

  it('refuses a wrong key, a spent key, and a server with no key, all the same way', async () => {
    const wrong = await server.api('/api/v1/claim', {
      body: { setupKey: 'not-the-key', nickname: 'Eve' },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error.code).toBe('setup_key_used');

    await claimOwner(server);
    const spent = await server.api('/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'Yoh again' },
    });
    expect(spent.status).toBe(409);
    expect(spent.json.error.code).toBe('setup_key_used');

    await server.reopen({ setupKey: null });
    const none = await server.api('/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'Yoh' },
    });
    expect(none.status).toBe(409);
    expect(none.json.error.code).toBe('setup_key_used');
  });

  it('accepts one more claim after the key is re-set in the environment, keeping the club', async () => {
    const first = await claimOwner(server, 'Yoh');
    await server.reopen({ setupKey: 'a-new-key-after-losing-the-phone' });

    const stale = await server.api('/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'Eve' },
    });
    expect(stale.json.error.code).toBe('setup_key_used');

    const again = await server.api('/api/v1/claim', {
      body: { setupKey: 'a-new-key-after-losing-the-phone', nickname: 'Yoh (new phone)' },
    });
    expect(again.status).toBe(201);
    expect(again.json.club.id).toBe(first.clubId);
    expect(again.json.member.role).toBe('owner');

    const club = await server.api('/api/v1/club', { token: again.json.memberToken });
    expect(club.json.members.map((m: { role: string }) => m.role)).toEqual(['owner', 'owner']);
  });

  it('creates the member invite at the claim, so the owner can share at once', async () => {
    const owner = await claimOwner(server);
    const invite = await server.api('/api/v1/invite', { token: owner.token });
    expect(invite.status).toBe(200);
    expect(invite.json.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('validates the nickname', async () => {
    const long = await server.api('/api/v1/claim', {
      body: { setupKey: SETUP_KEY, nickname: 'x'.repeat(25) },
    });
    expect(long.status).toBe(400);
    expect(long.json.error.code).toBe('invalid_request');
    const missing = await server.api('/api/v1/claim', { body: { setupKey: SETUP_KEY } });
    expect(missing.status).toBe(400);
  });
});
