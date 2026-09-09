/**
 * `DELETE /members/:id` (club.md §5-3, §8-3): the member's token stops
 * working at once, their results stay under their nickname, and the last
 * owner cannot be removed — recovery from that state is the setup key.
 */
import { conflict, notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import { iso, type Deps } from './deps.js';

export function registerMembers(router: Router, deps: Deps): void {
  const { store } = deps;

  router.add('DELETE', '/api/v1/members/:id', { auth: 'owner', limit: 'member' }, (ctx) => {
    const target = store.memberById(ctx.params.id!);
    if (target === null || target.revokedAt !== null) throw notFound('no such member');
    if (target.role === 'owner' && store.countActive('owner') <= 1) {
      throw conflict('last_owner', 'the last owner cannot be removed');
    }
    store.revokeMember(target.id, iso(deps.now()));
    return { status: 204 };
  });
}
