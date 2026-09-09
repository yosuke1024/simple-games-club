import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, joinMember, startServer, type Session, type TestServer } from './helpers.js';

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const createFixture = load('challenge.create.request.json');
const submitFixture = load('result.submit.request.json');

let server: TestServer;
let owner: Session;
let member: Session;
beforeEach(async () => {
  server = await startServer();
  owner = await claimOwner(server, 'Yoh');
  member = await joinMember(server, owner, 'Ken');
});
afterEach(() => server.close());

const create = (session: Session, overrides: Record<string, unknown> = {}) =>
  server.api('/api/v1/challenges', {
    token: session.token,
    body: { ...createFixture, ...overrides },
  });

describe('POST /api/v1/challenges (club.md §5-4, §6-3)', () => {
  it("creates the challenge and the creator's result in one request", async () => {
    const reply = await create(owner);
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      id: expect.stringMatching(/^ch_/),
      gameId: 'sudoku',
      contractVersion: 1,
      params: { difficulty: 'hard' },
      seed: 'sudoku-free-mf8k2a-1x9q',
      boardDigest: 'sd1:9f3a1c07',
      title: null,
      createdBy: { id: owner.memberId, nickname: 'Yoh' },
      createdAt: expect.any(String),
      resultCount: 1,
      mine: true,
    });
    const results = await server.api(`/api/v1/challenges/${reply.json.id}/results`, {
      token: member.token,
    });
    expect(results.json).toEqual([
      {
        memberId: owner.memberId,
        nickname: 'Yoh',
        submittedAt: expect.any(String),
        outcome: 'completed',
        facts: { elapsedSeconds: 271, mistakes: 0, hints: 1 },
      },
    ]);
  });

  it('keeps a title when given one, empty included', async () => {
    expect((await create(owner, { title: 'Friday puzzle' })).json.title).toBe('Friday puzzle');
    expect((await create(owner, { title: '' })).json.title).toBe('');
    expect((await create(owner, { title: 'x'.repeat(61) })).status).toBe(400);
  });

  it('answers 501 for a contract version it does not know', async () => {
    const reply = await create(owner, { contractVersion: 2 });
    expect(reply.status).toBe(501);
    expect(reply.json.error.code).toBe('unsupported_version');
  });

  it('bounds params and facts at 1KB and insists on objects', async () => {
    const big = { pad: 'x'.repeat(1100) };
    expect((await create(owner, { params: big })).status).toBe(400);
    expect((await create(owner, { result: { outcome: 'completed', facts: big } })).status).toBe(
      400,
    );
    expect((await create(owner, { params: [1, 2] })).status).toBe(400);
    expect((await create(owner, { result: undefined })).status).toBe(400);
    expect((await create(owner, { seed: '' })).status).toBe(400);
    expect((await create(owner, { gameId: 'Sudoku!' })).status).toBe(400);
    expect((await create(owner, { result: { outcome: 'won', facts: {} } })).status).toBe(400);
  });
});

describe('GET /api/v1/challenges (club.md §5-3)', () => {
  it('lists newest first, marks mine, and pages with ?after=', async () => {
    await server.reopen({ limits: { challengePage: 2 } });
    const a = (await create(owner, { seed: 'a' })).json.id;
    const b = (await create(member, { seed: 'b' })).json.id;
    const c = (await create(owner, { seed: 'c' })).json.id;

    const first = await server.api('/api/v1/challenges', { token: member.token });
    expect(first.status).toBe(200);
    expect(first.json.map((ch: { id: string }) => ch.id)).toEqual([c, b]);
    expect(first.json.map((ch: { mine: boolean }) => ch.mine)).toEqual([false, true]);

    const rest = await server.api(`/api/v1/challenges?after=${b}`, { token: member.token });
    expect(rest.json.map((ch: { id: string }) => ch.id)).toEqual([a]);
    const end = await server.api(`/api/v1/challenges?after=${a}`, { token: member.token });
    expect(end.json).toEqual([]);
  });

  it('serves one challenge by id and 404s an unknown or deleted one', async () => {
    const id = (await create(owner)).json.id;
    expect((await server.api(`/api/v1/challenges/${id}`, { token: member.token })).status).toBe(
      200,
    );
    const missing = await server.api('/api/v1/challenges/ch_nope', { token: member.token });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');
  });
});

