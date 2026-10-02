/**
 * The Cloudflare deployment: a Worker that owns the URL and a Durable Object
 * that owns the club. The Worker does no API work — it names the client
 * (`CF-Connecting-IP`, or the proxy headers when told to), forwards `/api/*`
 * to the object, and serves the web build from the assets binding. The
 * object runs the same `createApi` as the Node server (src/http/api.ts) on
 * its own SQLite, so club.md §5 is implemented once and carried twice.
 *
 * One deployment is one club (club.md §1), so one object, named by
 * `CLUB_OBJECT_NAME` (default `club`). The
 * name is the shard key and nothing else knows it: a deployment that one day
 * needs more than one object changes how the Worker derives the name, not
 * the contract (simple-games-club#1「One public room, but not necessarily one
 * permanent singleton internally」).
 */
import { DurableObject } from 'cloudflare:workers';
import { migrate, type SqlDriver } from '../db/driver.js';
import { Store } from '../db/store.js';
import { API_VERSION_HEADER, API_VERSION_VALUE, createApi, type Api } from '../http/api.js';
import { corsHeaders } from '../http/cors.js';
import { PLACEHOLDER_HTML } from '../http/placeholder.js';
import { sqlDriver, type RowCounter } from './driver.js';
import { apiConfigFrom, settingsFrom, type Env, type WorkerSettings } from './env.js';
import { randomHex } from '../auth/tokens.js';

/** The object's name when `CLUB_OBJECT_NAME` is not set. */
const DEFAULT_OBJECT_NAME = 'club';

/** Set by the Worker for the object; whatever a client sent under these names is overwritten. */
const CLIENT_IP_HEADER = 'X-Club-Client-Ip';
const ORIGIN_HEADER = 'X-Club-Origin';
/** Read only when `CLUB_TEST_MODE=1` (src/worker/env.ts). */
const TEST_NOW_HEADER = 'X-Club-Test-Now';
const ROWS_HEADER = 'X-Club-Rows';

const firstHop = (header: string | null): string | undefined =>
  header?.split(',')[0]?.trim() || undefined;

/** Cloudflare's own view of the client, unless this deployment sits behind another proxy. */
function clientIp(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstHop(request.headers.get('x-forwarded-for'));
    if (forwarded !== undefined) return forwarded;
  }
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

/** The origin invite URLs are built on (club.md §7-1). */
function selfOrigin(request: Request, url: URL, settings: WorkerSettings): string {
  if (settings.publicOrigin !== null) return settings.publicOrigin;
  if (settings.trustProxy) {
    const proto = firstHop(request.headers.get('x-forwarded-proto')) ?? url.protocol.slice(0, -1);
    const host = request.headers.get('x-forwarded-host') ?? url.host;
    return `${proto}://${host}`;
  }
  return url.origin;
}

const withApiHeader = (response: Response): Response => {
  const out = new Response(response.body, response);
  out.headers.set(API_VERSION_HEADER, API_VERSION_VALUE);
  return out;
};

/**
 * `/`, `/index.html` and `/join` are the web build's entry (club.md §7-1);
 * `/join/` is redirected because the build's relative paths would resolve
 * one directory too deep. Hashed assets never reach this code — the assets
 * binding serves them first (wrangler.toml `run_worker_first`) at no charge.
 */
