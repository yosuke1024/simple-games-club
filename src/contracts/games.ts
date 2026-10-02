/**
 * The one place the server reads into `facts`: ranking a result (club.md §16,
 * §6-1). It knows exactly what club.md §6-1 fixes per game — which fact is the
 * axis a table is ordered by, and which direction is better — and nothing
 * else. The mode a table is kept for is not here: the client's contract
 * computes `paramsKey` and the server only checks its shape. A game missing
 * here simply has no rankings until the server learns it; its challenges and
 * results work as they are (Checkers, Connect Four, Gomoku and Ludo are
 * deliberately absent — club.md §16).
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
    'brick-breaker',
    'sky-fighter',
    'bubble-pop',
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

/** The axis value of a result, or null when the facts do not carry a usable number. */
export function axisValue(contract: GameContract, facts: unknown): number | null {
  if (typeof facts !== 'object' || facts === null) return null;
  const value = (facts as Record<string, unknown>)[contract.order];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
