/**
 * Rankings (club.md §16): one table per game × mode, one row per finished game — a member
 * appears as often as they finished there, up to `rankingRowsPerMember` rows (their worst
 * goes past it). The client computes `paramsKey` (the mode) and sends the result; the server
 * knows only each game's axis fact and which direction is better (src/contracts/games.ts).
 * Nothing here is bound to a challenge.
 *
 * `POST /rankings/results` takes an optional `clientId` (2026-10-10): the same member's same
 * `clientId` is stored once, and a resend of it answers 200 with the stored row.
 */
import { API_VERSION } from '../limits.js';
import { invalidRequest, notFound, unsupportedVersion } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { axisValue, contractOf } from '../contracts/games.js';
import { iso, type Deps } from './deps.js';
import { rankingEntryShape, rankingStandingShape } from './shape.js';

/** A row id as the wire carries it (`Entry.id`): a positive integer in decimal, or nothing. */
const rowId = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
};

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
      const clientId = v.clientIdOrNull(body.clientId); // the shape is checked whatever the outcome
      const contract = contractOf(gameId);
      if (contract === undefined) throw invalidRequest('no ranking for this game');

      if (outcome === 'completed') {
        const value = axisValue(contract, facts);
        if (value === null) {
          throw invalidRequest(`facts.${contract.order} must be a finite number`);
        }
        const now = iso(ctx.now);
        // Every finished game is a row; `entry` is null only when the member's cap dropped it.
        // With a `clientId` already stored for this member the call writes nothing and answers
        // with that row: a resend after a lost answer is not a second row.
        const added = store.addRanking({
          gameId,
          paramsKey,
          memberId: member.id,
          nickname: member.nickname,
          value,
          facts,
          seed,
          boardDigest,
          now,
          rowsPerMember: limits.rankingRowsPerMember,
          clientId,
        });
        if (!added.duplicate) store.touchActivity(now);
        return {
          status: added.duplicate ? 200 : 201,
          body: {
            gameId: added.gameId,
            paramsKey: added.paramsKey,
            improved: added.improved,
            entry: added.entry === null ? null : rankingEntryShape(added.entry),
            entryCount: added.entryCount,
          },
        };
      }

      // A played game stores nothing: the member's best row as it stands.
      const best = store.bestOf(gameId, paramsKey, member.id);
      return {
        status: 200,
        body: {
          gameId,
          paramsKey,
          improved: false,
          entry: best === null ? null : rankingEntryShape(best),
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

  // The tables the caller has rows in (club.md §5-4). Registered before the table route; the
  // two never meet (four path segments here, five there), but the literal reads first.
  router.add('GET', '/api/v1/rankings/mine', { auth: 'member', limit: 'member' }, (ctx) => ({
    status: 200,
    body: store.rankingsMine(ctx.member!.id, limits.rankingMineScan).map((table) => ({
      gameId: table.gameId,
      paramsKey: table.paramsKey,
      entryCount: table.entryCount,
      leader: rankingEntryShape(table.leader),
      best: rankingStandingShape(table.best),
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
      const best = store.bestOf(gameId, paramsKey, ctx.member!.id);
      return {
        status: 200,
        body: {
          gameId,
          paramsKey,
          entryCount: store.rankingCount(gameId, paramsKey),
          entries: store.rankingTop(gameId, paramsKey, top).map(rankingEntryShape),
          me:
            best === null
              ? null
              : rankingStandingShape(
                  store.standing(gameId, paramsKey, best, limits.rankingRankScan),
                ),
        },
      };
    },
  );

  // One of the caller's own results. Their other rows stay; the next finished game enters too.
  router.add(
    'DELETE',
    '/api/v1/rankings/:gameId/:paramsKey/entries/:id',
    { auth: 'member', limit: 'member' },
    (ctx) => {
      const { gameId, paramsKey } = ctx.params as { gameId: string; paramsKey: string };
      const id = rowId(ctx.params.id);
      // A malformed id names no row: the same 404 as a row that is gone or someone else's.
      if (id === null || !store.removeRankingEntryById(gameId, paramsKey, ctx.member!.id, id)) {
        throw notFound('no such result of yours in this ranking');
      }
      return { status: 204 };
    },
  );

  // Compatibility (v1.4.0's "delete my record"): every row of the caller's in that table.
  router.add(
    'DELETE',
    '/api/v1/rankings/:gameId/:paramsKey/me',
    { auth: 'member', limit: 'member' },
    (ctx) => {
      const { gameId, paramsKey } = ctx.params as { gameId: string; paramsKey: string };
      if (!store.removeRankingEntries(gameId, paramsKey, ctx.member!.id)) {
        throw notFound('no record of yours in this ranking');
      }
      return { status: 204 };
    },
  );
}
