/**
 * `GET /hosting`, `PATCH /hosting` (club.md §8-4). `manageUrl` goes to owners
 * only; `referralUrl` is the host's own link, opened as-is by a member who
 * chooses to create their own club — the server neither builds nor rewrites it.
 */
import type { MemberRow } from '../db/store.js';
import { invalidRequest, notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import type { Deps } from './deps.js';

export function registerHosting(router: Router, deps: Deps): void {
  const { store, config } = deps;

  const hostingFor = (member: MemberRow) => {
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    return {
      provider: config.hosting.provider,
      manageUrl: member.role === 'owner' ? config.hosting.manageUrl : null,
      referralUrl: club.referralUrl,
      lastActivityAt: club.lastActivityAt,
    };
  };

  router.add('GET', '/api/v1/hosting', { auth: 'member', limit: 'member' }, (ctx) => ({
    status: 200,
    body: hostingFor(ctx.member!),
  }));

  router.add('PATCH', '/api/v1/hosting', { auth: 'owner', limit: 'member' }, async (ctx) => {
    const body = await ctx.body();
    if (!('referralUrl' in body)) throw invalidRequest('referralUrl is required (a URL or null)');
    store.setReferralUrl(v.httpsUrlOrNull(body.referralUrl, 'referralUrl'));
    return { status: 200, body: hostingFor(ctx.member!) };
  });
}
