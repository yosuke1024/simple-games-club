/**
 * Every SQL statement, behind typed methods. Handlers never see a row.
 */
import { GAME_CONTRACTS, axisValue } from '../contracts/games.js';
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

/** A club record as stored: the best completed result of one game and mode (club.md §5-4). */
export interface RecordRow {
  gameId: string;
  paramsKey: string;
  facts: unknown;
  memberId: string;
  nickname: string;
  challengeId: string;
}

/** Strictly lower wins; an equal value keeps the earlier row (candidates arrive oldest first). */
const UPSERT_RECORD = `
  INSERT INTO records
    (game_id, params_key, value, challenge_id, member_id, nickname, facts_json, submitted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (game_id, params_key) DO UPDATE SET
    value = excluded.value, challenge_id = excluded.challenge_id,
    member_id = excluded.member_id, nickname = excluded.nickname,
    facts_json = excluded.facts_json, submitted_at = excluded.submitted_at
  WHERE excluded.value < records.value`;

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

  activeMembers(): MemberRow[] {
    return this.db.all(`SELECT * FROM members WHERE revoked_at IS NULL ORDER BY seq`).map(toMember);
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

  /** Soft delete; the game's records are rebuilt from the challenges that remain live. */
  deleteChallenge(id: string, now: string): void {
    const row = this.db.get(`SELECT game_id FROM challenges WHERE id = ?`, id);
    this.db.run(`UPDATE challenges SET deleted_at = ? WHERE id = ?`, now, id);
    if (row !== undefined) this.rebuildRecords(text(row, 'game_id'));
  }

  // ---------- results ----------

  /** Submission order (club.md §5-3); the client orders by the game's axis. */
  results(challengeId: string, limit: number): ResultRow[] {
    return this.db
      .all(`SELECT * FROM results WHERE challenge_id = ? ORDER BY seq LIMIT ?`, challengeId, limit)
      .map(toResult);
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
    memberId: string;
    nickname: string;
    now: string;
    outcome: Outcome;
    facts: unknown;
  }): ResultRow {
    this.db.run(
      `INSERT INTO results (challenge_id, member_id, nickname, submitted_at, outcome, facts_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      input.challengeId,
      input.memberId,
      input.nickname,
      input.now,
      input.outcome,
      JSON.stringify(input.facts),
    );
    this.db.run(
      `UPDATE challenges SET result_count = result_count + 1 WHERE id = ?`,
      input.challengeId,
    );
    if (input.outcome === 'completed') {
      const challenge = this.db.get(
        `SELECT game_id, params_json FROM challenges WHERE id = ?`,
        input.challengeId,
      );
      if (challenge !== undefined) {
        this.offerRecord({
          gameId: text(challenge, 'game_id'),
          params: parseJson(text(challenge, 'params_json')),
          challengeId: input.challengeId,
          memberId: input.memberId,
          nickname: input.nickname,
          submittedAt: input.now,
          facts: input.facts,
        });
      }
    }
    return {
      challengeId: input.challengeId,
      memberId: input.memberId,
      nickname: input.nickname,
      submittedAt: input.now,
      outcome: input.outcome,
      facts: input.facts,
    };
  }

  // ---------- records ----------

  /** Ordered by game, then mode — the response order of `GET /records`. */
  records(): RecordRow[] {
    return this.db.all(`SELECT * FROM records ORDER BY game_id, params_key`).map((row) => ({
      gameId: text(row, 'game_id'),
      paramsKey: text(row, 'params_key'),
      facts: parseJson(text(row, 'facts_json')),
      memberId: text(row, 'member_id'),
      nickname: text(row, 'nickname'),
      challengeId: text(row, 'challenge_id'),
    }));
  }

  /**
   * Derives the records of one game (or all, with null) from the completed
   * results of live challenges, oldest first, so ties keep the earlier result.
   * The same derivation the table is kept by incrementally in `addResult`.
   */
  rebuildRecords(gameId: string | null): void {
    if (gameId === null) this.db.run(`DELETE FROM records`);
    else this.db.run(`DELETE FROM records WHERE game_id = ?`, gameId);
    const rows =
      gameId === null
        ? this.db.all(COMPLETED_FOR_RECORDS)
        : this.db.all(
            COMPLETED_FOR_RECORDS.replace('ORDER BY', 'AND c.game_id = ? ORDER BY'),
            gameId,
          );
    for (const row of rows) {
      this.offerRecord({
        gameId: text(row, 'game_id'),
        params: parseJson(text(row, 'params_json')),
        challengeId: text(row, 'challenge_id'),
        memberId: text(row, 'member_id'),
        nickname: text(row, 'nickname'),
        submittedAt: text(row, 'submitted_at'),
        facts: parseJson(text(row, 'facts_json')),
      });
    }
  }

  /** A game the server does not know, or facts without the axis, never make a record. */
  private offerRecord(c: {
    gameId: string;
    params: unknown;
    challengeId: string;
    memberId: string;
    nickname: string;
    submittedAt: string;
    facts: unknown;
  }): void {
    const contract = GAME_CONTRACTS[c.gameId];
    if (contract === undefined) return;
    const paramsKey = contract.paramsKey(c.params);
    const value = axisValue(contract, c.facts);
    if (paramsKey === null || value === null) return;
    this.db.run(
      UPSERT_RECORD,
      c.gameId,
      paramsKey,
      value,
      c.challengeId,
      c.memberId,
      c.nickname,
      JSON.stringify(c.facts),
      c.submittedAt,
    );
  }
}

const COMPLETED_FOR_RECORDS = `
  SELECT r.challenge_id, r.member_id, r.nickname, r.submitted_at, r.facts_json,
         c.game_id, c.params_json
  FROM results r
  JOIN challenges c ON c.id = r.challenge_id
  WHERE r.outcome = 'completed' AND c.deleted_at IS NULL
  ORDER BY r.seq`;
