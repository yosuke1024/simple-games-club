import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer({
    hosting: { provider: 'railway', manageUrl: 'https://railway.com/project/p/service/s' },
  });
});
afterEach(() => server.close());

describe('GET /api/v1/hosting (club.md §8-4)', () => {
  it('shows the dashboard link to owners only', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const asOwner = await server.api('/api/v1/hosting', { token: owner.token });
    expect(asOwner.json).toEqual({
      provider: 'railway',
      manageUrl: 'https://railway.com/project/p/service/s',
      referralUrl: null,
      lastActivityAt: expect.any(String),
    });
    const asMember = await server.api('/api/v1/hosting', { token: member.token });
    expect(asMember.json.manageUrl).toBeNull();
    expect(asMember.json.provider).toBe('railway');
  });

  it('moves lastActivityAt on every write', async () => {
    const owner = await claimOwner(server);
    const before = (await server.api('/api/v1/hosting', { token: owner.token })).json
      .lastActivityAt;
    server.clock.advance(3_600_000);
    await server.api('/api/v1/challenges', {
      token: owner.token,
      body: {
        gameId: 'sudoku',
        contractVersion: 1,
        params: { difficulty: 'easy' },
        seed: 's',
        boardDigest: 'sd1:00000000',
        result: { outcome: 'completed', facts: { elapsedSeconds: 1 } },
      },
    });
    const after = (await server.api('/api/v1/hosting', { token: owner.token })).json.lastActivityAt;
    expect(after > before).toBe(true);
  });
});

describe('PATCH /api/v1/hosting (club.md §8-4)', () => {
  it('lets an owner set and clear their own referral link, https only', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const set = await server.api('/api/v1/hosting', {
      method: 'PATCH',
      token: owner.token,
      body: { referralUrl: 'https://railway.com?referralCode=yoh' },
    });
    expect(set.status).toBe(200);
    expect(set.json.referralUrl).toBe('https://railway.com/?referralCode=yoh');
    // Members see the link — it is what their "Create your own Club" opens.
    expect((await server.api('/api/v1/hosting', { token: member.token })).json.referralUrl).toBe(
      'https://railway.com/?referralCode=yoh',
    );

    const http = await server.api('/api/v1/hosting', {
      method: 'PATCH',
      token: owner.token,
      body: { referralUrl: 'http://railway.com?referralCode=yoh' },
    });
    expect(http.status).toBe(400);
    const missing = await server.api('/api/v1/hosting', {
      method: 'PATCH',
      token: owner.token,
      body: {},
    });
    expect(missing.status).toBe(400);

    const cleared = await server.api('/api/v1/hosting', {
      method: 'PATCH',
      token: owner.token,
      body: { referralUrl: null },
    });
    expect(cleared.json.referralUrl).toBeNull();

    const byMember = await server.api('/api/v1/hosting', {
      method: 'PATCH',
      token: member.token,
      body: { referralUrl: null },
    });
    expect(byMember.status).toBe(403);
  });
});
