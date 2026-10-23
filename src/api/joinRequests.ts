import { hashToken, MEMBER_TOKEN_BYTES, newId, randomToken } from '../auth/tokens.js';
import { JOIN_REQUEST_TTL_MS, type JoinRequestRow } from '../db/policy.js';
import { ApiError, conflict, notFound, unauthorized } from '../http/errors.js';
import type { Ctx, Reply, Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { clubShape, memberShape } from './shape.js';

export const joinRequestShape = (request: JoinRequestRow) => ({
  id: request.id,
  nickname: request.nickname,
  status: request.status,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
});

/** A pending credential is deliberately not written to members. */
export function requestAdmission(deps: Deps, ctx: Ctx, nickname: string): Reply {
  const { store, config } = deps;
  const club = store.getClub();
  if (club === null) throw notFound('this server has not been claimed yet');
  const now = iso(ctx.now);
  store.policy.pruneRequests(now);
  const requestToken = randomToken(MEMBER_TOKEN_BYTES);
  const request: JoinRequestRow = {
    id: newId('jr'),
    nickname,
    status: 'pending',
    tokenHash: hashToken(config.secret, requestToken),
    memberId: newId('m'),
    createdAt: now,
    expiresAt: new Date(ctx.now.getTime() + JOIN_REQUEST_TTL_MS).toISOString(),
  };
  if (!store.policy.createRequest(request)) {
    throw new ApiError(409, 'too_many_requests', 'this club has too many pending join requests');
  }
  return {
    status: 202,
    body: {
      status: 'pending',
      club: clubShape(club),
      request: joinRequestShape(request),
      requestToken,
    },
  };
}

export function registerJoinRequests(router: Router, deps: Deps): void {
  const { store, config, limits } = deps;

  router.add('POST', '/api/v1/join-requests/status', { auth: 'none', limit: 'ip' }, async (ctx) => {
    const body = await ctx.body();
    const requestToken = v.secretField(body.requestToken, 'requestToken');
    const hash = hashToken(config.secret, requestToken);
    store.policy.pruneRequests(iso(ctx.now));
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    const member = store.memberByTokenHash(hash);
    // Approved requests need no permanent token ledger: the active member is the receipt.
    // Even after bounded request history expires, the applicant can recover the session.
    if (member !== null) {
      return {
        status: 200,
        body: {
          status: 'approved',
          club: clubShape(club),
          member: memberShape(member),
          memberToken: requestToken,
        },
      };
    }
    const request = store.policy.requestByTokenHash(hash);
    if (request === null) throw unauthorized('a valid join request token is required');
    const status = request.status === 'approved' ? 'rejected' : request.status;
    return {
      status: 200,
      body: { status, club: clubShape(club), request: { ...joinRequestShape(request), status } },
    };
  });

  router.add('POST', '/api/v1/join-requests/cancel', { auth: 'none', limit: 'ip' }, async (ctx) => {
    const body = await ctx.body();
    const token = v.secretField(body.requestToken, 'requestToken');
    const hash = hashToken(config.secret, token);
    store.policy.pruneRequests(iso(ctx.now));
    const request = store.policy.requestByTokenHash(hash);
    if (request === null) throw unauthorized('a valid join request token is required');
    if (request.status === 'approved') {
      throw new ApiError(409, 'request_decided', 'the request has already been approved');
    }
    store.policy.decideRequest(request.id, 'cancelled', iso(ctx.now));
    return { status: 204 };
  });

  router.add('GET', '/api/v1/join-requests', { auth: 'owner', limit: 'member' }, (ctx) => {
    store.policy.pruneRequests(iso(ctx.now));
    return { status: 200, body: store.policy.pendingRequests().map(joinRequestShape) };
  });

  for (const decision of ['approve', 'reject'] as const) {
    router.add(
      'POST',
      `/api/v1/join-requests/:id/${decision}`,
      { auth: 'owner', limit: 'member' },
      (ctx) => {
        const now = iso(ctx.now);
        store.policy.pruneRequests(now);
        const request = store.policy.requestById(ctx.params.id!);
        if (request === null) throw notFound('no such join request');
        const target = decision === 'approve' ? 'approved' : 'rejected';
        if (request.status !== 'pending' && request.status !== target) {
          throw new ApiError(409, 'request_decided', 'the request is no longer pending');
        }
        if (request.status === 'pending') {
          if (decision === 'approve') {
            if (!store.policy.approveRequest(request, now, limits.maxMembers)) {
              throw conflict('too_many_members', `a club has at most ${limits.maxMembers} members`);
            }
          } else {
            store.policy.decideRequest(request.id, 'rejected', now);
          }
          store.touchActivity(now);
        }
        return {
          status: 200,
          body: { status: target, request: { ...joinRequestShape(request), status: target } },
        };
      },
    );
  }
}
