/**
 * Members (club.md §5-3, §17-3). `DELETE /members/:id` stops the member's token
 * at once and, without `?purge=1`, leaves their results under their nickname;
 * the last owner cannot be removed — recovery from that state is the setup key.
 * Reports and the owner's two remedies — rename, and remove with the work —
 * are the whole of the Public deployment's moderation: no notification, no
 * automatic judgement, no freeze.
 */
import { conflict, invalidRequest, notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { memberShape } from './shape.js';

export function registerMembers(router: Router, deps: Deps): void {
  const { store } = deps;

  const activeMember = (id: string) => {
    const member = store.memberById(id);
    if (member === null || member.revokedAt !== null) throw notFound('no such member');
    return member;
  };

  // Registered before `/members/:id` routes: a literal segment never meets a `:id` match
  // because the methods differ, but the order keeps the table easy to read.
  router.add('GET', '/api/v1/members/reported', { auth: 'owner', limit: 'member' }, () => ({
    status: 200,
    body: store.reportedMembers().map((row) => ({
      member: memberShape(row.member),
      reportCount: row.reportCount,
    })),
  }));

  router.add('POST', '/api/v1/members/:id/report', { auth: 'member', limit: 'member' }, (ctx) => {
    const target = activeMember(ctx.params.id!);
    if (target.id === ctx.member!.id) throw invalidRequest('you cannot report yourself');
    store.addReport(target.id, ctx.member!.id, iso(ctx.now));
    return { status: 204 };
  });

  router.add('PATCH', '/api/v1/members/:id', { auth: 'owner', limit: 'member' }, async (ctx) => {
    const target = activeMember(ctx.params.id!);
    const body = await ctx.body();
    const nickname = v.nickname(body.nickname);
    store.renameMember(target.id, nickname);
    return { status: 200, body: memberShape({ ...target, nickname }) };
  });

  router.add('DELETE', '/api/v1/members/:id', { auth: 'owner', limit: 'member' }, (ctx) => {
    const target = activeMember(ctx.params.id!);
    const purge = ctx.query.get('purge');
    if (purge !== null && purge !== '0' && purge !== '1') {
      throw invalidRequest('purge must be 0 or 1');
    }
    if (target.role === 'owner' && store.countActive('owner') <= 1) {
      throw conflict('last_owner', 'the last owner cannot be removed');
    }
    store.revokeMember(target.id, iso(ctx.now));
    if (purge === '1') store.purgeMember(target.id);
    return { status: 204 };
  });
}
