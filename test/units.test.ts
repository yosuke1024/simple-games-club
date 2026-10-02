import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerToken, hashToken, randomToken, safeEqual } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { RateLimiter } from '../src/http/rateLimit.js';
import { Router } from '../src/http/router.js';

describe('tokens (club.md §5-1)', () => {
  it('hashes with the secret as pepper', () => {
    expect(hashToken('s', 't')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('s', 't')).toBe(hashToken('s', 't'));
    expect(hashToken('s', 't')).not.toBe(hashToken('other', 't'));
  });

  it('makes base64url tokens of the requested entropy', () => {
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).not.toBe(randomToken(16));
  });

  it('reads a bearer header and nothing else', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
  });

  it('compares in constant time without throwing on length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('is a sliding window per key', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 100)).toBe(true);
    expect(limiter.allow('a', 200)).toBe(false);
    expect(limiter.allow('b', 200)).toBe(true);
    expect(limiter.allow('a', 1001)).toBe(true);
    expect(limiter.allow('a', 1050)).toBe(false);
  });
});

describe('Router', () => {
  it('matches by method and segments, capturing :params', () => {
    const router = new Router();
    const handler = () => ({ status: 200 });
    router.add(
      'GET',
      '/api/v1/challenges/:id/results',
      { auth: 'member', limit: 'member' },
      handler,
    );
    expect(router.match('GET', '/api/v1/challenges/ch_1/results')?.params).toEqual({ id: 'ch_1' });
    expect(router.match('POST', '/api/v1/challenges/ch_1/results')).toBeNull();
    expect(router.match('GET', '/api/v1/challenges/ch_1')).toBeNull();
    expect(router.match('GET', '/api/v1/challenges/ch_1/results/')?.params).toEqual({ id: 'ch_1' });
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sg-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('generates a secret into the data directory once and reuses it', () => {
    const first = loadConfig({ CLUB_DATA_DIR: dir });
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'secret'), 'utf8').trim()).toBe(first.secret);
    expect(loadConfig({ CLUB_DATA_DIR: dir }).secret).toBe(first.secret);
    expect(loadConfig({ CLUB_DATA_DIR: dir, CLUB_SECRET: 'given' }).secret).toBe('given');
  });

  it("derives the public origin and dashboard link from Railway's variables", () => {
    const config = loadConfig({
      CLUB_DATA_DIR: dir,
      RAILWAY_PUBLIC_DOMAIN: 'suzuki.up.railway.app',
      RAILWAY_PROJECT_ID: 'p1',
      RAILWAY_SERVICE_ID: 's1',
      RAILWAY_ENVIRONMENT_ID: 'e1',
    });
    expect(config.publicOrigin).toBe('https://suzuki.up.railway.app');
    expect(config.hosting).toEqual({
      provider: 'railway',
      manageUrl: 'https://railway.com/project/p1/service/s1?environmentId=e1',
    });
    const explicit = loadConfig({
      CLUB_DATA_DIR: dir,
      CLUB_PUBLIC_ORIGIN: 'https://club.example.com/',
      CLUB_HOSTING_PROVIDER: 'fly',
      CLUB_HOSTING_MANAGE_URL: 'https://fly.io/apps/x',
      CLUB_CORS_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173/',
      CLUB_SETUP_KEY: '  key  ',
    });
    expect(explicit.publicOrigin).toBe('https://club.example.com');
    expect(explicit.hosting).toEqual({ provider: 'fly', manageUrl: 'https://fly.io/apps/x' });
    expect(explicit.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(explicit.setupKey).toBe('key');
    expect(loadConfig({ CLUB_DATA_DIR: dir }).setupKey).toBeNull();
  });
});

describe('wrangler.toml (the Cloudflare deployment)', () => {
  // Comments stripped: the file is allowed to *mention* a name it must not set.
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');

  it('never ships the test-only bindings the Workers harness sets', () => {
    // CLUB_TEST_MODE lets a request choose the clock; CLUB_TRUST_PROXY makes
    // the object believe X-Forwarded-For. Both exist for test/impl/workers.ts.
    expect(toml).not.toMatch(/CLUB_TEST_MODE/);
    expect(toml).not.toMatch(/CLUB_TRUST_PROXY/);
    // Secrets are set on the deployment, never written here.
    expect(toml).not.toMatch(/^\s*CLUB_SETUP_KEY\s*=/m);
    expect(toml).not.toMatch(/^\s*CLUB_SECRET\s*=/m);
  });

  it('keeps the object on SQLite storage — the only backend the Free plan has', () => {
    expect(toml).toMatch(/new_sqlite_classes\s*=\s*\[\s*"ClubObject"\s*\]/);
    expect(toml).not.toMatch(/new_classes\s*=/);
  });
});
