/**
 * Challenges and results (club.md §5-3, §5-4, §6-3). A challenge is created
 * together with its creator's result — "I did this; you?" — and each member
 * submits once.
 */
import { newId } from '../auth/tokens.js';
import { API_VERSION } from '../limits.js';
import { conflict, forbidden, notFound, unsupportedVersion } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { challengeShape, resultShape } from './shape.js';

export function registerChallenges(router: Router, deps: Deps): void {
  const { store, limits } = deps;

  router.add('GET', '/api/v1/challenges', { auth: 'member', limit: 'member' }, (ctx) => {
    const after = ctx.query.get('after');
    const daily = ctx.query.has('daily') ? v.dailyQuery(ctx.query.get('daily')) : null;
    const rows = store.listChallenges(ctx.member!.id, after, limits.challengePage, daily);
    return { status: 200, body: rows.map(challengeShape) };
  });

  router.add('POST', '/api/v1/challenges', { auth: 'member', limit: 'member' }, async (ctx) => {
    const member = ctx.member!;
    const body = await ctx.body();
    const contractVersion = v.contractVersion(body.contractVersion);
    if (contractVersion !== API_VERSION) throw unsupportedVersion(contractVersion);
    const gameId = v.gameId(body.gameId);
    const params = v.smallObject(body.params, 'params', limits.smallJsonBytes);
    const seed = v.seed(body.seed);
    const boardDigest = v.boardDigest(body.boardDigest);
    const title = v.title(body.title);
    const daily = v.daily(body.daily);
    const result = v.smallObject(body.result, 'result', limits.bodyBytes);
    const outcome = v.outcome(result.outcome);
    const facts = v.smallObject(result.facts, 'result.facts', limits.smallJsonBytes);

    const now = iso(ctx.now);

    // One challenge per board (club.md §6-3): a live challenge on the same
    // game, seed and board takes this result instead of a twin being made. It
    // keeps the first sender's title and daily tag.
    const existing = store.liveChallengeOnBoard(gameId, seed, boardDigest, member.id);
    if (existing !== null) {
      if (store.hasResult(existing.id, member.id)) {
        throw conflict('already_submitted', 'one result per member per challenge');
      }
      store.addResult({
        challengeId: existing.id,
        memberId: member.id,
        nickname: member.nickname,
        now,
        outcome,
        facts,
      });
      store.touchActivity(now);
      const joined = store.challengeById(existing.id, member.id);
      if (joined === null) throw notFound('challenge vanished'); // unreachable
      return { status: 200, body: challengeShape(joined) };
    }

    const id = newId('ch');
    store.createChallenge({
      id,
      gameId,
      contractVersion,
      params,
      seed,
      boardDigest,
      title,
      daily,
      createdBy: member.id,
      now,
    });
    store.addResult({
      challengeId: id,
      memberId: member.id,
      nickname: member.nickname,
      now,
      outcome,
      facts,
    });
    store.touchActivity(now);
    const created = store.challengeById(id, member.id);
    if (created === null) throw notFound('challenge vanished'); // unreachable
    return { status: 201, body: challengeShape(created) };
  });

  router.add('GET', '/api/v1/challenges/:id', { auth: 'member', limit: 'member' }, (ctx) => {
    const challenge = store.challengeById(ctx.params.id!, ctx.member!.id);
    if (challenge === null) throw notFound('no such challenge');
    return { status: 200, body: challengeShape(challenge) };
  });

  router.add('DELETE', '/api/v1/challenges/:id', { auth: 'member', limit: 'member' }, (ctx) => {
    const member = ctx.member!;
    const challenge = store.challengeById(ctx.params.id!, member.id);
    if (challenge === null) throw notFound('no such challenge');
    if (challenge.createdBy.id !== member.id && member.role !== 'owner') {
      throw forbidden('only the creator or an owner can delete a challenge');
    }
    store.deleteChallenge(challenge.id, iso(ctx.now));
    return { status: 204 };
  });

  router.add(
    'GET',
    '/api/v1/challenges/:id/results',
    { auth: 'member', limit: 'member' },
    (ctx) => {
      const challenge = store.challengeById(ctx.params.id!, ctx.member!.id);
      if (challenge === null) throw notFound('no such challenge');
      return {
        status: 200,
        body: store.results(challenge.id, limits.resultsPage).map(resultShape),
      };
    },
  );

  router.add(
    'POST',
    '/api/v1/challenges/:id/results',
    { auth: 'member', limit: 'member' },
    async (ctx) => {
      const member = ctx.member!;
      const body = await ctx.body();
      const contractVersion = v.contractVersion(body.contractVersion);
      if (contractVersion !== API_VERSION) throw unsupportedVersion(contractVersion);
      const boardDigest = v.boardDigest(body.boardDigest);
      const outcome = v.outcome(body.outcome);
      const facts = v.smallObject(body.facts, 'facts', limits.smallJsonBytes);

      const challenge = store.challengeById(ctx.params.id!, member.id);
      if (challenge === null) throw notFound('no such challenge');
      // Nothing is stored on either 409 (club.md §5-4).
      if (challenge.boardDigest !== boardDigest) {
        throw conflict(
          'board_mismatch',
          'the board this device generated is not the board of the challenge',
        );
      }
      if (store.hasResult(challenge.id, member.id)) {
        throw conflict('already_submitted', 'one result per member per challenge');
      }

      const now = iso(ctx.now);
      const result = store.addResult({
        challengeId: challenge.id,
        memberId: member.id,
        nickname: member.nickname,
        now,
        outcome,
        facts,
      });
      store.touchActivity(now);
      return { status: 201, body: resultShape(result) };
    },
  );
}
