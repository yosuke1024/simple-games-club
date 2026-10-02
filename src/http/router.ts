/**
 * A path-pattern router small enough to read in one sitting. Routes carry
 * their own access rule (`auth`) and rate-limit bucket (`limit`), so the
 * policy of club.md §5-1 is visible next to every endpoint rather than
 * hidden in middleware order.
 */
import type { MemberRow } from '../db/store.js';
import type { JsonObject } from './body.js';

export type Auth = 'none' | 'member' | 'owner';
export type LimitBucket = 'none' | 'ip' | 'member';

export interface Ctx {
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  /** The authenticated member; null on `auth: 'none'` routes. */
  member: MemberRow | null;
  /** Reads and validates the JSON body (once). */
  body: () => Promise<JsonObject>;
  /** The origin invite URLs are built on: the configured one, else the request's. */
  origin: string;
  /** The request's clock (src/http/api.ts); handlers never read Date.now(). */
  now: Date;
}

export interface Reply {
  status: number;
  body?: unknown;
  /** Replaces the defaults of src/http/api.ts by name (`Cache-Control` on the public view). */
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

export interface RouteOptions {
  auth: Auth;
  limit: LimitBucket;
}

interface Route extends RouteOptions {
  method: string;
  segments: readonly string[];
  handler: Handler;
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, options: RouteOptions, handler: Handler): void {
    this.routes.push({ method, segments: split(pattern), handler, ...options });
  }

  match(method: string, pathname: string): Match | null {
    const segments = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params !== null) return { route, params };
    }
    return null;
  }
}

const split = (path: string): string[] => path.split('/').filter((part) => part !== '');

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]!;
    const given = actual[i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = given;
    } else if (expected !== given) {
      return null;
    }
  }
  return params;
}
