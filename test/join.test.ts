import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type TestServer } from './helpers.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/join.request.json', import.meta.url), 'utf8'),
) as { inviteToken: string; nickname: string };

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

describe('POST /api/v1/join (club.md §5-4, §7)', () => {
  it('is not found before the server is claimed', async () => {
    const reply = await server.api('/api/v1/join', { body: fixture });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('not_found');
  });

  it('exchanges the invite token for a member token, in the shape of §5-4', async () => {
    const owner = await claimOwner(server);
    const invite = await server.api('/api/v1/invite', { token: owner.token });
    const reply = await server.api('/api/v1/join', {
      body: { ...fixture, inviteToken: invite.json.token },
    });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      club: { id: owner.clubId, name: "Yoh's Club", createdAt: expect.any(String) },
      member: {
        id: expect.stringMatching(/^m_/),
        nickname: 'Ken',
        role: 'member',
        joinedAt: expect.any(String),
      },
      memberToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const club = await server.api('/api/v1/club', { token: reply.json.memberToken });
    expect(club.json.me.nickname).toBe('Ken');
  });

  it('refuses an unknown token and a rotated one with invite_expired', async () => {
    const owner = await claimOwner(server);
    const unknown = await server.api('/api/v1/join', {
      body: { inviteToken: 'nope', nickname: 'Ken' },
    });
    expect(unknown.status).toBe(409);
    expect(unknown.json.error.code).toBe('invite_expired');

    const old = (await server.api('/api/v1/invite', { token: owner.token })).json.token;
    const rotated = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'member' },
    });
    expect(rotated.status).toBe(201);
    expect(rotated.json.token).not.toBe(old);

    const stale = await server.api('/api/v1/join', {
      body: { inviteToken: old, nickname: 'Ken' },
    });
    expect(stale.json.error.code).toBe('invite_expired');
    const fresh = await server.api('/api/v1/join', {
      body: { inviteToken: rotated.json.token, nickname: 'Ken' },
    });
    expect(fresh.status).toBe(201);
  });

  it('caps the club at maxMembers, owners included', async () => {
    await server.reopen({ limits: { maxMembers: 2 } });
    const owner = await claimOwner(server);
    await joinMember(server, owner, 'Ken');
    const invite = await server.api('/api/v1/invite', { token: owner.token });
    const third = await server.api('/api/v1/join', {
      body: { inviteToken: invite.json.token, nickname: 'Mika' },
    });
    expect(third.status).toBe(409);
    expect(third.json.error.code).toBe('too_many_members');
  });

  it('limits join attempts per IP, reading the first X-Forwarded-For hop', async () => {
    await server.reopen({ limits: { ipPerMinute: 2 } });
    await claimOwner(server);
    const attempt = (ip: string) =>
      server.api('/api/v1/join', {
        body: { inviteToken: 'nope', nickname: 'Ken' },
        headers: { 'X-Forwarded-For': `${ip}, 10.0.0.1` },
      });
    expect((await attempt('198.51.100.7')).status).toBe(409);
    expect((await attempt('198.51.100.7')).status).toBe(409);
    const third = await attempt('198.51.100.7');
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('rate_limited');
    expect((await attempt('198.51.100.8')).status).toBe(409);

    server.clock.advance(61_000);
    expect((await attempt('198.51.100.7')).status).toBe(409);
  });

  it('validates the nickname the same way the claim does', async () => {
    const owner = await claimOwner(server);
    const invite = await server.api('/api/v1/invite', { token: owner.token });
    const reply = await server.api('/api/v1/join', {
      body: { inviteToken: invite.json.token, nickname: '   ' },
    });
    expect(reply.status).toBe(400);
  });
});

describe('POST /api/v1/join on an open server', () => {
  it('rejects a missing invite token when the server is closed', async () => {
    await claimOwner(server);
    const reply = await server.api('/api/v1/join', { body: { nickname: 'Ken' } });
    expect(reply.status).toBe(400);
    expect(reply.json.error).toEqual({
      code: 'invalid_request',
      message: 'inviteToken is required',
    });
  });

  it('takes a nickname alone and answers in the shape of §5-4 as a member', async () => {
    await server.reopen({ openJoin: true });
    const early = await server.api('/api/v1/join', { body: { nickname: 'Ken' } });
    expect(early.status).toBe(404);
    const owner = await claimOwner(server);
    const reply = await server.api('/api/v1/join', { body: { nickname: 'Ken' } });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      club: { id: owner.clubId, name: "Yoh's Club", createdAt: expect.any(String) },
      member: {
        id: expect.stringMatching(/^m_/),
        nickname: 'Ken',
        role: 'member',
        joinedAt: expect.any(String),
      },
      memberToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const club = await server.api('/api/v1/club', { token: reply.json.memberToken });
    expect(club.json.me.role).toBe('member');
  });

  it('still honours a member invite and an owner link', async () => {
    await server.reopen({ openJoin: true });
    const owner = await claimOwner(server);
    const invite = await server.api('/api/v1/invite', { token: owner.token });
    const viaInvite = await server.api('/api/v1/join', {
      body: { inviteToken: invite.json.token, nickname: 'Ken' },
    });
    expect(viaInvite.status).toBe(201);
    expect(viaInvite.json.member.role).toBe('member');
    const link = await server.api('/api/v1/invite', {
      token: owner.token,
      body: { role: 'owner' },
    });
    const viaLink = await server.api('/api/v1/join', {
      body: { inviteToken: link.json.token, nickname: 'Mia' },
    });
    expect(viaLink.status).toBe(201);
    expect(viaLink.json.member.role).toBe('owner');
    const bad = await server.api('/api/v1/join', { body: { inviteToken: 'nope', nickname: 'X' } });
    expect(bad.status).toBe(409);
  });

  it('applies the member cap to open joins', async () => {
    await server.reopen({ openJoin: true, limits: { maxMembers: 2 } });
    await claimOwner(server);
    expect((await server.api('/api/v1/join', { body: { nickname: 'Ken' } })).status).toBe(201);
    const full = await server.api('/api/v1/join', { body: { nickname: 'Mia' } });
    expect(full.status).toBe(409);
    expect(full.json.error.code).toBe('too_many_members');
  });
});
