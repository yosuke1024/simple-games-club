/**
 * `GET /records` — club records (club.md §5-4): per game and mode, the lowest
 * value on that game's axis among completed results of live challenges, ties
 * to the earliest. The store keeps them as results arrive and rebuilds a
 * game's when one of its challenges is deleted, so this read is one small
 * table rather than every result of the club.
 */
import type { Router } from '../http/router.js';
import type { Deps } from './deps.js';

export function registerRecords(router: Router, deps: Deps): void {
  router.add('GET', '/api/v1/records', { auth: 'member', limit: 'member' }, () => ({
    status: 200,
    body: deps.store.records(),
  }));
}
