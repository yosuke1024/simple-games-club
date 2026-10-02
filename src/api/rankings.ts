/**
 * Rankings (club.md §16): one table per game × mode, one row per member — their
 * personal best. The client computes `paramsKey` (the mode) and sends the
 * result; the server knows only each game's axis fact and which direction is
 * better (src/contracts/games.ts). Nothing here is bound to a challenge.
 */
import { API_VERSION } from '../limits.js';
import { invalidRequest, notFound, unsupportedVersion } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { axisValue, contractOf } from '../contracts/games.js';
import { iso, type Deps } from './deps.js';
import { rankingEntryShape } from './shape.js';

export function registerRankings(router: Router, deps: Deps): void {
  const { store, limits } = deps;

  router.add(
    'POST',
    '/api/v1/rankings/results',
    { auth: 'member', limit: 'member' },
    async (ctx) => {
      const member = ctx.member!;
      const body = await ctx.body();
      const contractVersion = v.contractVersion(body.contractVersion);
      if (contractVersion !== API_VERSION) throw unsupportedVersion(contractVersion);
      const gameId = v.gameId(body.gameId);
      const paramsKey = v.paramsKey(body.paramsKey);
      v.smallObject(body.params, 'params', limits.smallJsonBytes); // checked, not stored or read
      const seed = v.seedOrEmpty(body.seed);
      const boardDigest = v.boardDigestOrNull(body.boardDigest);
      const outcome = v.outcome(body.outcome);
      const facts = v.smallObject(body.facts, 'facts', limits.smallJsonBytes);
      const contract = contractOf(gameId);
      if (contract === undefined) throw invalidRequest('no ranking for this game');

      let changed = false;
      if (outcome === 'completed') {
        const value = axisValue(contract, facts);
        if (value === null) {
          throw invalidRequest(`facts.${contract.order} must be a finite number`);
        }
        const now = iso(ctx.now);
        changed = store.offerRanking({
          gameId,
          paramsKey,
          memberId: member.id,
          nickname: member.nickname,
          value,
          facts,
          seed,
          boardDigest,
          now,
        });
        if (changed) store.touchActivity(now);
      }

      const entry = store.rankingEntry(gameId, paramsKey, member.id);
      return {
        status: changed ? 201 : 200,
        body: {
          gameId,
          paramsKey,
          improved: changed,
          entry: entry === null ? null : rankingEntryShape(entry),
          entryCount: store.rankingCount(gameId, paramsKey),
        },
      };
    },
  );

  router.add('GET', '/api/v1/rankings', { auth: 'member', limit: 'member' }, () => ({
    status: 200,
    body: store.rankingTables().map((table) => ({
      gameId: table.gameId,
      paramsKey: table.paramsKey,
      entryCount: table.entryCount,
      leader: rankingEntryShape(table.leader),
    })),
  }));

  router.add(
    'GET',
    '/api/v1/rankings/:gameId/:paramsKey',
    { auth: 'member', limit: 'member' },
    (ctx) => {
      const { gameId, paramsKey } = ctx.params as { gameId: string; paramsKey: string };
      const top = v.top(ctx.query.get('top'), limits.rankingTop, limits.rankingTopMax);
      // An unknown game or table is simply an empty one: a table exists when it has rows.
      const mine = store.rankingEntry(gameId, paramsKey, ctx.member!.id);
      return {
        status: 200,
        body: {
          gameId,
          paramsKey,
          entryCount: store.rankingCount(gameId, paramsKey),
          entries: store.rankingTop(gameId, paramsKey, top).map(rankingEntryShape),
          me:
            mine === null
              ? null
              : {
                  rank: store.rankOf(gameId, paramsKey, ctx.member!.id, limits.rankingRankScan),
                  entry: rankingEntryShape(mine),
                },
        },
      };
    },
  );
  // The caller's own row in one table. The next finished game enters the table again.
  router.add(
    'DELETE',
    '/api/v1/rankings/:gameId/:paramsKey/me',
    { auth: 'member', limit: 'member' },
    (ctx) => {
      const { gameId, paramsKey } = ctx.params as { gameId: string; paramsKey: string };
      if (!store.removeRankingEntry(gameId, paramsKey, ctx.member!.id)) {
        throw notFound('no record of yours in this ranking');
      }
      return { status: 204 };
    },
  );
}
