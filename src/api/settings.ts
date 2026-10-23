/** Club discovery, admission rules and the games whose results the club accepts. */
import { hashToken } from '../auth/tokens.js';
import type { ClubSettings } from '../db/policy.js';
import { ApiError, conflict, invalidRequest, notFound } from '../http/errors.js';
import type { JsonObject } from '../http/body.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';

export const settingsOf = (deps: Deps): ClubSettings =>
  deps.store.policy.settings(deps.config.openJoin);

export const gameAllowed = (deps: Deps, gameId: string): boolean => {
  const allowed = settingsOf(deps).allowedGameIds;
  return allowed === null || allowed.includes(gameId);
};

/** Read settings once when filtering a list, rather than once per result. */
export const gameFilter = (deps: Deps) => {
  const allowed = settingsOf(deps).allowedGameIds;
  return (row: { gameId: string }): boolean => allowed === null || allowed.includes(row.gameId);
};

export function requireGameAllowed(deps: Deps, gameId: string): void {
  if (!gameAllowed(deps, gameId)) {
    throw new ApiError(403, 'game_disabled', 'this club does not accept results for this game');
  }
}

export function patchSettings(current: ClubSettings, body: JsonObject): ClubSettings {
  if (!['visibility', 'approvalRequired', 'allowedGameIds'].some((key) => key in body)) {
    throw invalidRequest('provide a club setting');
  }
  const next = { ...current };
  if (body.visibility !== undefined) {
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      throw invalidRequest('visibility must be public or private');
    }
    next.visibility = body.visibility;
  }
  if (body.approvalRequired !== undefined) {
    if (typeof body.approvalRequired !== 'boolean') {
      throw invalidRequest('approvalRequired must be a boolean');
    }
    next.approvalRequired = body.approvalRequired;
  }
  if (body.allowedGameIds !== undefined) {
    if (body.allowedGameIds === null) {
      next.allowedGameIds = null;
    } else {
      if (!Array.isArray(body.allowedGameIds) || body.allowedGameIds.length > 128) {
        throw invalidRequest('allowedGameIds must be null or at most 128 game ids');
      }
      next.allowedGameIds = [...new Set(body.allowedGameIds.map(v.gameId))].sort();
    }
  }
  return next;
}

export function registerSettings(router: Router, deps: Deps): void {
  const { store, config } = deps;
  router.add('GET', '/api/v1/settings', { auth: 'member', limit: 'member' }, () => ({
    status: 200,
    body: settingsOf(deps),
  }));

  router.add('PATCH', '/api/v1/settings', { auth: 'owner', limit: 'member' }, async (ctx) => {
    const body = await ctx.body();
    const settings = patchSettings(settingsOf(deps), body);
    store.policy.saveSettings(settings);
    store.touchActivity(iso(ctx.now));
    return { status: 200, body: settings };
  });

  const admission = () => {
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    return {
      club: { id: club.id, name: club.name },
      memberCount: store.countActive(),
      ...settingsOf(deps),
    };
  };

  // Public means a discoverable name and member count. No records, nicknames or member ids
  // are exposed by this endpoint, even when joining does not require approval.
  router.add('GET', '/api/v1/admission', { auth: 'none', limit: 'ip' }, () => {
    if (settingsOf(deps).visibility !== 'public') throw notFound('no public club here');
    return { status: 200, body: admission() };
  });

  // Private invitation previews keep the secret in the body, never a query, path or log.
  router.add('POST', '/api/v1/admission', { auth: 'none', limit: 'ip' }, async (ctx) => {
    const body = await ctx.body();
    const token = v.secretField(body.inviteToken, 'inviteToken');
    const invite = store.inviteByTokenHash(hashToken(config.secret, token));
    const now = iso(ctx.now);
    if (
      invite === null ||
      invite.revokedAt !== null ||
      invite.usedAt !== null ||
      (invite.expiresAt !== null && invite.expiresAt <= now)
    ) {
      throw conflict('invite_expired', 'the invite is no longer valid');
    }
    return { status: 200, body: admission() };
  });
}
