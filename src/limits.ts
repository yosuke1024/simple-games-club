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
  /** `GET /club` lists this many of the newest members; `memberCount` is the total (club.md §17-2). */
  membersPage: number;
  /** `GET /challenges` page size. */
  challengePage: number;
  /** `GET /challenges/:id/results`. */
  resultsPage: number;
  /** `GET /rankings/:gameId/:paramsKey` default rows — club.md §16. */
  rankingTop: number;
  /** The most rows `?top=` may ask for. */
  rankingTopMax: number;
  /**
   * How many better rows `rankOf` counts before it gives up and reports the
   * rank as unknown (`null`). A rank is a count over the index, and every
   * entry it touches is a row read; the free plan allows 5,000,000 a day
   * (docs/cloudflare.md §4), so the count stops here instead of growing with
   * the club. A viewer ranked below this is shown without a number.
   */
  rankingRankScan: number;
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
  membersPage: 50,
  challengePage: 50,
  resultsPage: 200,
  rankingTop: 50,
  rankingTopMax: 100,
  rankingRankScan: 1000,
  ownerLinkTtlMs: 24 * 60 * 60 * 1000,
};

/** `X-Club-Api` — the version of the contract this server speaks. */
export const API_VERSION = 1;
