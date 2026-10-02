/**
 * `GET /invite`, `POST /invite` (club.md §5-3, §7-2, §8-3). The member invite
 * is one rotating link the owner can read back; an owner link is minted
 * per use, hashed, and dies after one join or a day.
 */
import {
  INVITE_TOKEN_BYTES,
  OWNER_LINK_BYTES,
  hashToken,
  newId,
  randomToken,
} from '../auth/tokens.js';
import { conflict } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { inviteUrl, iso, type Deps } from './deps.js';

export function registerInvites(router: Router, deps: Deps): void {
  const { store, config, limits } = deps;

  const freshMemberInvite = (now: string) => {
    const token = randomToken(INVITE_TOKEN_BYTES);
    return store.replaceMemberInvite(newId('inv'), token, hashToken(config.secret, token), now);
  };

  router.add('GET', '/api/v1/invite', { auth: 'owner', limit: 'member' }, (ctx) => {
    // The claim always creates one, so this only mints for a database that
    // predates that rule — never for a rotation the owner did not ask for.
    const invite = store.memberInvite() ?? freshMemberInvite(iso(ctx.now));
    const token = invite.token!;
    return { status: 200, body: { token, url: inviteUrl(ctx.origin, token) } };
  });

  router.add('POST', '/api/v1/invite', { auth: 'owner', limit: 'member' }, async (ctx) => {
    const body = await ctx.body();
    const role = v.role(body.role);
    const now = ctx.now;
    const nowIso = iso(now);

    if (role === 'member') {
      const invite = freshMemberInvite(nowIso);
      const token = invite.token!;
      return { status: 201, body: { token, url: inviteUrl(ctx.origin, token) } };
    }

    if (store.countActive('owner') >= limits.maxOwners) {
      throw conflict('too_many_owners', `a club has at most ${limits.maxOwners} owners`);
    }
    const token = randomToken(OWNER_LINK_BYTES);
    const expiresAt = iso(new Date(now.getTime() + limits.ownerLinkTtlMs));
    store.createOwnerInvite(newId('inv'), hashToken(config.secret, token), nowIso, expiresAt);
    return { status: 201, body: { token, url: inviteUrl(ctx.origin, token), expiresAt } };
  });
}
