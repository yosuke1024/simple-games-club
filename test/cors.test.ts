import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, startServer, type TestServer } from './helpers.js';

let server: TestServer;
beforeEach(async () => {
  server = await startServer({ corsOrigins: ['http://localhost:5173'] });
});
afterEach(() => server.close());

const preflight = (origin: string) =>
  fetch(`${server.url}/api/v1/club`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });

describe('CORS (club.md §5-1)', () => {
  it('allows the two app origins, the server itself, and configured extras', async () => {
    for (const origin of ['https://localhost', 'capacitor://localhost', 'http://localhost:5173']) {
      const reply = await preflight(origin);
      expect(reply.status).toBe(204);
      expect(reply.headers.get('access-control-allow-origin')).toBe(origin);
      expect(reply.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
      expect(reply.headers.get('access-control-expose-headers')).toBe('X-Club-Api');
      expect(reply.headers.get('vary')).toBe('Origin');
    }
    const self = await preflight(server.url);
    expect(self.headers.get('access-control-allow-origin')).toBe(server.url);
  });

  it('gives any other origin no CORS headers at all', async () => {
    const reply = await preflight('https://pixapps.ai');
    expect(reply.status).toBe(204);
    expect(reply.headers.get('access-control-allow-origin')).toBeNull();
    const real = await server.api('/api/v1/health', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(real.status).toBe(200);
    expect(real.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('adds the headers to real responses too', async () => {
    const owner = await claimOwner(server);
    const reply = await server.api('/api/v1/club', {
      token: owner.token,
      headers: { Origin: 'capacitor://localhost' },
    });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
  });
});
