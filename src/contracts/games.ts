/**
 * The one place the server reads into `facts`: ranking a result (club.md §16,
 * §6-1). It knows exactly what club.md §6-1 fixes per game — which fact is the
 * axis a table is ordered by, and which direction is better — and nothing
 * else. The mode a table is kept for is not here: the client's contract
 * computes `paramsKey` and the server only checks its shape. A game missing
 * here simply has no rankings until the server learns it; its challenges and
 * results work as they are (Checkers, Connect Four, Gomoku and Ludo are
 * deliberately absent — club.md §16).
 *
 * Changing this table (a game added, an axis or a direction changed) changes where
 * stored results sort: `results.rank_class` / `rank_key` are written from it when a
 * result arrives. The change must ship with a schema bump whose upgrade calls
 * `rerankResults` (src/db/driver.ts), or old results keep the old order.
 */
export type Direction = 'asc' | 'desc';

export interface GameContract {
  /** The name of the fact compared. */
  order: string;
  /** `asc`: lower is better (time, moves). `desc`: higher is better (score). */
  direction: Direction;
}

const of = (order: string, direction: Direction, ids: readonly string[]) =>
  ids.map((id): [string, GameContract] => [id, { order, direction }]);

export const GAME_CONTRACTS: Readonly<Record<string, GameContract>> = Object.fromEntries([
  ...of('elapsedSeconds', 'asc', [
    'sudoku',
    'sudoku-6x6',
    'minesweeper',
    'nonogram',
    'takuzu',
    'kakuro',
    'futoshiki',
    'crown-grid',
    'number-path',
    'shape-regions',
    'schulte-table',
    'binary-balance',
    'box-regions',
    'quick-math',
    'memory-match',
    'mahjong-solitaire',
  ]),
  ...of('moves', 'asc', [
    'water-sort',
    'sliding-puzzle',
    'solitaire',
    'spider-solitaire',
    'freecell',
    'number-match',
  ]),
  ...of('attempts', 'asc', ['hit-and-blow']),
  ...of('score', 'desc', [
    '2048',
    'block-puzzle',
    'bunny-hop',
    'sky-fighter',
    'number-recall',
    'yacht',
    'gin-rummy',
    'dominoes',
    'mancala',
    'reversi',
    'dots-and-boxes',
  ]),
  // Hearts is scored like golf: fewer points win.
  ...of('score', 'asc', ['hearts']),
]);

/**
 * The contract of `gameId`, or undefined. Read through this, never `GAME_CONTRACTS[id]`:
 * the map is a plain object, so an id like `constructor` (which the gameId shape allows)
 * would find an inherited member instead of nothing.
 */
export function contractOf(gameId: string): GameContract | undefined {
  return Object.hasOwn(GAME_CONTRACTS, gameId) ? GAME_CONTRACTS[gameId] : undefined;
}

/** The axis value of a result, or null when the facts do not carry a usable number. */
export function axisValue(contract: GameContract, facts: unknown): number | null {
  if (typeof facts !== 'object' || facts === null) return null;
  const value = (facts as Record<string, unknown>)[contract.order];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Where a challenge result sorts in `GET /challenges/:id/results` (club.md §5-3):
 * `rankClass` 0 is a completed result with a usable axis, 1 a completed result
 * without one, 2 a played one; within class 0 a lower `rankKey` is better
 * (the axis, negated when higher is better, so one ascending index serves every
 * game); within 1 and 2 `rankKey` is null and arrival decides. A game without a
 * contract has no axis: its completed results are class 1, in arrival order.
 */
export interface ResultRank {
  rankClass: 0 | 1 | 2;
  rankKey: number | null;
}

export function resultRank(gameId: string, outcome: string, facts: unknown): ResultRank {
  if (outcome !== 'completed') return { rankClass: 2, rankKey: null };
  const contract = contractOf(gameId);
  const value = contract === undefined ? null : axisValue(contract, facts);
  if (contract === undefined || value === null) return { rankClass: 1, rankKey: null };
  // `0 - value` rather than `-value`: a score of 0 must not become -0.
  return { rankClass: 0, rankKey: contract.direction === 'asc' ? value : 0 - value };
}
