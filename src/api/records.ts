/**
 * `GET /records` — club records, derived from results on the way out
 * (club.md §5-4): per game and mode, the lowest value on that game's axis
 * among completed results, ties to the earliest. Nothing is accumulated
 * across challenges and nothing is stored; this is the whole of what the
 * server ever computes from a result.
 */
import { GAME_CONTRACTS, axisValue } from '../contracts/games.js';
import type { Router } from '../http/router.js';
import type { Deps } from './deps.js';

export interface ClubRecord {
  gameId: string;
  paramsKey: string;
  facts: unknown;
  memberId: string;
  nickname: string;
  challengeId: string;
}

export function registerRecords(router: Router, deps: Deps): void {
  router.add('GET', '/api/v1/records', { auth: 'member', limit: 'member' }, () => {
    const best = new Map<string, { value: number; record: ClubRecord }>();
    for (const candidate of deps.store.completedResultsForRecords()) {
      const contract = GAME_CONTRACTS[candidate.gameId];
      if (contract === undefined) continue;
      const paramsKey = contract.paramsKey(candidate.params);
      const value = axisValue(contract, candidate.facts);
      if (paramsKey === null || value === null) continue;
      const key = `${candidate.gameId} ${paramsKey}`;
      const current = best.get(key);
      // Strictly lower wins; equal keeps the earlier one (candidates arrive oldest first).
      if (current !== undefined && current.value <= value) continue;
      best.set(key, {
        value,
        record: {
          gameId: candidate.gameId,
          paramsKey,
          facts: candidate.facts,
          memberId: candidate.memberId,
          nickname: candidate.nickname,
          challengeId: candidate.challengeId,
        },
      });
    }
    const records = [...best.values()]
      .map((entry) => entry.record)
      .sort((a, b) => a.gameId.localeCompare(b.gameId) || a.paramsKey.localeCompare(b.paramsKey));
    return { status: 200, body: records };
  });
}
