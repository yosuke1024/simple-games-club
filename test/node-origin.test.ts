/** Node accepts Host header text that is not necessarily a valid URL authority. */
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimOwner, startServer, type TestServer } from './helpers.js';

let server: TestServer;

/** Use Node HTTP directly: fetch implementations may replace the Host header. */
function rawApi(path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(`${server.url}${path}`, { headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () =>
          resolve({
            status: res.statusCode!,
            text: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      });
      req.once('error', reject);
      req.end();
    },
  );
}

describe.skipIf(process.env.CLUB_IMPL === 'workers')('Node request-origin validation', () => {
  beforeEach(async () => {
    server = await startServer({ managed: true });
  });
  afterEach(async () => {
    await server?.close();
  });

  it.each([
    ['Host', '%'],
    ['X-Forwarded-Host', '%'],
    ['X-Forwarded-Host', 'club.example.com/private'],
    ['X-Forwarded-Proto', 'javascript'],
  ])('rejects an invalid %s on both APIs and keeps serving requests', async (name, value) => {
    for (const path of ['/api/v1/health', '/api/v1/managed/plans']) {
      const response = await rawApi(path, { [name!]: value! });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toMatchObject({ error: { code: 'invalid_request' } });
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await server.api(path)).status).toBe(200);
    }
  });

  it('uses the configured public origin even when unused host headers are malformed', async () => {
    await server.reopen({ publicOrigin: 'https://clubs.example.com' });
    const owner = await claimOwner(server);
    const headers = {
      Host: '%',
      'X-Forwarded-Host': '%',
      'X-Forwarded-Proto': 'javascript',
      Authorization: `Bearer ${owner.token}`,
      Origin: 'https://clubs.example.com',
    };
    const invite = await rawApi('/api/v1/invite', headers);
    expect(invite.status).toBe(200);
    expect(JSON.parse(invite.text).url).toMatch(/^https:\/\/clubs\.example\.com\/join#invite=/);
    expect(invite.headers['access-control-allow-origin']).toBe('https://clubs.example.com');
    const managed = await rawApi('/api/v1/managed/plans', headers);
    expect(managed.status).toBe(200);
    expect(managed.headers['access-control-allow-origin']).toBe('https://clubs.example.com');
  });

  it('contains an unexpected API rejection instead of leaving an unhandled promise', async () => {
    // A bad deployment value reaches the shared API's URL parser. The adapter
    // still has to produce a response and leave the Node process alive.
    await server.reopen({ publicOrigin: 'not a URL' });
    for (const path of ['/api/v1/health', '/api/v1/managed/plans']) {
      const response = await rawApi(path, {});
      expect(response.status).toBe(500);
      expect(JSON.parse(response.text)).toMatchObject({ error: { code: 'internal_error' } });
    }
    await server.reopen({ publicOrigin: null });
    expect((await server.api('/api/v1/health')).status).toBe(200);
  });
});
