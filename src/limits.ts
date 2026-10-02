/**
 * The numbers the contract fixes (simple-games docs/architecture/club.md §4-1,
 * §5-1, §5-3, §8-3). Overridable per app instance so tests can hit them
 * without a hundred joins.
 */
export interface Limits {
  /** Owners per club — club.md §8-3. */
  maxOwners: number;
  /** Members per club, owners included. */
  maxMembers: number;
  /** `POST /join` and `POST /claim`, per IP per minute. */
  ipPerMinute: number;
  /** Every authenticated request, per member per minute. */
  memberPerMinute: number;
  /** Whole request body. */
  bodyBytes: number;
  /** `params` and `facts`, serialized. */
  smallJsonBytes: number;
  /** `GET /challenges` page size. */
  challengePage: number;
  /** `GET /challenges/:id/results`. */
  resultsPage: number;
  /** `GET /rankings/:gameId/:paramsKey` default rows — club.md §16. */
  rankingTop: number;
  /** The most rows `?top=` may ask for. */
  rankingTopMax: number;
  /** Owner links — one use, and this long. */
  ownerLinkTtlMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxOwners: 5,
  maxMembers: 100,
  ipPerMinute: 10,
  memberPerMinute: 60,
  bodyBytes: 16 * 1024,
  smallJsonBytes: 1024,
  challengePage: 50,
  resultsPage: 200,
  rankingTop: 50,
  rankingTopMax: 100,
  ownerLinkTtlMs: 24 * 60 * 60 * 1000,
};

/** `X-Club-Api` — the version of the contract this server speaks. */
export const API_VERSION = 1;
