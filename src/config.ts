/**
 * Everything the server reads from its environment, in one place.
 *
 * The contract this server implements lives in the simple-games repository:
 * docs/architecture/club.md §5 (API v1) and §8 (setup key, hosting). Nothing
 * here is configurable beyond what a host has to decide — where the data
 * lives, which setup key claims the club, and how the hosting dashboard is
 * reached — so that a one-click template can fill it all in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomHex } from './auth/tokens.js';

import type { ApiConfig, HostingConfig } from './api/deps.js';

export type { HostingConfig };

/** The Node deployment's whole environment: what the API reads (ApiConfig) plus the process's own. */
export interface Config extends ApiConfig {
  port: number;
  host: string;
  /** The one persistent directory: the SQLite file and the generated secret. */
  dataDir: string;
  /** Where the Simple Games web build is served from (`/` and `/join`). */
  webDir: string;
  /** `https://club.example.com` — used to build invite URLs; falls back to the request host. */
  publicOrigin: string | null;
  /** Read `X-Forwarded-*` from the platform's proxy (on by default: every PaaS sets them). */
  trustProxy: boolean;
  log: boolean;
}

const blankToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const intEnv = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const stripSlash = (origin: string): string => origin.replace(/\/+$/, '');

function publicOriginFrom(env: NodeJS.ProcessEnv): string | null {
  const explicit = blankToNull(env.CLUB_PUBLIC_ORIGIN);
  if (explicit) return stripSlash(explicit);
  // Railway exposes the public hostname of the service; other platforms set
  // CLUB_PUBLIC_ORIGIN through the template or fall back to the request host.
  const railway = blankToNull(env.RAILWAY_PUBLIC_DOMAIN);
  return railway ? `https://${stripSlash(railway)}` : null;
}

function hostingFrom(env: NodeJS.ProcessEnv): HostingConfig {
  const project = blankToNull(env.RAILWAY_PROJECT_ID);
  const service = blankToNull(env.RAILWAY_SERVICE_ID);
  const environment = blankToNull(env.RAILWAY_ENVIRONMENT_ID);
  const onRailway = project !== null;
  const provider = blankToNull(env.CLUB_HOSTING_PROVIDER) ?? (onRailway ? 'railway' : null);
  const manageUrl =
    blankToNull(env.CLUB_HOSTING_MANAGE_URL) ??
    (project && service && environment
      ? `https://railway.com/project/${project}/service/${service}?environmentId=${environment}`
      : null);
  return { provider, manageUrl };
}

/**
 * The hash pepper. A template can inject `CLUB_SECRET`; a bare `docker run`
 * gets one generated on first boot and kept on the volume, so a restart does
 * not invalidate every token.
 */
function loadOrCreateSecret(dataDir: string): string {
  const path = join(dataDir, 'secret');
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored !== '') return stored;
  }
  const secret = randomHex(32);
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.CLUB_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  return {
    port: intEnv(env.PORT, 8080),
    host: blankToNull(env.HOST) ?? '0.0.0.0',
    dataDir,
    webDir: resolve(env.CLUB_WEB_DIR ?? './web'),
    setupKey: blankToNull(env.CLUB_SETUP_KEY),
    secret: blankToNull(env.CLUB_SECRET) ?? loadOrCreateSecret(dataDir),
    publicOrigin: publicOriginFrom(env),
    corsOrigins: (env.CLUB_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => stripSlash(origin.trim()))
      .filter((origin) => origin !== ''),
    hosting: hostingFrom(env),
    openJoin: env.CLUB_OPEN_JOIN === '1',
    trustProxy: env.CLUB_TRUST_PROXY !== '0',
    log: env.CLUB_LOG !== '0',
  };
}
