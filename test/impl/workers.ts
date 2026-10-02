/**
 * The Cloudflare deployment for the contract tests: the bundle wrangler
 * built (test/workers/globalSetup.ts) in Miniflare's workerd, with the
 * Durable Object persisted to a temp directory so `reopen()` — a restart
 * with new bindings — keeps the club like a redeploy would.
 *
 * Two things the Node harness injects directly travel as bindings here:
 * `CLUB_TRUST_PROXY=1`, because workerd (unlike Cloudflare) cannot vary the
 * client address, so the tests name it with `X-Forwarded-For` as they do on
 * Node; and `CLUB_TEST_MODE=1`, which makes the object take its clock from
 * `X-Club-Test-Now` (src/worker/env.ts). Neither is set in wrangler.toml.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, type V4WorkerOptions } from 'miniflare';
import { DEFAULTS, apiCaller, newClock, type ServerOptions, type TestServer } from '../helpers.js';
import { OPTIONS_FILE, OUT_DIR, ROOT } from '../workers/globalSetup.js';

type Bindings = Record<string, string>;

function bindingsFor(options: ServerOptions): Bindings {
  const bindings: Bindings = {
    CLUB_SECRET: 'test-secret',
    CLUB_TRUST_PROXY: '1',
    CLUB_TEST_MODE: '1',
    CLUB_LIMITS: JSON.stringify(options.limits),
    CLUB_CORS_ORIGINS: options.corsOrigins.join(','),
    CLUB_HOSTING_PROVIDER: options.hosting.provider ?? '',
    CLUB_HOSTING_MANAGE_URL: options.hosting.manageUrl ?? '',
  };
  if (options.openJoin) bindings.CLUB_OPEN_JOIN = '1';
  if (options.setupKey !== null) bindings.CLUB_SETUP_KEY = options.setupKey;
  if (options.publicOrigin !== null) bindings.CLUB_PUBLIC_ORIGIN = options.publicOrigin;
  return bindings;
}

export async function startWorkersServer(overrides: Partial<ServerOptions>): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'sg-club-do-'));
  const clock = newClock();
  let options: ServerOptions = { ...DEFAULTS, ...overrides };
  const fromWrangler = JSON.parse(readFileSync(OPTIONS_FILE, 'utf8')) as V4WorkerOptions;

  const miniflareOptions = () =>
    convertV4MiniflareOptions({
      workers: [
        {
          ...fromWrangler,
          rootPath: ROOT,
          modulesRoot: ROOT,
          modules: true,
          scriptPath: join(OUT_DIR, 'index.js'),
          // wrangler.toml's [vars] are replaced, not merged: the tests choose every value.
          bindings: bindingsFor(options),
        } as V4WorkerOptions,
      ],
      durableObjectsPersist: dir,
    });

  const mf = new Miniflare(miniflareOptions());
  let url = (await mf.ready).origin;

  return {
    get url() {
      return url;
    },
    clock,
    api: apiCaller(
      () => url,
      () => ({ 'X-Club-Test-Now': clock.now.toISOString() }),
    ),
    async reopen(next = {}) {
      options = { ...options, ...next };
      await mf.setOptions(miniflareOptions());
      url = (await mf.ready).origin;
    },
    async close() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