describe('DELETE /api/v1/challenges/:id (club.md §5-3)', () => {
  it('is for the creator or an owner, and takes the results with it', async () => {
    const id = (await create(owner)).json.id;
    const byMember = await server.api(`/api/v1/challenges/${id}`, {
      method: 'DELETE',
      token: member.token,
    });
    expect(byMember.status).toBe(403);

    const mine = (await create(member)).json.id;
    expect(
      (await server.api(`/api/v1/challenges/${mine}`, { method: 'DELETE', token: member.token }))
        .status,
    ).toBe(204);
    expect(
      (await server.api(`/api/v1/challenges/${id}`, { method: 'DELETE', token: owner.token }))
        .status,
    ).toBe(204);
    expect((await server.api(`/api/v1/challenges/${id}`, { token: owner.token })).status).toBe(404);
    expect(
      (await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token })).status,
    ).toBe(404);
    expect((await server.api('/api/v1/challenges', { token: owner.token })).json).toEqual([]);
  });
});

describe('POST /api/v1/challenges/:id/results (club.md §5-4)', () => {
  it('records one result per member, in the shape of §5-2', async () => {
    const id = (await create(owner)).json.id;
    const reply = await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: submitFixture,
    });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      memberId: member.memberId,
      nickname: 'Ken',
      submittedAt: expect.any(String),
      outcome: 'completed',
      facts: { elapsedSeconds: 305, mistakes: 2, hints: 0 },
    });
    const challenge = await server.api(`/api/v1/challenges/${id}`, { token: member.token });
    expect(challenge.json.resultCount).toBe(2);
    expect(challenge.json.mine).toBe(true);
  });

  it('refuses a second submission — from the member and from the creator', async () => {
    const id = (await create(owner)).json.id;
    await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: submitFixture,
    });
    const again = await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: { ...submitFixture, facts: { elapsedSeconds: 100, mistakes: 0, hints: 0 } },
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('already_submitted');
    const creator = await server.api(`/api/v1/challenges/${id}/results`, {
      token: owner.token,
      body: submitFixture,
    });
    expect(creator.json.error.code).toBe('already_submitted');
    const results = await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token });
    expect(results.json).toHaveLength(2);
  });

  it('refuses a result for a different board and stores nothing', async () => {
    const id = (await create(owner)).json.id;
    const reply = await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: { ...submitFixture, boardDigest: 'sd1:00000000' },
    });
    expect(reply.status).toBe(409);
    expect(reply.json.error.code).toBe('board_mismatch');
    const results = await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token });
    expect(results.json).toHaveLength(1);
    // Still free to submit the right board afterwards.
    const ok = await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: submitFixture,
    });
    expect(ok.status).toBe(201);
  });

  it('accepts a played outcome with empty facts (a loss), and 501s an unknown version', async () => {
    const id = (await create(owner)).json.id;
    const played = await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: { contractVersion: 1, boardDigest: 'sd1:9f3a1c07', outcome: 'played', facts: {} },
    });
    expect(played.status).toBe(201);
    expect(played.json.outcome).toBe('played');
    const other = await joinMember(server, owner, 'Mika', '203.0.113.11');
    const versioned = await server.api(`/api/v1/challenges/${id}/results`, {
      token: other.token,
      body: { ...submitFixture, contractVersion: 3 },
    });
    expect(versioned.status).toBe(501);
  });

  it("keeps a removed member's result under the nickname they submitted with", async () => {
    const id = (await create(owner)).json.id;
    await server.api(`/api/v1/challenges/${id}/results`, {
      token: member.token,
      body: submitFixture,
    });
    await server.api(`/api/v1/members/${member.memberId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    const results = await server.api(`/api/v1/challenges/${id}/results`, { token: owner.token });
    expect(results.json.map((r: { nickname: string }) => r.nickname)).toEqual(['Yoh', 'Ken']);
    const club = await server.api('/api/v1/club', { token: owner.token });
    expect(club.json.members.map((m: { nickname: string }) => m.nickname)).toEqual(['Yoh']);
  });
});
