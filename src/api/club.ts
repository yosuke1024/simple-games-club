/** `GET /club`, `PATCH /club` (club.md §5-3). */
import { notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import type { Deps } from './deps.js';
import { clubShape, memberShape } from './shape.js';

export function registerClub(router: Router, deps: Deps): void {
  const { store } = deps;

  router.add('GET', '/api/v1/club', { auth: 'member', limit: 'member' }, (ctx) => {
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    return {
      status: 200,
      body: {
        club: clubShape(club),
        me: memberShape(ctx.member!),
        members: store.activeMembers().map(memberShape),
      },
    };
  });

  router.add('PATCH', '/api/v1/club', { auth: 'owner', limit: 'member' }, async (ctx) => {
    const body = await ctx.body();
    const name = v.clubName(body.name);
    store.renameClub(name);
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    return { status: 200, body: clubShape(club) };
  });
}
