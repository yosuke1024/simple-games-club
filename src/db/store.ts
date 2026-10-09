/**
 * Every SQL statement, behind typed methods. Handlers never see a row.
 */
import { contractOf, resultRank, type Direction } from '../contracts/games.js';
import type { Row, SqlDriver } from './driver.js';

export type Role = 'owner' | 'member';
export type Outcome = 'completed' | 'played';

export interface ClubRow {
  id: string;
  name: string;
  createdAt: string;
  referralUrl: string | null;
  lastActivityAt: string | null;
}

export interface MemberRow {
  id: string;
  nickname: string;
  role: Role;
  joinedAt: string;
  revokedAt: string | null;
}

export interface InviteRow {
  id: string;
  role: Role;
  /** Stored only for the member invite (club.md §5-1). */
  token: string | null;
  tokenHash: string;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface ChallengeRow {
  id: string;
  gameId: string;
  contractVersion: number;
  params: unknown;
  seed: string;
  boardDigest: string;
  title: string | null;
  /** `YYYY-MM-DD` when the board is a day's challenge, else null. */
  daily: string | null;
  createdBy: { id: string; nickname: string };
  createdAt: string;
  resultCount: number;
  mine: boolean;
}

export interface ResultRow {
  challengeId: string;
  memberId: string;
  nickname: string;
  submittedAt: string;
  outcome: Outcome;
  facts: unknown;
}

/** A club record in the old `GET /records` shape — the leader of one ranking table (club.md §16-1). */
export interface RecordRow {
  gameId: string;
  paramsKey: string;
  facts: unknown;
  memberId: string;
  nickname: string;
  /** Always `''`: records no longer follow challenges; the field keeps the old shape. */
  challengeId: string;
}

/** One result row of one table (game × mode) — club.md §16-1: one row per result. */
export interface RankingEntryRow {
  /** Arrival order and the row's id (`Entry.id` on the wire). */
  seq: number;
  memberId: string;
  nickname: string;
  submittedAt: string;
  facts: unknown;
  seed: string;
  boardDigest: string | null;
  /** The table's axis value, read from `facts` once on the way in (src/contracts/games.ts). */
  value: number;
}

/** A member's best row in a table, where it stands, and the nearest strictly better value. */
export interface RankingStandingRow {
  /** Null past the count's ceiling (limits.rankingRankScan / rankingMineScan). */
  rank: number | null;
  entry: RankingEntryRow;
  /** Null when no row of the table is strictly better — first, or tied with the first. */
  nextValue: number | null;
}

/** One table a member has rows in, for `GET /rankings/mine` (club.md §5-4). */
export interface RankingMineRow {
  gameId: string;
  paramsKey: string;
  entryCount: number;
  leader: RankingEntryRow;
  best: RankingStandingRow;
}

/** A challenge as the public view reads it: no viewer, no creator. */
export interface DailyChallengeRow {
  id: string;
  gameId: string;
  daily: string;
  resultCount: number;
}

/** One of a challenge's best completed results — a name and its facts, nothing that identifies a member. */
export interface TopResultRow {
  nickname: string;
  facts: unknown;
}

export interface ReportedMemberRow {
  member: MemberRow;
  reportCount: number;
}

export interface RankingTableRow {
  gameId: string;
  paramsKey: string;
  entryCount: number;
  leader: RankingEntryRow;
}

const directionOf = (gameId: string): Direction => contractOf(gameId)?.direction ?? 'asc';
const text = (row: Row, key: string): string => String(row[key]);
const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
};
const int = (row: Row, key: string): number => Number(row[key]);
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const toClub = (row: Row): ClubRow => ({
  id: text(row, 'id'),
  name: text(row, 'name'),
  createdAt: text(row, 'created_at'),
  referralUrl: nullableText(row, 'referral_url'),
  lastActivityAt: nullableText(row, 'last_activity_at'),
});

const toMember = (row: Row): MemberRow => ({
  id: text(row, 'id'),
  nickname: text(row, 'nickname'),
  role: text(row, 'role') as Role,
  joinedAt: text(row, 'joined_at'),
  revokedAt: nullableText(row, 'revoked_at'),
});

const toInvite = (row: Row): InviteRow => ({
  id: text(row, 'id'),
  role: text(row, 'role') as Role,
  token: nullableText(row, 'token'),
  tokenHash: text(row, 'token_hash'),
  createdAt: text(row, 'created_at'),
  expiresAt: nullableText(row, 'expires_at'),
  usedAt: nullableText(row, 'used_at'),
  revokedAt: nullableText(row, 'revoked_at'),
});

const toChallenge = (row: Row): ChallengeRow => ({
  id: text(row, 'id'),
  gameId: text(row, 'game_id'),
  contractVersion: int(row, 'contract_version'),
  params: parseJson(text(row, 'params_json')),
  seed: text(row, 'seed'),
  boardDigest: text(row, 'board_digest'),
  title: nullableText(row, 'title'),
  daily: nullableText(row, 'daily'),
  createdBy: { id: text(row, 'created_by'), nickname: text(row, 'creator_nickname') },
  createdAt: text(row, 'created_at'),
  resultCount: int(row, 'result_count'),
  mine: int(row, 'mine') === 1,
});

