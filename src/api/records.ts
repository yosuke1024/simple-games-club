/**
 * `GET /records` — the old form of the rankings' leaders (club.md §16-1): one
 * row per table, the leading row. Kept so a client that predates
 * rankings still reads something true; `challengeId` is always `''` because a
 * record no longer belongs to a challenge.
 */
import type { Router } from '../http/router.js';
import type { Deps } from './deps.js';

export function registerRecords(router: Router, deps: Deps): void {
  router.add('GET', '/api/v1/records', { auth: 'member', limit: 'member' }, () => ({
    status: 200,
    body: deps.store.records(),
  }));
}
