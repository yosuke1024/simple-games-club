/**
 * Getting in: `POST /claim` (the setup key, once — club.md §8-3) and
 * `POST /join` (an invite or an owner link — §7, §8-3). Both hand back the
 * one member token this device will use from then on.
 */
import {
  INVITE_TOKEN_BYTES,
  MEMBER_TOKEN_BYTES,
  hashToken,
  newId,
  randomToken,
  safeEqual,
} from '../auth/tokens.js';
import { conflict, notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { clubShape, memberShape } from './shape.js';

export function registerAccess(router: Router, deps: Deps): void {
  const { store, config, limits } = deps;

  router.add('POST', '/api/v1/claim', { auth: 'none', limit: 'ip' }, async (ctx) => {
    const body = await ctx.body();
    const setupKey = v.secretField(body.setupKey, 'setupKey');
    const nickname = v.nickname(body.nickname);
    const clubName =
      body.clubName === undefined || body.clubName === null ? null : v.clubName(body.clubName);

    // Every failure is the same 409: a key that was never configured, a key
    // that does not match, and a key already spent all mean "this key will
    // not claim this server". Telling them apart would tell a stranger
    // which keys exist.
    const presented = hashToken(config.secret, setupKey);
    const configured = config.setupKey === null ? null : hashToken(config.secret, config.setupKey);
    if (
      configured === null ||
      !safeEqual(configured, presented) ||
      store.isSetupKeyUsed(presented)
    ) {
      throw conflict('setup_key_used', 'the setup key does not claim this server');
    }

    const now = iso(deps.now());
    let club = store.getClub();
    if (club === null) {
      club = store.createClub(newId('c'), clubName ?? `${nickname}'s Club`, now);
      // The first member invite exists from the start, so the owner can hand
      // it out without a second step.
      const invite = randomToken(INVITE_TOKEN_BYTES);
      store.replaceMemberInvite(newId('inv'), invite, hashToken(config.secret, invite), now);
    } else {
      // A re-set setup key (§8-3 recovery) adds an owner to the existing club.
      if (store.countActive('owner') >= limits.maxOwners) {
        throw conflict('too_many_owners', `a club has at most ${limits.maxOwners} owners`);
      }
      if (store.countActive() >= limits.maxMembers) {
        throw conflict('too_many_members', `a club has at most ${limits.maxMembers} members`);
      }
    }

    const memberToken = randomToken(MEMBER_TOKEN_BYTES);
    const member = store.createMember(
      newId('m'),
      nickname,
      'owner',
      hashToken(config.secret, memberToken),
      now,
    );
    store.markSetupKeyUsed(presented, now);
    store.touchActivity(now);
    return {
      status: 201,
      body: { club: clubShape(club), member: memberShape(member), memberToken },
    };
  });

  router.add('POST', '/api/v1/join', { auth: 'none', limit: 'ip' }, async (ctx) => {
    const body = await ctx.body();
    const inviteToken = v.secretField(body.inviteToken, 'inviteToken');
    const nickname = v.nickname(body.nickname);

    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');

    const nowIso = iso(deps.now());
    const invite = store.inviteByTokenHash(hashToken(config.secret, inviteToken));
    const usable =
      invite !== null &&
      invite.revokedAt === null &&
      invite.usedAt === null &&
      (invite.expiresAt === null || invite.expiresAt > nowIso);
    if (!usable) throw conflict('invite_expired', 'the invite is no longer valid');

    if (store.countActive() >= limits.maxMembers) {
      throw conflict('too_many_members', `a club has at most ${limits.maxMembers} members`);
    }
    if (invite.role === 'owner' && store.countActive('owner') >= limits.maxOwners) {
      throw conflict('too_many_owners', `a club has at most ${limits.maxOwners} owners`);
    }

    const memberToken = randomToken(MEMBER_TOKEN_BYTES);
    const member = store.createMember(
      newId('m'),
      nickname,
      invite.role,
      hashToken(config.secret, memberToken),
      nowIso,
    );
    // An owner link is spent by its one use; the member invite keeps working
    // until the owner rotates it.
    if (invite.role === 'owner') store.markInviteUsed(invite.id, nowIso);
    store.touchActivity(nowIso);
    return {
      status: 201,
      body: { club: clubShape(club), member: memberShape(member), memberToken },
    };
  });
}