const toRankingEntry = (row: Row): RankingEntryRow => ({
  seq: int(row, 'seq'),
  memberId: text(row, 'member_id'),
  nickname: text(row, 'nickname'),
  submittedAt: text(row, 'submitted_at'),
  facts: parseJson(text(row, 'facts_json')),
  seed: text(row, 'seed'),
  boardDigest: nullableText(row, 'board_digest'),
  value: Number(row.value),
});

const toResult = (row: Row): ResultRow => ({
  challengeId: text(row, 'challenge_id'),
  memberId: text(row, 'member_id'),
  nickname: text(row, 'nickname'),
  submittedAt: text(row, 'submitted_at'),
  outcome: text(row, 'outcome') as Outcome,
  facts: parseJson(text(row, 'facts_json')),
});

// `mine`: the viewer has a result here, or withdrew one (DELETE …/results/me) and so can
// send nothing more to this challenge — either way the challenge is no longer theirs to play
// for a result. One bound parameter, read twice through the derived row.
const CHALLENGE_SELECT = `
  SELECT c.*, m.nickname AS creator_nickname,
    EXISTS (
      SELECT 1 FROM (SELECT ? AS viewer) me
      WHERE EXISTS (SELECT 1 FROM results r WHERE r.challenge_id = c.id AND r.member_id = me.viewer)
         OR EXISTS (SELECT 1 FROM withdrawn_results w WHERE w.challenge_id = c.id AND w.member_id = me.viewer)
    ) AS mine
  FROM challenges c
  JOIN members m ON m.id = c.created_by
  WHERE c.deleted_at IS NULL`;

export class Store {
  constructor(private readonly db: SqlDriver) {}

  // ---------- club ----------

  getClub(): ClubRow | null {
    const row = this.db.get(`SELECT * FROM club LIMIT 1`);
    return row === undefined ? null : toClub(row);
  }

  createClub(id: string, name: string, now: string): ClubRow {
    this.db.run(
      `INSERT INTO club (id, name, created_at, last_activity_at) VALUES (?, ?, ?, ?)`,
      id,
      name,
      now,
      now,
    );
    return { id, name, createdAt: now, referralUrl: null, lastActivityAt: now };
  }

  renameClub(name: string): void {
    this.db.run(`UPDATE club SET name = ?`, name);
  }

  setReferralUrl(url: string | null): void {
    this.db.run(`UPDATE club SET referral_url = ?`, url);
  }

  /** Every write a member makes moves `lastActivityAt` (club.md §5-2 Hosting). */
  touchActivity(now: string): void {
    this.db.run(`UPDATE club SET last_activity_at = ?`, now);
  }

  // ---------- members ----------

  /** The newest `limit` active members (club.md §17-2). */
  newestMembers(limit: number): MemberRow[] {
    return this.db
      .all(`SELECT * FROM members WHERE revoked_at IS NULL ORDER BY seq DESC LIMIT ?`, limit)
      .map(toMember);
  }

  memberById(id: string): MemberRow | null {
    const row = this.db.get(`SELECT * FROM members WHERE id = ?`, id);
    return row === undefined ? null : toMember(row);
  }

  /** Active members only — a revoked token is a 401, not a ghost (club.md §5-3). */
  memberByTokenHash(hash: string): MemberRow | null {
    const row = this.db.get(
      `SELECT * FROM members WHERE token_hash = ? AND revoked_at IS NULL`,
      hash,
    );
    return row === undefined ? null : toMember(row);
  }

  countActive(role?: Role): number {
    const row =
      role === undefined
        ? this.db.get(`SELECT COUNT(*) AS n FROM members WHERE revoked_at IS NULL`)
        : this.db.get(
            `SELECT COUNT(*) AS n FROM members WHERE revoked_at IS NULL AND role = ?`,
            role,
          );
    return row === undefined ? 0 : int(row, 'n');
  }

  createMember(
    id: string,
    nickname: string,
    role: Role,
    tokenHash: string,
    now: string,
  ): MemberRow {
    this.db.run(
      `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, ?, ?, ?)`,
      id,
      nickname,
      role,
      now,
      tokenHash,
    );
    return { id, nickname, role, joinedAt: now, revokedAt: null };
  }

  revokeMember(id: string, now: string): void {
    this.db.run(`UPDATE members SET revoked_at = ? WHERE id = ?`, now, id);
  }

  /**
   * The owner's remedy of renaming (club.md §17-3): the member's name, and the
   * name carried on their results and ranking rows. The report rows go with it —
   * the remedy has been applied.
   */
  renameMember(id: string, nickname: string): void {
    this.setNickname(id, nickname);
    this.clearReports(id);
  }

  /**
   * A member renaming themselves (club.md §5-3 `PATCH /me`): the same name
   * change, but the reports against them stay — otherwise a reported member
   * could reset the count by renaming.
   */
  renameSelf(id: string, nickname: string): void {
    this.setNickname(id, nickname);
  }

  private setNickname(id: string, nickname: string): void {
    this.db.run(`UPDATE members SET nickname = ? WHERE id = ?`, nickname, id);
    this.db.run(`UPDATE results SET nickname = ? WHERE member_id = ?`, nickname, id);
    this.db.run(`UPDATE ranking_entries SET nickname = ? WHERE member_id = ?`, nickname, id);
  }

