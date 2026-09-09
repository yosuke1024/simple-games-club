import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Limits } from '../limits.js';

/** What every handler is handed. `now` is injectable so tests can move time. */
export interface Deps {
  store: Store;
  config: Config;
  limits: Limits;
  now: () => Date;
}

export const iso = (date: Date): string => date.toISOString();

/** `https://<endpoint>/join#invite=<token>` — club.md §7-1. The token rides in the fragment. */
export const inviteUrl = (origin: string, token: string): string =>
  `${origin}/join#invite=${token}`;
