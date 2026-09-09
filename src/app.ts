/**
 * The HTTP handler: static web build on one side, `/api/v1` on the other.
 * Per request, in this order — CORS, route, auth, rate limit, handler — so
 * a 401 never costs a rate-limit slot and a 429 never leaks whether a token
 * was valid before the limit hit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { registerAccess } from './api/access.js';
import { registerChallenges } from './api/challenges.js';
import { registerClub } from './api/club.js';
import type { Deps } from './api/deps.js';
import { registerHealth } from './api/health.js';
import { registerHosting } from './api/hosting.js';
import { registerInvites } from './api/invites.js';
import { registerMembers } from './api/members.js';
import { registerRecords } from './api/records.js';
import { bearerToken, hashToken } from './auth/tokens.js';
import type { Config } from './config.js';
import { Store } from './db/store.js';
import { readJsonObject, type JsonObject } from './http/body.js';
import { corsHeaders } from './http/cors.js';
import { ApiError, forbidden, notFound, rateLimited, unauthorized } from './http/errors.js';
import { RateLimiter } from './http/rateLimit.js';
import { Router, type Ctx } from './http/router.js';
import { serveStatic } from './http/static.js';
import { API_VERSION, DEFAULT_LIMITS, type Limits } from './limits.js';

export interface AppOptions {
  config: Config;
  db: DatabaseSync;
  /** Injectable clock — tests move it past an owner link's expiry. */
  now?: () => Date;
  limits?: Partial<Limits>;
}

export interface App {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  store: Store;
}

const MINUTE_MS = 60_000;

export function createApp(options: AppOptions): App {
  const { config } = options;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const store = new Store(options.db);
  const deps: Deps = { store, config, limits, now: options.now ?? (() => new Date()) };

  const router = new Router();
  registerHealth(router, deps);
  registerAccess(router, deps);
  registerClub(router, deps);
  registerChallenges(router, deps);
  registerRecords(router, deps);
  registerHosting(router, deps);
  registerInvites(router, deps);
  registerMembers(router, deps);

  const ipLimiter = new RateLimiter(limits.ipPerMinute, MINUTE_MS);
  const memberLimiter = new RateLimiter(limits.memberPerMinute, MINUTE_MS);

  const header = (req: IncomingMessage, name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  /** The first hop of X-Forwarded-For behind a trusted proxy, else the socket. */
  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const forwarded = header(req, 'x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /** The origin this server is reached on — for invite URLs and same-origin CORS. */
  const selfOrigin = (req: IncomingMessage): string => {
    if (config.publicOrigin !== null) return config.publicOrigin;
    const forwardedProto = config.trustProxy
      ? header(req, 'x-forwarded-proto')?.split(',')[0]?.trim()
      : undefined;
    const encrypted = 'encrypted' in req.socket && req.socket.encrypted === true;
    const proto = forwardedProto || (encrypted ? 'https' : 'http');
    const host =
      (config.trustProxy ? header(req, 'x-forwarded-host') : undefined) ??
      header(req, 'host') ??
      'localhost';
    return `${proto}://${host}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    if (status === 204 || body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const log = (req: IncomingMessage, res: ServerResponse, startedAt: number): void => {
    if (!config.log) return;
    const path = (req.url ?? '/').split('?')[0];
    console.log(`${req.method ?? '-'} ${path} ${res.statusCode} ${Date.now() - startedAt}ms`);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const origin = selfOrigin(req);
    const cors = corsHeaders(header(req, 'origin'), origin, config.corsOrigins);
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (match === null) throw notFound('no such endpoint');
      const { route, params } = match;

      let member: Ctx['member'] = null;
      if (route.auth !== 'none') {
        const token = bearerToken(header(req, 'authorization'));
        member = token === null ? null : store.memberByTokenHash(hashToken(config.secret, token));
        if (member === null) throw unauthorized();
        if (route.auth === 'owner' && member.role !== 'owner') throw forbidden();
      }

      const nowMs = deps.now().getTime();
      if (route.limit === 'ip' && !ipLimiter.allow(clientIp(req), nowMs)) throw rateLimited();
      if (route.limit === 'member' && member !== null && !memberLimiter.allow(member.id, nowMs)) {
        throw rateLimited();
      }

      let body: Promise<JsonObject> | null = null;
      const ctx: Ctx = {
        params,
        query: url.searchParams,
        member,
        body: () => (body ??= readJsonObject(req, limits.bodyBytes)),
        origin,
      };
      const reply = await route.handler(ctx);
      sendJson(res, reply.status, reply.body);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      console.error(error);
      sendJson(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const startedAt = Date.now();
    res.setHeader('X-Club-Api', String(API_VERSION));
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.once('finish', () => log(req, res, startedAt));

    if (url.pathname.startsWith('/api/')) {
      void handleApi(req, res, url);
      return;
    }
    if (!serveStatic(req, res, url.pathname, { webDir: config.webDir })) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  };

  return { handle, store };
}
