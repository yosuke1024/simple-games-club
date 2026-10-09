/**
 * Row → wire shape (club.md §5-2). Kept apart from the store so a column can
 * be renamed without the API noticing, and so the API can never leak a
 * column the contract does not name (a token hash, a revoked_at).
 */
import type {
  ChallengeRow,
  ClubRow,
  MemberRow,
  RankingEntryRow,
  RankingStandingRow,
  ResultRow,
} from '../db/store.js';

export const clubShape = (club: ClubRow) => ({
  id: club.id,
  name: club.name,
  createdAt: club.createdAt,
});

export const memberShape = (member: MemberRow) => ({
  id: member.id,
  nickname: member.nickname,
  role: member.role,
  joinedAt: member.joinedAt,
});

export const challengeShape = (challenge: ChallengeRow) => ({
  id: challenge.id,
  gameId: challenge.gameId,
  contractVersion: challenge.contractVersion,
  params: challenge.params,
  seed: challenge.seed,
  boardDigest: challenge.boardDigest,
  title: challenge.title,
  daily: challenge.daily,
  createdBy: challenge.createdBy,
  createdAt: challenge.createdAt,
  resultCount: challenge.resultCount,
  mine: challenge.mine,
});

export const resultShape = (result: ResultRow) => ({
  memberId: result.memberId,
  nickname: result.nickname,
  submittedAt: result.submittedAt,
  outcome: result.outcome,
  facts: result.facts,
});

/** A ranking row (club.md §16-1). `id` is the row's arrival counter as a string. */
export const rankingEntryShape = (entry: RankingEntryRow) => ({
  id: String(entry.seq),
  memberId: entry.memberId,
  nickname: entry.nickname,
  submittedAt: entry.submittedAt,
  facts: entry.facts,
  seed: entry.seed,
  boardDigest: entry.boardDigest,
});

/** `me` of a table and `best` of `GET /rankings/mine`: the member's best row and where it stands. */
export const rankingStandingShape = (standing: RankingStandingRow) => ({
  rank: standing.rank,
  entry: rankingEntryShape(standing.entry),
  nextValue: standing.nextValue,
});
