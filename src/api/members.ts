/**
 * Members (club.md §5-3, §17-3). `GET /members?before=` pages the member list past the
 * newest `membersPage` that `GET /club` carries, and `GET /members/:id` is one member's view:
 * their name and the tables they have rows in, read exactly as `GET /rankings/mine` reads the
 * caller's own — nothing that grows with the club. `DELETE /members/:id` stops the member's token
 * at once and, without `?purge=1`, leaves their results under their nickname;
 * the last owner cannot be removed — recovery from that state is the setup key.
 * Reports and the owner's two remedies — rename, and remove with the work —
 * are the whole of the Public deployment's moderation: no notification, no
 * automatic judgement, no freeze.
 *
 * `PATCH /me` is the member's own lever (§5-3): change one's name. It does not touch
 * the reports against the member — a name change must not reset the count. Deleting
 * one's own records is per record, next to the records (rankings.ts, challenges.ts).
 */
import { conflict, invalidRequest, notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { memberShape, rankingMineShape } from './shape.js';

export function registerMembers(router: Router, deps: Deps): void {
  const { store, limits } = deps;

  const activeMember = (id: string) => {
    const member = store.memberById(id);
    if (member === null || member.revokedAt !== null) throw notFound('no such member');
    return member;
  };

  router.add('PATCH', '/api/v1/me', { auth: 'member', limit: 'member' }, async (ctx) => {
    const body = await ctx.body();
    const nickname = v.nickname(body.nickname);
    store.renameSelf(ctx.member!.id, nickname);
    return { status: 200, body: memberShape({ ...ctx.member!, nickname }) };
  });

  // The member list past `GET /club`'s first page (club.md §17-2), newest first. `before` is the
  // last member of the page the client holds. A removed member is still a cursor — the page
  // must continue when its last member was removed meanwhile — so it is read with `memberById`,
  // not `activeMember`; only an id the club never issued is a 400.
  router.add('GET', '/api/v1/members', { auth: 'member', limit: 'member' }, (ctx) => {
    const before = ctx.query.get('before');
    let members;
    if (before === null) {
      members = store.newestMembers(limits.membersPage);
    } else {
      const cursor = store.memberById(before);
      if (cursor === null) throw invalidRequest('before must be a member id');
      members = store.membersBefore(cursor.seq, limits.membersPage);
    }
    return {
      status: 200,
      body: { members: members.map(memberShape), memberCount: store.countActive() },
    };
  });

  // Registered before `/members/:id`: the routes match in order, first match wins, and this
  // GET would otherwise take `reported` for an id (and answer a 404 to the owner).
  router.add('GET', '/api/v1/members/reported', { auth: 'owner', limit: 'member' }, () => ({
    status: 200,
    body: store.reportedMembers(limits.membersPage).map((row) => ({
      member: memberShape(row.member),
      reportCount: row.reportCount,
    })),
  }));

  // One member's view (club.md §5-3, §9): who they are and the tables they are in, the same rows
  // `GET /rankings/mine` gives the caller. Any member may ask about any active member, themselves
  // included; a removed or unknown one is a 404.
  router.add('GET', '/api/v1/members/:id', { auth: 'member', limit: 'member' }, (ctx) => {
    const member = activeMember(ctx.params.id!);
    return {
      status: 200,
      body: {
        member: memberShape(member),
        rankings: store.rankingsMine(member.id, limits.rankingMineScan).map(rankingMineShape),
      },
    };
  });

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