  /**
   * The owner's remedy of removing with the work (club.md §17-3): the member's
   * results (and their challenges' `result_count`), their ranking rows (and each
   * table's summary row: count, leader), and the reports against them. Call
   * `revokeMember` as well; this does not.
   */
  purgeMember(id: string): void {
    this.db.run(
      `UPDATE challenges SET result_count = result_count - 1
       WHERE id IN (SELECT challenge_id FROM results WHERE member_id = ?)`,
      id,
    );
    this.db.run(`DELETE FROM results WHERE member_id = ?`, id);
    const tables = this.db.all(
      `SELECT DISTINCT game_id, params_key FROM ranking_entries WHERE member_id = ?`,
      id,
    );
    for (const table of tables) {
      this.removeRankingEntries(text(table, 'game_id'), text(table, 'params_key'), id);
    }
    this.clearReports(id);
  }

  /**
   * A member deleting one of their own results in one ranking table (club.md §5-3
   * `DELETE /rankings/:gameId/:paramsKey/entries/:id`). False when the row does not exist,
   * is in another table, or is someone else's — the caller cannot tell those apart. Their
   * other rows stay, and a later finished game enters the table as usual. Reads by key.
   */
  removeRankingEntryById(
    gameId: string,
    paramsKey: string,
    memberId: string,
    seq: number,
  ): boolean {
    const row = this.db.get(
      `SELECT seq FROM ranking_entries
       WHERE seq = ? AND game_id = ? AND params_key = ? AND member_id = ?`,
      seq,
      gameId,
      paramsKey,
      memberId,
    );
    if (row === undefined) return false;
    this.db.run(`DELETE FROM ranking_entries WHERE seq = ?`, seq);
    this.settleRankingTable(gameId, paramsKey, [seq]);
    return true;
  }

  /**
   * Every row of the member's in one table (the compatible `DELETE …/me`, and the owner's
   * removal with the work). False when they have none. At most `rankingRowsPerMember` rows,
   * found through `ranking_entries_member`.
   */
  removeRankingEntries(gameId: string, paramsKey: string, memberId: string): boolean {
    const seqs = this.db
      .all(
        `SELECT seq FROM ranking_entries WHERE member_id = ? AND game_id = ? AND params_key = ?`,
        memberId,
        gameId,
        paramsKey,
      )
      .map((row) => int(row, 'seq'));
    if (seqs.length === 0) return false;
    this.db.run(
      `DELETE FROM ranking_entries WHERE member_id = ? AND game_id = ? AND params_key = ?`,
      memberId,
      gameId,
      paramsKey,
    );
    this.settleRankingTable(gameId, paramsKey, seqs);
    return true;
  }

