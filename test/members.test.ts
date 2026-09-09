import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('GET /api/v1/club and PATCH /api/v1/club (club.md §5-3)', () => {
  it('lists the club, the caller, and the members in join order', async () => {
    const owner = await claimOwner(server, 'Yoh');
    await joinMember(server, owner, 'Ken');
    const reply = await server.api('/api/v1/club', { token: owner.token });
    expect(reply.json).toEqual({
      club: { id: owner.clubId, name: "Yoh's Club", createdAt: expect.any(String) },
      me: { id: owner.memberId, nickname: 'Yoh', role: 'owner', joinedAt: expect.any(String) },
      members: [
        { id: owner.memberId, nickname: 'Yoh', role: 'owner', joinedAt: expect.any(String) },
        { id: expect.any(String), nickname: 'Ken', role: 'member', joinedAt: expect.any(String) },
      ],
    });
  });

  it('lets an owner rename the club within 40 characters', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const renamed = await server.api('/api/v1/club', {
      method: 'PATCH',
      token: owner.token,
      body: { name: 'Suzuki Family' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.name).toBe('Suzuki Family');
    expect((await server.api('/api/v1/club', { token: member.token })).json.club.name).toBe(
      'Suzuki Family',
    );
    expect(
      (
        await server.api('/api/v1/club', {
          method: 'PATCH',
          token: member.token,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await server.api('/api/v1/club', {
          method: 'PATCH',
          token: owner.token,
          body: { name: 'x'.repeat(41) },
        })
      ).status,
    ).toBe(400);
  });
});

describe('DELETE /api/v1/members/:id (club.md §5-3, §8-3)', () => {
  it('removes a member once, and 404s afterwards', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const path = `/api/v1/members/${member.memberId}`;
    expect((await server.api(path, { method: 'DELETE', token: owner.token })).status).toBe(204);
    const again = await server.api(path, { method: 'DELETE', token: owner.token });
    expect(again.status).toBe(404);
    expect(
      (await server.api('/api/v1/members/m_nope', { method: 'DELETE', token: owner.token })).status,
    ).toBe(404);
  });

  it('never removes the last owner, but does remove one of two', async () => {
    const owner = await claimOwner(server);
    const self = await server.api(`/api/v1/members/${owner.memberId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    expect(self.status).toBe(409);
    expect(self.json.error.code).toBe('last_owner');

    const link = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    const second = await server.api('/api/v1/join', {
      body: { inviteToken: link.json.token, nickname: 'Yoh (tablet)' },
    });
    const removed = await server.api(`/api/v1/members/${owner.memberId}`, {
      method: 'DELETE',
      token: second.json.memberToken,
    });
    expect(removed.status).toBe(204);
    expect((await server.api('/api/v1/club', { token: owner.token })).status).toBe(401);
    const last = await server.api(`/api/v1/members/${second.json.member.id}`, {
      method: 'DELETE',
      token: second.json.memberToken,
    });
    expect(last.json.error.code).toBe('last_owner');
  });

  it('is an owner operation', async () => {
    const owner = await claimOwner(server);
    const member = await joinMember(server, owner);
    const reply = await server.api(`/api/v1/members/${owner.memberId}`, {
      method: 'DELETE',
      token: member.token,
    });
    expect(reply.status).toBe(403);
  });
});