async function servePage(request: Request, url: URL, env: Env): Promise<Response> {
  const base: Record<string, string> = { [API_VERSION_HEADER]: API_VERSION_VALUE };
  if (url.pathname === '/join/') {
    return new Response(null, { status: 301, headers: { ...base, Location: '/join' } });
  }
  const wantsIndex =
    url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/join';
  if (wantsIndex) {
    if (env.ASSETS !== undefined) {
      const index = await env.ASSETS.fetch(
        new Request(new URL('/index.html', url), { method: request.method }),
      );
      if (index.ok) {
        const out = withApiHeader(index);
        out.headers.set('Cache-Control', 'no-cache');
        return out;
      }
    }
    return new Response(request.method === 'HEAD' ? null : PLACEHOLDER_HTML, {
      status: 200,
      headers: { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
  if (env.ASSETS !== undefined) return withApiHeader(await env.ASSETS.fetch(request));
  return new Response('Not found', {
    status: 404,
    headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * `GET /api/v1/public` is answered from `caches.default` for the five minutes
 * its `Cache-Control` names (club.md §18): a hit never reaches the object. The
 * key is the object's name, the date (resolved, never blank) and — only for an origin CORS would allow — that origin,
 * because the cached response carries its `Access-Control-Allow-Origin`; an
 * arbitrary `Origin` header cannot mint keys. Only a 200 is stored.
 */
async function servePublic(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  settings: WorkerSettings,
  forward: () => Promise<Response>,
): Promise<Response> {
  const given = url.searchParams.get('date');
  if (given !== null && !/^\d{4}-\d{2}-\d{2}$/.test(given)) return forward();
  // No date means "today" on the object's clock: resolved here so the key never
  // outlives the day it was made for.
  const date = given ?? requestNow(request, settings.testMode).toISOString().slice(0, 10);
  const origin = request.headers.get('origin');
  const selfUrlOrigin = selfOrigin(request, url, settings);
  const allowed =
    origin !== null &&
    Object.keys(corsHeaders(origin, selfUrlOrigin, apiConfigFrom(env, '').corsOrigins)).length > 0;
  const objectName = env.CLUB_OBJECT_NAME?.trim() || DEFAULT_OBJECT_NAME;
  const key = new Request(
    `${url.origin}${url.pathname}?object=${encodeURIComponent(objectName)}&date=${date}&origin=${allowed ? encodeURIComponent(origin) : ''}`,
  );
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit !== undefined) return hit;
  const response = await forward();
  if (response.status === 200) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return servePage(request, url, env);

    const settings = settingsFrom(env);
    const forwarded = new Request(request);
    forwarded.headers.set(CLIENT_IP_HEADER, clientIp(request, settings.trustProxy));
    forwarded.headers.set(ORIGIN_HEADER, selfOrigin(request, url, settings));
    const stub = env.CLUB.get(
      env.CLUB.idFromName(env.CLUB_OBJECT_NAME?.trim() || DEFAULT_OBJECT_NAME),
    );
    const forward = () => stub.fetch(forwarded);
    if (request.method === 'GET' && url.pathname === '/api/v1/public') {
      return servePublic(request, url, env, ctx, settings, forward);
    }
    return forward();
  },
} satisfies ExportedHandler<Env>;

/**
 * The hash pepper, as on Node (src/config.ts): `CLUB_SECRET` when the
 * deployment sets one (`wrangler secret put CLUB_SECRET`), else generated
 * once into the object's own storage so a redeploy keeps every token valid.
 */
function loadOrCreateSecret(db: SqlDriver): string {
  const row = db.get(`SELECT value FROM meta WHERE key = 'secret'`);
  const stored = row === undefined ? '' : String(row.value).trim();
  if (stored !== '') return stored;
  const secret = randomHex(32);
  db.run(`INSERT INTO meta (key, value) VALUES ('secret', ?)`, secret);
  return secret;
}

async function* chunksOf(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** The request's clock: the wall clock, or the test harness's when the deployment allows it. */
function requestNow(request: Request, testMode: boolean): Date {
  if (!testMode) return new Date();
  const header = request.headers.get(TEST_NOW_HEADER);
  const given = header === null ? NaN : new Date(header).getTime();
  return Number.isNaN(given) ? new Date() : new Date(given);
}

export class ClubObject extends DurableObject<Env> {
  private readonly api: Api;
  private readonly settings: WorkerSettings;
  private readonly rows: RowCounter = { read: 0, written: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.settings = settingsFrom(env);
    // Synchronous, so it completes before the first request is delivered.
    const db = sqlDriver(ctx.storage.sql, this.rows);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    const secret = env.CLUB_SECRET?.trim() || loadOrCreateSecret(db);
    this.api = createApi({
      store: new Store(db),
      config: apiConfigFrom(env, secret),
      limits: this.settings.limits,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const before: RowCounter = { ...this.rows };
    const reply = await this.api.handle({
      method: request.method,
      url,
      header: (name) => request.headers.get(name) ?? undefined,
      body: {
        contentLength: request.headers.get('content-length') ?? undefined,
        contentType: request.headers.get('content-type') ?? undefined,
        chunks: () => chunksOf(request.body),
      },
      clientIp: request.headers.get(CLIENT_IP_HEADER) ?? 'unknown',
      origin: request.headers.get(ORIGIN_HEADER) ?? url.origin,
      now: requestNow(request, this.settings.testMode),
    });
    const headers = new Headers(reply.headers);
    if (this.settings.testMode) {
      headers.set(
        ROWS_HEADER,
        `read=${this.rows.read - before.read}; written=${this.rows.written - before.written}`,
      );
    }
    return new Response(reply.body, { status: reply.status, headers });
  }
}