  /**
   * Keeps a table's summary row (count, leader) in step once the rows `removed` are gone: the
   * summary goes when the table empties, and when the leading row was among them, the next
   * leader is the best remaining value, the earliest on a tie. Both reads walk
   * `ranking_entries_table`, so they read one row each however large the table is. Returns
   * the table's count after.
   */
  private settleRankingTable(
    gameId: string,
    paramsKey: string,
    removed: readonly number[],
  ): number {
    const summary = this.db.get(
      `SELECT entry_count, leader_seq FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
      gameId,
      paramsKey,
    );
    if (summary === undefined) return 0;
    const dropTable = (): number => {
      this.db.run(
        `DELETE FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
        gameId,
        paramsKey,
      );
      return 0;
    };
    const count = int(summary, 'entry_count') - removed.length;
    if (count <= 0) return dropTable();
    let leader = int(summary, 'leader_seq');
    if (removed.includes(leader)) {
      const best = this.db.get(
        `SELECT value FROM ranking_entries WHERE game_id = ? AND params_key = ?
         ORDER BY value ${directionOf(gameId) === 'asc' ? 'ASC' : 'DESC'} LIMIT 1`,
        gameId,
        paramsKey,
      );
      const next =
        best === undefined
          ? undefined
          : this.db.get(
              `SELECT seq FROM ranking_entries
               WHERE game_id = ? AND params_key = ? AND value = ? ORDER BY seq LIMIT 1`,
              gameId,
              paramsKey,
              Number(best.value),
            );
      // Out of step with the entries (cannot happen): the table is empty after all.
      if (next === undefined) return dropTable();
      leader = int(next, 'seq');
    }
    // The count changed, so `ranking_tables_popular` is rewritten anyway.
    this.db.run(
      `UPDATE ranking_tables SET entry_count = ?, leader_seq = ?
       WHERE game_id = ? AND params_key = ?`,
      count,
      leader,
      gameId,
      paramsKey,
    );
    return count;
  }

  // ---------- reports (club.md §17-3) ----------

  /** One report per (target, reporter); a second one changes nothing. */
  addReport(targetId: string, reporterId: string, now: string): void {
    const seen = this.db.get(
      `SELECT 1 FROM reports WHERE target_id = ? AND reporter_id = ?`,
      targetId,
      reporterId,
    );
    if (seen !== undefined) return;
    this.db.run(
      `INSERT INTO reports (target_id, reporter_id, created_at) VALUES (?, ?, ?)`,
      targetId,
      reporterId,
      now,
    );
    this.db.run(`UPDATE members SET report_count = report_count + 1 WHERE id = ?`, targetId);
  }

  clearReports(targetId: string): void {
    this.db.run(`DELETE FROM reports WHERE target_id = ?`, targetId);
    this.db.run(`UPDATE members SET report_count = 0 WHERE id = ?`, targetId);
  }

  /** Active members with at least one report: most reported first, then the oldest member. */
  reportedMembers(limit: number): ReportedMemberRow[] {
    return this.db
      .all(
        `SELECT * FROM members WHERE revoked_at IS NULL AND report_count > 0
         ORDER BY report_count DESC, seq LIMIT ?`,
        limit,
      )
      .map((row) => ({ member: toMember(row), reportCount: int(row, 'report_count') }));
  }

  // ---------- setup key ----------

  isSetupKeyUsed(hash: string): boolean {
    return this.db.get(`SELECT 1 FROM setup_keys_used WHERE hash = ?`, hash) !== undefined;
  }

  markSetupKeyUsed(hash: string, now: string): void {
    this.db.run(`INSERT INTO setup_keys_used (hash, used_at) VALUES (?, ?)`, hash, now);
  }

  // ---------- invites ----------

  /** The current member invite — the one the owner hands out. */
  memberInvite(): InviteRow | null {
    const row = this.db.get(
      `SELECT * FROM invites WHERE role = 'member' AND revoked_at IS NULL ORDER BY seq DESC`,
    );
    return row === undefined ? null : toInvite(row);
  }

  /** Rotates: the previous member invite stops working the moment the new one exists. */
  replaceMemberInvite(id: string, token: string, tokenHash: string, now: string): InviteRow {
    this.db.run(
      `UPDATE invites SET revoked_at = ? WHERE role = 'member' AND revoked_at IS NULL`,
      now,
    );
    this.db.run(
      `INSERT INTO invites (id, role, token, token_hash, created_at) VALUES (?, 'member', ?, ?, ?)`,
      id,
      token,
      tokenHash,
      now,
    );
    return {
      id,
      role: 'member',
      token,
      tokenHash,
      createdAt: now,
      expiresAt: null,
      usedAt: null,
      revokedAt: null,
    };
  }

  /** An owner link: hashed, one use, with an expiry (club.md §8-3). */
  createOwnerInvite(id: string, tokenHash: string, now: string, expiresAt: string): InviteRow {
    this.db.run(
      `INSERT INTO invites (id, role, token_hash, created_at, expires_at) VALUES (?, 'owner', ?, ?, ?)`,
      id,
      tokenHash,
      now,
      expiresAt,
    );
    return {
      id,
      role: 'owner',
      token: null,
      tokenHash,
      createdAt: now,
      expiresAt,
      usedAt: null,
      revokedAt: null,
    };
  }

  inviteByTokenHash(hash: string): InviteRow | null {
    const row = this.db.get(`SELECT * FROM invites WHERE token_hash = ?`, hash);
    return row === undefined ? null : toInvite(row);
  }

  markInviteUsed(id: string, now: string): void {
    this.db.run(`UPDATE invites SET used_at = ? WHERE id = ?`, now, id);
  }

  // ---------- challenges ----------

  createChallenge(input: {
    id: string;
    gameId: string;
    contractVersion: number;
    params: unknown;
    seed: string;
    boardDigest: string;
    title: string | null;
    daily: string | null;
    createdBy: string;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO challenges
           (id, game_id, contract_version, params_json, seed, board_digest, title, daily, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.gameId,
      input.contractVersion,
      JSON.stringify(input.params),
      input.seed,
      input.boardDigest,
      input.title,
      input.daily,
      input.createdBy,
      input.now,
    );
  }

  challengeById(id: string, viewerId: string): ChallengeRow | null {
    const row = this.db.get(`${CHALLENGE_SELECT} AND c.id = ?`, viewerId, id);
    return row === undefined ? null : toChallenge(row);
  }

  /** The oldest live challenge on this exact board — "one challenge per board" (club.md §6-3). */
  liveChallengeOnBoard(
    gameId: string,
    seed: string,
    boardDigest: string,
    viewerId: string,
  ): ChallengeRow | null {
    const row = this.db.get(
      `${CHALLENGE_SELECT} AND c.game_id = ? AND c.seed = ? AND c.board_digest = ?
       ORDER BY c.seq LIMIT 1`,
      viewerId,
      gameId,
      seed,
      boardDigest,
    );
    return row === undefined ? null : toChallenge(row);
  }

  /**
   * Newest first; `afterId` continues past that challenge (club.md §5-3);
   * `daily` keeps only the challenges tagged with that day.
   */
  listChallenges(
    viewerId: string,
    afterId: string | null,
    limit: number,
    daily: string | null = null,
  ): ChallengeRow[] {
    const bindings: (string | number)[] = [viewerId];
    let where = '';
    if (daily !== null) {
      where += ' AND c.daily = ?';
      bindings.push(daily);
    }
    if (afterId !== null) {
      where += ' AND c.seq < (SELECT seq FROM challenges WHERE id = ?)';
      bindings.push(afterId);
    }
    bindings.push(limit);
    return this.db
      .all(`${CHALLENGE_SELECT}${where} ORDER BY c.seq DESC LIMIT ?`, ...bindings)
      .map(toChallenge);
  }

  /** Soft delete. Ranking rows are not bound to a challenge and stand on their own (club.md §16). */
  deleteChallenge(id: string, now: string): void {
    this.db.run(`UPDATE challenges SET deleted_at = ? WHERE id = ?`, now, id);
  }

  // ---------- results ----------

  /**
   * A challenge's best `limit` results, best first (club.md §5-3): completed results with
   * the game's axis by that axis, then the rest of the completed, then the played, and
   * earlier submission first on every tie — the order `resultRank` fixes and the
   * `results_rank` index stores, so this reads `limit` rows however many were submitted.
   * The viewer's own row is always in the answer: when it is not among the best it
   * follows them (one more row, found by the unique index), so a member sees their own
   * result in a challenge of thousands.
   */
  bestResults(challengeId: string, viewerId: string, limit: number): ResultRow[] {
    const rows = this.db
      .all(
        `SELECT * FROM results WHERE challenge_id = ?
         ORDER BY rank_class, rank_key, seq LIMIT ?`,
        challengeId,
        limit,
      )
      .map(toResult);
    // Fewer than `limit` rows is every row there is, the viewer's included.
    if (rows.length >= limit && !rows.some((row) => row.memberId === viewerId)) {
      const own = this.db.get(
        `SELECT * FROM results WHERE challenge_id = ? AND member_id = ?`,
        challengeId,
        viewerId,
      );
      if (own !== undefined) rows.push(toResult(own));
    }
    return rows;
  }

  /**
   * Whether the member has sent a result to this challenge: one they still have, or one they
   * deleted (`withdrawResult` leaves a mark). Either way they may not send another —
   * "one result per member per challenge" outlives the delete.
   */
  alreadySubmitted(challengeId: string, memberId: string): boolean {
    return (
      this.hasResult(challengeId, memberId) ||
      this.db.get(
        `SELECT 1 FROM withdrawn_results WHERE challenge_id = ? AND member_id = ?`,
        challengeId,
        memberId,
      ) !== undefined
    );
  }

  /**
   * A member deleting their own result from a challenge (club.md §5-3
   * `DELETE /challenges/:id/results/me`): the row goes, `result_count` follows, and a
   * withdrawal mark is written so they cannot send another. Returns false when they have
   * no result there. Both reads and the delete use the `(challenge_id, member_id)` key.
   */
  withdrawResult(challengeId: string, memberId: string): boolean {
    if (!this.hasResult(challengeId, memberId)) return false;
    this.db.run(
      `DELETE FROM results WHERE challenge_id = ? AND member_id = ?`,
      challengeId,
      memberId,
    );
    this.db.run(`UPDATE challenges SET result_count = result_count - 1 WHERE id = ?`, challengeId);
    this.db.run(
      `INSERT OR IGNORE INTO withdrawn_results (challenge_id, member_id) VALUES (?, ?)`,
      challengeId,
      memberId,
    );
    return true;
  }

  private hasResult(challengeId: string, memberId: string): boolean {
    return (
      this.db.get(
        `SELECT 1 FROM results WHERE challenge_id = ? AND member_id = ?`,
        challengeId,
        memberId,
      ) !== undefined
    );
  }

  addResult(input: {
    challengeId: string;
    /** The challenge's game: its contract says where the result sorts. */
    gameId: string;
    memberId: string;
    nickname: string;
    now: string;
    outcome: Outcome;
    facts: unknown;
  }): ResultRow {
    const { rankClass, rankKey } = resultRank(input.gameId, input.outcome, input.facts);
    this.db.run(
      `INSERT INTO results
           (challenge_id, member_id, nickname, submitted_at, outcome, facts_json, rank_class, rank_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.challengeId,
      input.memberId,
      input.nickname,
      input.now,
      input.outcome,
      JSON.stringify(input.facts),
      rankClass,
      rankKey,
    );
    this.db.run(
      `UPDATE challenges SET result_count = result_count + 1 WHERE id = ?`,
      input.challengeId,
    );
    return {
      challengeId: input.challengeId,
      memberId: input.memberId,
      nickname: input.nickname,
      submittedAt: input.now,
      outcome: input.outcome,
      facts: input.facts,
    };
  }

  // ---------- the LP's read-only view (club.md §18) ----------

  /** The live challenges tagged with `daily`, oldest first, at most `limit`. */
  dailyChallenges(daily: string, limit: number): DailyChallengeRow[] {
    return this.db
      .all(
        `SELECT id, game_id, daily, result_count FROM challenges
         WHERE daily = ? AND deleted_at IS NULL ORDER BY seq LIMIT ?`,
        daily,
        limit,
      )
      .map((row) => ({
        id: text(row, 'id'),
        gameId: text(row, 'game_id'),
        daily: text(row, 'daily'),
        resultCount: int(row, 'result_count'),
      }));
  }

  /**
   * A challenge's best `limit` completed results by the game's axis fact (src/contracts/
   * games.ts), earlier submission first on a tie — the head of the `results_rank` index,
   * class 0 of `resultRank`: a result whose axis is not a number is left out. The one
   * place the server ranks a Result for a reader outside the club.
   */
  topResults(challengeId: string, limit: number): TopResultRow[] {
    return this.db
      .all(
        `SELECT nickname, facts_json FROM results
         WHERE challenge_id = ? AND rank_class = 0
         ORDER BY rank_key, seq LIMIT ?`,
        challengeId,
        limit,
      )
      .map((row) => ({
        nickname: text(row, 'nickname'),
        facts: parseJson(text(row, 'facts_json')),
      }));
  }

  // ---------- rankings (club.md §16) ----------

  /**
   * Stores a completed result as a new row of its table — every finished game is a row
   * (club.md §16-1). The row takes the next `seq` (meta `ranking_seq`, never reused), so
   * equal values order by arrival, and the table's summary row (count, leader) follows in
   * O(1). Then the member is held to `rowsPerMember` rows in the table: past it their worst
   * row goes (the worst value, the latest on a tie) — which can be the row just stored, and
   * then `entry` is null. `improved` says the row is strictly better than every other row of
   * the member's in the table (a first row is; an equal one is not). Every read here walks an
   * index to one row, except the cap's count, which stops at `rowsPerMember + 1`.
   *
   * With a `clientId` the call is idempotent per member (club.md §16-1): if the member already
   * has a row with that key, nothing is written — not the row, not the counter, not the summary,
   * not the cap — and that row comes back with `duplicate: true` and `improved: false`, so a
   * result whose answer was lost can be sent again. One indexed read (`ranking_entries_client`)
   * decides it. The row is looked up by the pair alone, so a key reused for another table
   * answers with the stored row and its own table (`gameId` / `paramsKey` say which). Only a
   * stored row is remembered: a result the cap dropped the moment it came in, or a row the
   * member has since deleted, is not, and sending it again stores it afresh.
   */
  addRanking(input: {
    gameId: string;
    paramsKey: string;
    memberId: string;
    nickname: string;
    value: number;
    facts: unknown;
    seed: string;
    boardDigest: string | null;
    now: string;
    rowsPerMember: number;
    /** The client's idempotency key for this result; none for a client that sends none. */
    clientId?: string | null;
  }): {
    entry: RankingEntryRow | null;
    improved: boolean;
    entryCount: number;
    /** True when the member's row with this `clientId` already existed and nothing was written. */
    duplicate: boolean;
    /** The table the answer is about: the input's, or the stored row's for a duplicate. */
    gameId: string;
    paramsKey: string;
  } {
    const clientId = input.clientId ?? null;
    if (clientId !== null) {
      const stored = this.db.get(
        `SELECT * FROM ranking_entries WHERE member_id = ? AND client_id = ?`,
        input.memberId,
        clientId,
      );
      if (stored !== undefined) {
        const gameId = text(stored, 'game_id');
        const paramsKey = text(stored, 'params_key');
        return {
          entry: toRankingEntry(stored),
          improved: false,
          entryCount: this.rankingCount(gameId, paramsKey),
          duplicate: true,
          gameId,
          paramsKey,
        };
      }
    }
    const fresh = { duplicate: false, gameId: input.gameId, paramsKey: input.paramsKey };
    const asc = directionOf(input.gameId) === 'asc';
    const isBetter = (value: number, than: number): boolean => (asc ? value < than : value > than);
    // A row of theirs as good as this one or better: then this one is no improvement.
    const asGood = this.db.get(
      `SELECT 1 FROM ranking_entries
       WHERE member_id = ? AND game_id = ? AND params_key = ? AND value ${asc ? '<=' : '>='} ?
       LIMIT 1`,
      input.memberId,
      input.gameId,
      input.paramsKey,
      input.value,
    );

    // One writer per deployment, so read-increment-write needs no lock.
    const counter = this.db.get(`SELECT value FROM meta WHERE key = 'ranking_seq'`);
    const seq = (counter === undefined ? 0 : Number(counter.value)) + 1;
    this.db.run(
      `INSERT INTO meta (key, value) VALUES ('ranking_seq', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(seq),
    );
    const factsJson = JSON.stringify(input.facts);
    this.db.run(
      `INSERT INTO ranking_entries
         (game_id, params_key, member_id, nickname, value, facts_json, seed, board_digest,
          submitted_at, seq, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.gameId,
      input.paramsKey,
      input.memberId,
      input.nickname,
      input.value,
      factsJson,
      input.seed,
      input.boardDigest,
      input.now,
      seq,
      clientId,
    );
    const entry: RankingEntryRow = {
      seq,
      memberId: input.memberId,
      nickname: input.nickname,
      submittedAt: input.now,
      facts: parseJson(factsJson),
      seed: input.seed,
      boardDigest: input.boardDigest,
      value: input.value,
    };

    const summary = this.db.get(
      `SELECT entry_count, leader_seq FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
      input.gameId,
      input.paramsKey,
    );
    let entryCount: number;
    if (summary === undefined) {
      this.db.run(
        `INSERT INTO ranking_tables (game_id, params_key, entry_count, leader_seq)
         VALUES (?, ?, 1, ?)`,
        input.gameId,
        input.paramsKey,
        seq,
      );
      entryCount = 1;
    } else {
      const leaderSeq = int(summary, 'leader_seq');
      const leader = this.db.get(`SELECT value FROM ranking_entries WHERE seq = ?`, leaderSeq);
      // Strictly better only: an equal value stays behind the earlier leader.
      const takesLead = leader === undefined || isBetter(input.value, Number(leader.value));
      entryCount = int(summary, 'entry_count') + 1;
      this.db.run(
        `UPDATE ranking_tables SET entry_count = ?, leader_seq = ?
         WHERE game_id = ? AND params_key = ?`,
        entryCount,
        takesLead ? seq : leaderSeq,
        input.gameId,
        input.paramsKey,
      );
    }

    // The member's rows in this table, through the member index: in the steady state at
    // most the cap and one, so the count reads that many rows. Every row past the cap goes,
    // worst first — one row per result normally, but all of the excess at once when the cap
    // was lowered after rows existed, so the configured bound holds from the next write.
    const held = this.db.get(
      `SELECT COUNT(*) AS n FROM ranking_entries
       WHERE member_id = ? AND game_id = ? AND params_key = ?`,
      input.memberId,
      input.gameId,
      input.paramsKey,
    );
    let excess = held === undefined ? 0 : int(held, 'n') - input.rowsPerMember;
    if (excess > 0) {
      const dropped: number[] = [];
      while (excess > 0) {
        const worst = this.memberRow(input.gameId, input.paramsKey, input.memberId, 'worst');
        if (worst === null) break;
        this.db.run(`DELETE FROM ranking_entries WHERE seq = ?`, worst.seq);
        dropped.push(worst.seq);
        excess -= 1;
      }
      entryCount = this.settleRankingTable(input.gameId, input.paramsKey, dropped);
      if (dropped.includes(seq)) return { ...fresh, entry: null, improved: false, entryCount };
    }
    return { ...fresh, entry, improved: asGood === undefined, entryCount };
  }

  /** The member's best row in a table (the best value, the earliest on a tie), or null. */
  bestOf(gameId: string, paramsKey: string, memberId: string): RankingEntryRow | null {
    return this.memberRow(gameId, paramsKey, memberId, 'best');
  }

  /**
   * The member's best or worst row in a table through `ranking_entries_member`: the extreme
   * value (one index row), then the earliest (best) or latest (worst) row at it — the order
   * `rankingTop` lists in, so the worst is the row that would be listed last.
   */
  private memberRow(
    gameId: string,
    paramsKey: string,
    memberId: string,
    which: 'best' | 'worst',
  ): RankingEntryRow | null {
    const asc = directionOf(gameId) === 'asc';
    const lowest = asc === (which === 'best');
    const extreme = this.db.get(
      `SELECT value FROM ranking_entries WHERE member_id = ? AND game_id = ? AND params_key = ?
       ORDER BY value ${lowest ? 'ASC' : 'DESC'} LIMIT 1`,
      memberId,
      gameId,
      paramsKey,
    );
    if (extreme === undefined) return null;
    const row = this.db.get(
      `SELECT * FROM ranking_entries
       WHERE member_id = ? AND game_id = ? AND params_key = ? AND value = ?
       ORDER BY seq ${which === 'best' ? 'ASC' : 'DESC'} LIMIT 1`,
      memberId,
      gameId,
      paramsKey,
      Number(extreme.value),
    );
    return row === undefined ? null : toRankingEntry(row);
  }

  /** The table's row count, from its summary row. */
  rankingCount(gameId: string, paramsKey: string): number {
    const row = this.db.get(
      `SELECT entry_count FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
      gameId,
      paramsKey,
    );
    return row === undefined ? 0 : int(row, 'entry_count');
  }

  /**
   * The rank of one row: 1 + the rows that are better, or equal and earlier (lower `seq`) —
   * the order `rankingTop` lists in. Two range counts on `ranking_entries_table` (better
   * values; then the equal value below this `seq`), not one `OR`, which node:sqlite's planner
   * answered by counting the whole table. Each stops at what is left of `scanLimit`: at the
   * ceiling the rank is unknown and this returns `null` (limits.rankingRankScan).
   */
  rankOf(
    gameId: string,
    paramsKey: string,
    entry: { value: number; seq: number },
    scanLimit: number,
  ): number | null {
    const better = directionOf(gameId) === 'asc' ? '<' : '>';
    const ahead = this.db.get(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM ranking_entries WHERE game_id = ? AND params_key = ? AND value ${better} ?
         LIMIT ?)`,
      gameId,
      paramsKey,
      entry.value,
      scanLimit,
    );
    let n = ahead === undefined ? 0 : int(ahead, 'n');
    if (n >= scanLimit) return null;
    const tiedEarlier = this.db.get(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM ranking_entries
         WHERE game_id = ? AND params_key = ? AND value = ? AND seq < ?
         LIMIT ?)`,
      gameId,
      paramsKey,
      entry.value,
      entry.seq,
      scanLimit - n,
    );
    n += tiedEarlier === undefined ? 0 : int(tiedEarlier, 'n');
    return n >= scanLimit ? null : n + 1;
  }

  /**
   * The nearest value strictly better than `value` in the table — "to the next rank" (club.md
   * §16-2) — or null when none is. An equal value that arrived earlier does not count: the gap
   * to it would be zero. One row off `ranking_entries_table`, walked from `value` outwards.
   */
  nextValue(gameId: string, paramsKey: string, value: number): number | null {
    const asc = directionOf(gameId) === 'asc';
    const row = this.db.get(
      `SELECT value FROM ranking_entries
       WHERE game_id = ? AND params_key = ? AND value ${asc ? '<' : '>'} ?
       ORDER BY value ${asc ? 'DESC' : 'ASC'} LIMIT 1`,
      gameId,
      paramsKey,
      value,
    );
    return row === undefined ? null : Number(row.value);
  }

  /** A member's best row in a table with its rank (counted to `scanLimit`) and the next value. */
  standing(
    gameId: string,
    paramsKey: string,
    entry: RankingEntryRow,
    scanLimit: number,
  ): RankingStandingRow {
    return {
      rank: this.rankOf(gameId, paramsKey, entry, scanLimit),
      entry,
      nextValue: this.nextValue(gameId, paramsKey, entry.value),
    };
  }

  /**
   * `GET /rankings/mine`: the tables the member has rows in, by game then mode, each with its
   * count, its leader and the member's standing. The tables come from one walk of the member's
   * own rows in `ranking_entries_member`; per table it is the summary row and the leader's row
   * by key, the member's best (two index rows), a rank counted to `scanLimit`, and one row for
   * the next value — nothing that grows with the club or with the table.
   */
  rankingsMine(memberId: string, scanLimit: number): RankingMineRow[] {
    const tables = this.db.all(
      `SELECT DISTINCT game_id, params_key FROM ranking_entries WHERE member_id = ?
       ORDER BY game_id, params_key`,
      memberId,
    );
    return tables.flatMap((table) => {
      const gameId = text(table, 'game_id');
      const paramsKey = text(table, 'params_key');
      const summary = this.db.get(
        `SELECT e.*, t.entry_count FROM ranking_tables t
         JOIN ranking_entries e ON e.seq = t.leader_seq
         WHERE t.game_id = ? AND t.params_key = ?`,
        gameId,
        paramsKey,
      );
      const best = this.bestOf(gameId, paramsKey, memberId);
      // A row without its summary cannot happen; if it ever does there is nothing to show.
      if (summary === undefined || best === null) return [];
      return [
        {
          gameId,
          paramsKey,
          entryCount: int(summary, 'entry_count'),
          leader: toRankingEntry(summary),
          best: this.standing(gameId, paramsKey, best, scanLimit),
        },
      ];
    });
  }

  /**
   * The best `limit` rows of a table, in rank order, reading about `limit` rows whatever
   * the table's size. Lower-is-better is one walk of the `(game_id, params_key, value, seq)`
   * index. Higher-is-better cannot be: the index runs `seq` ascending under a descending
   * `value`, so one query would read the whole group tied at the cut before sorting it
   * (and a capped score ties in hundreds). It is three bounded reads instead: the value at
   * the cut, the entries strictly above it (fewer than `limit`), and the earliest of those
   * tied at it.
   */
  rankingTop(gameId: string, paramsKey: string, limit: number): RankingEntryRow[] {
    if (directionOf(gameId) === 'asc') {
      return this.db
        .all(
          `SELECT * FROM ranking_entries WHERE game_id = ? AND params_key = ?
           ORDER BY value, seq LIMIT ?`,
          gameId,
          paramsKey,
          limit,
        )
        .map(toRankingEntry);
    }
    const cut = this.db.get(
      `SELECT value FROM ranking_entries WHERE game_id = ? AND params_key = ?
       ORDER BY value DESC LIMIT 1 OFFSET ?`,
      gameId,
      paramsKey,
      limit - 1,
    );
    // Fewer than `limit` entries: every one of them is in the answer.
    if (cut === undefined) {
      return this.db
        .all(
          `SELECT * FROM ranking_entries WHERE game_id = ? AND params_key = ?
           ORDER BY value DESC, seq`,
          gameId,
          paramsKey,
        )
        .map(toRankingEntry);
    }
    const value = Number(cut.value);
    const above = this.db
      .all(
        `SELECT * FROM ranking_entries WHERE game_id = ? AND params_key = ? AND value > ?
         ORDER BY value DESC, seq`,
        gameId,
        paramsKey,
        value,
      )
      .map(toRankingEntry);
    const tied = this.db
      .all(
        `SELECT * FROM ranking_entries WHERE game_id = ? AND params_key = ? AND value = ?
         ORDER BY seq LIMIT ?`,
        gameId,
        paramsKey,
        value,
        limit - above.length,
      )
      .map(toRankingEntry);
    return [...above, ...tied];
  }

  /**
   * One row per table with its leader: the summary table joined to the
   * leader's row by its key (`leader_seq`), so the cost is the number of tables.
   */
  rankingTables(): RankingTableRow[] {
    return this.db
      .all(
        `SELECT e.*, t.entry_count FROM ranking_tables t
         JOIN ranking_entries e ON e.seq = t.leader_seq
         ORDER BY t.game_id, t.params_key`,
      )
      .map((row) => ({
        gameId: text(row, 'game_id'),
        paramsKey: text(row, 'params_key'),
        entryCount: int(row, 'entry_count'),
        leader: toRankingEntry(row),
      }));
  }

  /**
   * The `limit` most-entered tables, most first (ties by game, then mode): the landing
   * page's view. Read straight off `ranking_tables_popular`, so the cost is `limit`
   * rows whatever the number of tables.
   */
  popularRankingTables(limit: number): { gameId: string; paramsKey: string; entryCount: number }[] {
    return this.db
      .all(
        `SELECT game_id, params_key, entry_count FROM ranking_tables
         ORDER BY entry_count DESC, game_id, params_key LIMIT ?`,
        limit,
      )
      .map((row) => ({
        gameId: text(row, 'game_id'),
        paramsKey: text(row, 'params_key'),
        entryCount: int(row, 'entry_count'),
      }));
  }

  /** `GET /records`: the leaders of the rankings in the old shape (club.md §16-1). */
  records(): RecordRow[] {
    return this.rankingTables().map((table) => ({
      gameId: table.gameId,
      paramsKey: table.paramsKey,
      facts: table.leader.facts,
      memberId: table.leader.memberId,
      nickname: table.leader.nickname,
      challengeId: '',
    }));
  }
}
