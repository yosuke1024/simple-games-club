import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

let server: TestServer;
afterEach(() => server.close());

describe('without a web build (club.md §7-1)', () => {
  beforeEach(async () => {
    server = await startServer();
  });

  it('says so on / and /join instead of 404ing, and still redirects /join/', async () => {
    const root = await server.api('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toMatch(/^text\/html/);
    expect(root.text).toContain('web build is not installed');
    expect((await server.api('/join')).status).toBe(200);
    expect(root.headers.get('x-club-api')).toBe('1');

    const slash = await fetch(`${server.url}/join/`, { redirect: 'manual' });
    expect(slash.status).toBe(301);
    expect(slash.headers.get('location')).toBe('/join');
    expect((await server.api('/assets/app.js')).status).toBe(404);
  });
});

describe('with a web build (club.md §7-1)', () => {
  let webDir: string;
  beforeEach(async () => {
    webDir = mkdtempSync(join(tmpdir(), 'sg-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Simple Games</title>');
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(webDir, 'secret.txt'), 'not served outside');
    server = await startServer({ webDir });
  });
  afterEach(() => rmSync(webDir, { recursive: true, force: true }));

  it('serves index.html at / and /join, assets immutable, the entry uncached', async () => {
    const root = await server.api('/');
    expect(root.text).toContain('<title>Simple Games</title>');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    const join_ = await server.api('/join');
    expect(join_.text).toContain('<title>Simple Games</title>');

    const asset = await server.api('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const head = await fetch(`${server.url}/assets/index-abc123.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('14');
  });

  it('never leaves the web directory', async () => {
    expect((await server.api('/../package.json')).status).toBe(404);
    expect((await server.api('/assets/../../package.json')).status).toBe(404);
    expect((await server.api('/%2e%2e/package.json')).status).toBe(404);
    expect((await server.api('/nope.html')).status).toBe(404);
    // Files inside it are served — the web build has nothing to hide, and
    // Vite's manifest is part of it.
    expect((await server.api('/secret.txt')).status).toBe(200);
  });

  it('keeps /api/ out of the static handler', async () => {
    const reply = await server.api('/api/v1/health');
    expect(reply.json.ok).toBe(true);
  });
});
