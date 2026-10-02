/**
 * Everything the Worker reads from its bindings, in one place — the
 * counterpart of src/config.ts for the Cloudflare deployment. The names are
 * the Node server's (README「Environment」) so a host moving between the two
 * has nothing to relearn; what has no meaning here (ports, directories) is
 * simply absent.
 */
import type { ApiConfig, HostingConfig } from '../api/deps.js';
import { DEFAULT_LIMITS, type Limits } from '../limits.js';

export interface Env {
  /** The Durable Object namespace — one object per club (wrangler.toml). */
  CLUB: DurableObjectNamespace;
  /** The Simple Games web build, when wrangler.toml's `[assets]` has one to serve. */
  ASSETS?: Fetcher;
  CLUB_SETUP_KEY?: string;
  CLUB_SECRET?: string;
  CLUB_PUBLIC_ORIGIN?: string;
  CLUB_CORS_ORIGINS?: string;
  CLUB_HOSTING_PROVIDER?: string;
  CLUB_HOSTING_MANAGE_URL?: string;
  /** `1` to read `X-Forwarded-*` instead of what Cloudflare itself sets. Off by default. */
  CLUB_TRUST_PROXY?: string;
  /** A JSON object overriding entries of `DEFAULT_LIMITS` (tests; a deployment that needs other numbers). */
  CLUB_LIMITS?: string;
  /**
   * `1` makes the object honour `X-Club-Test-Now` as the request's clock and
   * report rows read/written on `X-Club-Rows`. For the contract tests and
   * the cost measurement only; wrangler.toml never sets it (test/units.test.ts).
   */
  CLUB_TEST_MODE?: string;
}

export interface WorkerSettings {
  publicOrigin: string | null;
  trustProxy: boolean;
  testMode: boolean;
  limits: Partial<Limits>;
}

const blankToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const stripSlash = (origin: string): string => origin.replace(/\/+$/, '');

/** Only known limit names, only positive integers; anything else is left at the default. */
function limitsFrom(raw: string | undefined): Partial<Limits> {
  const text = blankToNull(raw);
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const limits: Partial<Limits> = {};
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) limits[key] = value;
  }
  return limits;
}

export function settingsFrom(env: Env): WorkerSettings {
  const publicOrigin = blankToNull(env.CLUB_PUBLIC_ORIGIN);
  return {
    publicOrigin: publicOrigin === null ? null : stripSlash(publicOrigin),
    trustProxy: env.CLUB_TRUST_PROXY === '1',
    testMode: env.CLUB_TEST_MODE === '1',
    limits: limitsFrom(env.CLUB_LIMITS),
  };
}

export function apiConfigFrom(env: Env, secret: string): ApiConfig {
  const hosting: HostingConfig = {
    provider: blankToNull(env.CLUB_HOSTING_PROVIDER),
    manageUrl: blankToNull(env.CLUB_HOSTING_MANAGE_URL),
  };
  return {
    setupKey: blankToNull(env.CLUB_SETUP_KEY),
    secret,
    corsOrigins: (env.CLUB_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => stripSlash(origin.trim()))
      .filter((origin) => origin !== ''),
    hosting,
  };
}
