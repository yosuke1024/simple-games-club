import { API_VERSION } from '../limits.js';
import type { Router } from '../http/router.js';
import type { Deps } from './deps.js';

/**
 * `GET /health` — no auth, no rate limit: the template's healthcheck and the
 * client's reachability probe before a claim. `claimed` tells the Create
 * flow whether the deploy has been claimed yet (club.md §8-3); `open` says
 * whether `POST /join` needs an invite (false) or a nickname is enough (true).
 */
export function registerHealth(router: Router, deps: Deps): void {
  router.add('GET', '/api/v1/health', { auth: 'none', limit: 'none' }, () => ({
    status: 200,
    body: {
      ok: true,
      api: API_VERSION,
      claimed: deps.store.getClub() !== null,
      open: deps.config.openJoin,
    },
  }));
}
