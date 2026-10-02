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

/** One member's personal best in one table (game × mode) — club.md §16. */
export interface RankingEntryRow {
  memberId: string;
  nickname: string;
  submittedAt: string;
  facts: unknown;
  seed: string;
  boardDigest: string | null;
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
/** `ORDER BY` for a table, best first; ties by arrival (`seq`), earlier first. */
const orderBy = (direction: Direction): string =>
  `value ${direction === 'asc' ? 'ASC' : 'DESC'}, seq`;

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
  memberId: text(row, 'member_id'),
  nickname: text(row, 'nickname'),
  submittedAt: text(row, 'submitted_at'),
  facts: parseJson(text(row, 'facts_json')),
  seed: text(row, 'seed'),
  boardDigest: nullableText(row, 'board_digest'),
});

const toResult = (row: Row): ResultRow => ({
  challengeId: text(row, 'challenge_id'),
  memberId: text(row, 'member_id'),
  nickname: text(row, 'nickname'),
  submittedAt: text(row, 'submitted_at'),
  outcome: text(row, 'outcome') as Outcome,
  facts: parseJson(text(row, 'facts_json')),
});

const CHALLENGE_SELECT = `
  SELECT c.*, m.nickname AS creator_nickname,
    EXISTS (SELECT 1 FROM results r WHERE r.challenge_id = c.id AND r.member_id = ?) AS mine
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
    this.db.run(`UPDATE members SET nickname = ? WHERE id = ?`, nickname, id);
    this.db.run(`UPDATE results SET nickname = ? WHERE member_id = ?`, nickname, id);
    this.db.run(`UPDATE ranking_entries SET nickname = ? WHERE member_id = ?`, nickname, id);
    this.clearReports(id);
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
      `SELECT game_id, params_key FROM ranking_entries WHERE member_id = ?`,
      id,
    );
    this.db.run(`DELETE FROM ranking_entries WHERE member_id = ?`, id);
    for (const table of tables) {
      const gameId = text(table, 'game_id');
      const paramsKey = text(table, 'params_key');
      const summary = this.db.get(
        `SELECT entry_count, leader_member_id FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
        gameId,
        paramsKey,
      );
      if (summary === undefined) continue;
      const count = int(summary, 'entry_count') - 1;
      if (count <= 0) {
        this.db.run(
          `DELETE FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
          gameId,
          paramsKey,
        );
        continue;
      }
      let leader = text(summary, 'leader_member_id');
      if (leader === id) {
        const next = this.db.get(
          `SELECT member_id FROM ranking_entries WHERE game_id = ? AND params_key = ?
           ORDER BY ${orderBy(directionOf(gameId))} LIMIT 1`,
          gameId,
          paramsKey,
        );
        // Out of step with the entries (cannot happen): the table is empty after all.
        if (next === undefined) {
          this.db.run(
            `DELETE FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
            gameId,
            paramsKey,
          );
          continue;
        }
        leader = text(next, 'member_id');
      }
      this.db.run(
        `UPDATE ranking_tables SET entry_count = ?, leader_member_id = ?
         WHERE game_id = ? AND params_key = ?`,
        count,
        leader,
        gameId,
        paramsKey,
      );
    }
    this.clearReports(id);
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

  /** Soft delete. Rankings are personal bests and stand on their own (club.md §16). */
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

  hasResult(challengeId: string, memberId: string): boolean {
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

  rankingEntry(gameId: string, paramsKey: string, memberId: string): RankingEntryRow | null {
    const row = this.db.get(
      `SELECT * FROM ranking_entries WHERE game_id = ? AND params_key = ? AND member_id = ?`,
      gameId,
      paramsKey,
      memberId,
    );
    return row === undefined ? null : toRankingEntry(row);
  }

  /**
   * Stores a completed result as the member's row when the table has none of
   * theirs or this one is STRICTLY better (an equal value keeps the earlier
   * row). Every write takes the next `seq`, so equal values order by arrival.
   * Keeps the table's summary row (count, leader) in step in O(1). Returns
   * whether the table changed.
   */
  offerRanking(input: {
    gameId: string;
    paramsKey: string;
    memberId: string;
    nickname: string;
    value: number;
    facts: unknown;
    seed: string;
    boardDigest: string | null;
    now: string;
  }): boolean {
    const asc = directionOf(input.gameId) === 'asc';
    const isBetter = (value: number, than: number): boolean => (asc ? value < than : value > than);
    const existing = this.db.get(
      `SELECT value FROM ranking_entries WHERE game_id = ? AND params_key = ? AND member_id = ?`,
      input.gameId,
      input.paramsKey,
      input.memberId,
    );
    if (existing !== undefined && !isBetter(input.value, Number(existing.value))) return false;

    // One writer per deployment, so read-increment-write needs no lock.
    const counter = this.db.get(`SELECT value FROM meta WHERE key = 'ranking_seq'`);
    const seq = (counter === undefined ? 0 : Number(counter.value)) + 1;
    this.db.run(
      `INSERT INTO meta (key, value) VALUES ('ranking_seq', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(seq),
    );
    this.db.run(
      `INSERT INTO ranking_entries
         (game_id, params_key, member_id, nickname, value, facts_json, seed, board_digest,
          submitted_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, params_key, member_id) DO UPDATE SET
         nickname = excluded.nickname, value = excluded.value, facts_json = excluded.facts_json,
         seed = excluded.seed, board_digest = excluded.board_digest,
         submitted_at = excluded.submitted_at, seq = excluded.seq`,
      input.gameId,
      input.paramsKey,
      input.memberId,
      input.nickname,
      input.value,
      JSON.stringify(input.facts),
      input.seed,
      input.boardDigest,
      input.now,
      seq,
    );

    const summary = this.db.get(
      `SELECT leader_member_id FROM ranking_tables WHERE game_id = ? AND params_key = ?`,
      input.gameId,
      input.paramsKey,
    );
    if (summary === undefined) {
      this.db.run(
        `INSERT INTO ranking_tables (game_id, params_key, entry_count, leader_member_id)
         VALUES (?, ?, 1, ?)`,
        input.gameId,
        input.paramsKey,
        input.memberId,
      );
      return true;
    }
    const leaderId = text(summary, 'leader_member_id');
    let takesLead = leaderId === input.memberId;
    if (!takesLead) {
      const leader = this.db.get(
        `SELECT value FROM ranking_entries WHERE game_id = ? AND params_key = ? AND member_id = ?`,
        input.gameId,
        input.paramsKey,
        leaderId,
      );
      // Strictly better only: an equal value stays behind the earlier leader.
      takesLead = leader === undefined || isBetter(input.value, Number(leader.value));
    }
    if (existing === undefined) {
      this.db.run(
        `UPDATE ranking_tables SET entry_count = entry_count + 1, leader_member_id = ?
         WHERE game_id = ? AND params_key = ?`,
        takesLead ? input.memberId : leaderId,
        input.gameId,
        input.paramsKey,
      );
    } else if (takesLead && leaderId !== input.memberId) {
      // An improvement leaves the count alone: not naming `entry_count` keeps its index
      // (`ranking_tables_popular`) from being rewritten for nothing.
      this.db.run(
        `UPDATE ranking_tables SET leader_member_id = ? WHERE game_id = ? AND params_key = ?`,
        input.memberId,
        input.gameId,
        input.paramsKey,
      );
    }
    return true;
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
   * 1 + the rows that are better, or equal and earlier (lower `seq`) — the
   * order `rankingTop` lists in. Counts through the index and stops at
   * `scanLimit` better rows: past that the rank is unknown and this returns
   * `null`, as it does for a member with no row (limits.rankingRankScan).
   */
  rankOf(gameId: string, paramsKey: string, memberId: string, scanLimit: number): number | null {
    const mine = this.db.get(
      `SELECT value, seq FROM ranking_entries
       WHERE game_id = ? AND params_key = ? AND member_id = ?`,
      gameId,
      paramsKey,
      memberId,
    );
    if (mine === undefined) return null;
    const better = directionOf(gameId) === 'asc' ? '<' : '>';
    const row = this.db.get(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM ranking_entries
         WHERE game_id = ? AND params_key = ? AND (value ${better} ? OR (value = ? AND seq < ?))
         LIMIT ?)`,
      gameId,
      paramsKey,
      Number(mine.value),
      Number(mine.value),
      Number(mine.seq),
      scanLimit,
    );
    const n = row === undefined ? 0 : int(row, 'n');
    return n >= scanLimit ? null : n + 1;
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
   * leader's row by primary key, so the cost is the number of tables.
   */
  rankingTables(): RankingTableRow[] {
    return this.db
      .all(
        `SELECT e.*, t.entry_count FROM ranking_tables t
         JOIN ranking_entries e
           ON e.game_id = t.game_id AND e.params_key = t.params_key
          AND e.member_id = t.leader_member_id
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
