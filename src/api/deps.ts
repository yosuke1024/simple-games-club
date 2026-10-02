import type { Store } from '../db/store.js';
import type { Limits } from '../limits.js';

export interface HostingConfig {
  /** `'railway'`, `'cloudflare'` and the like — a label for the client's Hosting screen. */
  provider: string | null;
  /** The provider's dashboard for this server. Shown to owners only (club.md §8-4). */
  manageUrl: string | null;
}

/**
 * What the handlers read from the deployment — the same four things whether
 * the server is a Node process (src/config.ts) or a Durable Object
 * (src/worker/env.ts). Everything else about a deployment (ports, files,
 * proxies) stays in its adapter.
 */
export interface ApiConfig {
  /** `CLUB_SETUP_KEY` — the key a device pastes at deploy time and claims with once. */
  setupKey: string | null;
  /** Pepper for every token hash. */
  secret: string;
  /** Extra CORS origins on top of the fixed three (club.md §5-1). */
  corsOrigins: readonly string[];
  hosting: HostingConfig;
  /**
   * `CLUB_OPEN_JOIN=1`: `POST /join` takes a nickname alone — the Public
   * deployment, where anyone may join. Off, an invite token is required.
   */
  openJoin: boolean;
}

/** What every handler is handed. The request's clock travels on `Ctx.now`. */
export interface Deps {
  store: Store;
  config: ApiConfig;
  limits: Limits;
}

export const iso = (date: Date): string => date.toISOString();

/** `https://<endpoint>/join#invite=<token>` — club.md §7-1. The token rides in the fragment. */
export const inviteUrl = (origin: string, token: string): string =>
  `${origin}/join#invite=${token}`;
