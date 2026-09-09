/**
 * The one place the server reads into `params` and `facts`: deriving club
 * records (club.md §5-4). It knows exactly what club.md §6-1 fixes per game —
 * which fact is the comparison axis, and which param names the "mode" a
 * record is kept for — and nothing else. A game missing here simply has no
 * records until the server learns it; its challenges and results work as
 * they are.
 */
export interface GameContract {
  /** The fact compared, ascending — lower is the record. */
  order: string;
  /** The mode key, from the challenge's params; null when the params are not this game's shape. */
  paramsKey: (params: unknown) => string | null;
}

const field =
  (name: string) =>
  (params: unknown): string | null => {
    if (typeof params !== 'object' || params === null) return null;
    const value = (params as Record<string, unknown>)[name];
    return typeof value === 'string' && value !== '' ? value : null;
  };

export const GAME_CONTRACTS: Readonly<Record<string, GameContract>> = {
  sudoku: { order: 'elapsedSeconds', paramsKey: field('difficulty') },
  minesweeper: { order: 'elapsedSeconds', paramsKey: field('difficulty') },
  'water-sort': { order: 'moves', paramsKey: field('tier') },
};

/** The axis value of a result, or null when the facts do not carry a usable number. */
export function axisValue(contract: GameContract, facts: unknown): number | null {
  if (typeof facts !== 'object' || facts === null) return null;
  const value = (facts as Record<string, unknown>)[contract.order];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
