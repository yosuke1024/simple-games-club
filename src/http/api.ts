/**
 * The API, independent of what carries it. One request in, one response out:
 * CORS → route → auth → rate limit → handler, in that order, so a 401 never
 * costs a rate-limit slot and a 429 never leaks whether a token was valid
 * before the limit hit. The Node server (src/app.ts) and the Durable Object
 * (src/worker/index.ts) each translate their own request type into
 * `ApiRequest` and write the `ApiResponse` back out; neither contains a
 * route, a check, or a status code of its own.
 */
import { registerAccess } from '../api/access.js';
import { registerChallenges } from '../api/challenges.js';
import { registerClub } from '../api/club.js';
import type { ApiConfig, Deps } from '../api/deps.js';
import { registerHealth } from '../api/health.js';
import { registerHosting } from '../api/hosting.js';
import { registerInvites } from '../api/invites.js';
import { registerMembers } from '../api/members.js';
import { registerPublic } from '../api/public.js';
import { registerRankings } from '../api/rankings.js';
import { registerRecords } from '../api/records.js';
import { bearerToken, hashToken } from '../auth/tokens.js';
import type { Store } from '../db/store.js';
import { API_VERSION, DEFAULT_LIMITS, type Limits } from '../limits.js';
import { readJsonObject, type BodySource, type JsonObject } from './body.js';
import { corsHeaders } from './cors.js';
import { ApiError, forbidden, notFound, rateLimited, unauthorized } from './errors.js';
import { RateLimiter } from './rateLimit.js';
import { Router, type Ctx } from './router.js';

/** `X-Club-Api` — on every response of either deployment, static pages included (club.md §5-1). */
export const API_VERSION_HEADER = 'X-Club-Api';
export const API_VERSION_VALUE = String(API_VERSION);

export interface ApiRequest {
  method: string;
  /** Only the path and query are read; the origin is whatever the adapter parsed it against. */
  url: URL;
  /** A request header by lower-case name. */
  header(name: string): string | undefined;
  body: BodySource;
  /** The client as the adapter identifies it — the join/claim rate-limit key. */
  clientIp: string;
  /** The origin invite URLs are built on: the configured public one, else the request's. */
  origin: string;
  /** The request's clock. A test clock on Node; the wall clock in production. */
  now: Date;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** The JSON text, or null for a 204. */
  body: string | null;
}

export interface ApiOptions {
  store: Store;
  config: ApiConfig;
  limits?: Partial<Limits>;
}

export interface Api {
  handle(request: ApiRequest): Promise<ApiResponse>;
  limits: Limits;
}

const MINUTE_MS = 60_000;

export function createApi(options: ApiOptions): Api {
  const { store, config } = options;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const deps: Deps = { store, config, limits };

  const router = new Router();
  registerHealth(router, deps);
  registerAccess(router, deps);
  registerClub(router, deps);
  registerChallenges(router, deps);
  registerRecords(router, deps);
  registerRankings(router, deps);
  registerHosting(router, deps);
  registerInvites(router, deps);
  registerMembers(router, deps);
  registerPublic(router, deps);

  // In memory, per process — or per Durable Object, which is one process for
  // its club. A restart forgets the last minute; nothing worse.
  const ipLimiter = new RateLimiter(limits.ipPerMinute, MINUTE_MS);
  const memberLimiter = new RateLimiter(limits.memberPerMinute, MINUTE_MS);

  const json = (headers: Record<string, string>, status: number, body: unknown): ApiResponse => {
    if (status === 204 || body === undefined) return { status, headers, body: null };
    return {
      status,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    };
  };

  const handle = async (request: ApiRequest): Promise<ApiResponse> => {
    const headers: Record<string, string> = {
      [API_VERSION_HEADER]: API_VERSION_VALUE,
      'Cache-Control': 'no-store',
      ...corsHeaders(request.header('origin'), request.origin, config.corsOrigins),
    };
    if (request.method === 'OPTIONS') return { status: 204, headers, body: null };

    // The JSON body, read once and only when a handler asks (`ctx.body()`).
    let body: Promise<JsonObject> | null = null;
    const response = await (async (): Promise<ApiResponse> => {
      try {
        const match = router.match(request.method, request.url.pathname);
        if (match === null) throw notFound('no such endpoint');
        const { route, params } = match;

        let member: Ctx['member'] = null;
        if (route.auth !== 'none') {
          const token = bearerToken(request.header('authorization'));
          member = token === null ? null : store.memberByTokenHash(hashToken(config.secret, token));
          if (member === null) throw unauthorized();
          if (route.auth === 'owner' && member.role !== 'owner') throw forbidden();
        }

        const nowMs = request.now.getTime();
        if (route.limit === 'ip' && !ipLimiter.allow(request.clientIp, nowMs)) throw rateLimited();
        if (route.limit === 'member' && member !== null && !memberLimiter.allow(member.id, nowMs)) {
          throw rateLimited();
        }

        const ctx: Ctx = {
          params,
          query: request.url.searchParams,
          member,
          body: () => (body ??= readJsonObject(request.body, limits.bodyBytes)),
          origin: request.origin,
          now: request.now,
        };
        const reply = await route.handler(ctx);
        return json({ ...headers, ...reply.headers }, reply.status, reply.body);
      } catch (error) {
        if (error instanceof ApiError) {
          return json(headers, error.status, {
            error: { code: error.code, message: error.message },
          });
        }
        console.error(error);
        return json(headers, 500, { error: { code: 'internal_error', message: 'internal error' } });
      }
    })();
    // A route refused before it read its body (401, 403, 404, 429) leaves the body
    // on the connection; drained, the connection can carry the next request.
    if (body === null && request.method !== 'GET' && request.method !== 'HEAD') {
      await drainUnread(request.body, limits.bodyBytes);
    }
    return response;
  };

  return { handle, limits };
}

/**
 * Reads what a handler left unread of the request body, so the connection can
 * carry the next request. workerd closes an HTTP/1.1 connection whose request
 * body was not consumed instead of keeping it alive, and a client that has
 * already reused that connection sees a reset (`ECONNRESET`) on its next
 * request — a member's refused `PATCH /club` followed by anything else, for
 * one. Bounded by the body limit: past it the rest is abandoned and the
 * connection closes, which is right for a body the API would refuse anyway.
 * Nothing here changes the response, which is already decided.
 */
async function drainUnread(body: BodySource, limit: number): Promise<void> {
  let read = 0;
  try {
    for await (const chunk of body.chunks()) {
      read += chunk.byteLength;
      if (read > limit) break;
    }
  } catch {
    // A body that cannot be read is a connection that is gone; the response stands.
  }
}
