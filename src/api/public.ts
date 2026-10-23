/**
 * `GET /public` — the Simple Games landing page's read-only view (club.md §18).
 * The one place the server ranks a Result: the top three of each of the day's
 * daily challenges, by the axis fact of src/contracts/games.ts, and the top three
 * of each of the eight most-entered ranking tables. Names and facts only — no
 * member id leaves here. Only a deployment that anyone may join
 * (`CLUB_OPEN_JOIN`) has one; the rest answer 404 as if the route did not exist.
 * Responses are never cached: an owner's visibility change takes effect on the
 * next request, including on the Cloudflare deployment.
 */
import { contractOf } from '../contracts/games.js';
import { notFound } from '../http/errors.js';
import type { Router } from '../http/router.js';
import * as v from '../validate.js';
import { iso, type Deps } from './deps.js';
import { gameFilter, settingsOf } from './settings.js';

const TOP = 3;
/** How many ranking tables the landing page shows: the most-entered ones. */
export const PUBLIC_TABLES = 8;
export const PUBLIC_CACHE_CONTROL = 'no-store';

export function registerPublic(router: Router, deps: Deps): void {
  const { store, config, limits } = deps;

  router.add('GET', '/api/v1/public', { auth: 'none', limit: 'ip' }, (ctx) => {
    // The legacy official public deployment keeps its landing-page contract. A managed
    // club never exposes member names or records before joining, regardless of visibility.
    if (config.managed || !config.openJoin || settingsOf(deps).visibility !== 'public') {
      throw notFound('no such endpoint');
    }
    const club = store.getClub();
    if (club === null) throw notFound('this server has not been claimed yet');
    const rawDate = ctx.query.get('date');
    const date = rawDate === null ? iso(ctx.now).slice(0, 10) : v.dailyQuery(rawDate);

    const enabled = gameFilter(deps);
    const today = store
      .dailyChallenges(date, limits.challengePage)
      .filter(enabled)
      .map((challenge) => {
        const contract = contractOf(challenge.gameId);
        return {
          gameId: challenge.gameId,
          daily: challenge.daily,
          resultCount: challenge.resultCount,
          top: contract === undefined ? [] : store.topResults(challenge.id, TOP),
        };
      });

    // The most-entered tables, each with its top three: a read of PUBLIC_TABLES summary
    // rows and TOP index rows per table, however many tables and entries there are.
    const rankings = store
      .popularRankingTables(PUBLIC_TABLES)
      .filter(enabled)
      .flatMap((table) => {
        const top = store
          .rankingTop(table.gameId, table.paramsKey, TOP)
          .map((entry) => ({ nickname: entry.nickname, facts: entry.facts }));
        // A summary row without entries cannot happen; if it ever does there is nothing to show.
        if (top[0] === undefined) return [];
        return [
          {
            gameId: table.gameId,
            paramsKey: table.paramsKey,
            entryCount: table.entryCount,
            leader: top[0], // the first of `top`, kept for readers that predate it
            top,
          },
        ];
      });

    return {
      status: 200,
      headers: { 'Cache-Control': PUBLIC_CACHE_CONTROL },
      body: {
        club: { name: club.name },
        memberCount: store.countActive(),
        today,
        rankings,
      },
    };
  });
}
