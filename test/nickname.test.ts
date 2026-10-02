import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer({ openJoin: true });
  await claimOwner(server, 'Yoh');
});
afterEach(() => server.close());

let ipCounter = 0;
const join = (nickname: unknown) =>
  server.api('/api/v1/join', {
    body: { nickname },
    headers: { 'X-Forwarded-For': `198.51.100.${++ipCounter}` },
  });

describe('the nickname rule (club.md §17-1)', () => {
  it('trims, collapses runs of whitespace and keeps the rest', async () => {
    const reply = await join(' Ken  Suzuki ');
    expect(reply.status).toBe(201);
    expect(reply.json.member.nickname).toBe('Ken Suzuki');
  });

  it('refuses a name with no letter or number in it', async () => {
    for (const name of ['!!!', '- _ -', '😀', '   ']) {
      expect((await join(name)).status, name).toBe(400);
    }
    expect((await join('a!')).status).toBe(201);
    expect((await join('７')).status).toBe(201); // a number, full-width
    expect((await join('鈴木')).status).toBe(201);
  });

  it('refuses control, format, private-use and unassigned code points', async () => {
    expect((await join('Ke\u200Dn')).status).toBe(400); // zero-width joiner (Cf)
    expect((await join('Ke\u202En')).status).toBe(400); // right-to-left override (Cf)
    expect((await join('Ke\u0007n')).status).toBe(400); // bell (Cc)
    expect((await join('Ke\uE000n')).status).toBe(400); // private use (Co)
    expect((await join('Ke\u0378n')).status).toBe(400); // unassigned (Cn)
    expect((await join('Ke\uD800n')).status).toBe(400); // a lone surrogate (Cs)
  });

  it('stores composed and decomposed forms as the same name', async () => {
    const composed = await join('Ren\u00E9');
    const decomposed = await join('Rene\u0301');
    expect(composed.json.member.nickname).toBe('Ren\u00E9');
    expect(decomposed.json.member.nickname).toBe(composed.json.member.nickname);
  });

  it('allows 24 code points and refuses 25, counting an emoji as one', async () => {
    expect((await join('a'.repeat(24))).status).toBe(201);
    expect((await join('a'.repeat(25))).status).toBe(400);
    expect((await join(`a${'\u{1F600}'.repeat(23)}`)).status).toBe(201);
    expect((await join(7)).status).toBe(400);
  });

  it('applies to the claim as well', async () => {
    await server.reopen({ setupKey: 'another-setup-key-0123456789' });
    const reply = await server.api('/api/v1/claim', {
      body: { setupKey: 'another-setup-key-0123456789', nickname: '***' },
    });
    expect(reply.status).toBe(400);
  });
});
