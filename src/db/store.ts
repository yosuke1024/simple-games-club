/**
 * Every SQL statement, behind typed methods. Handlers never see a row.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

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

/** One completed result with what the records derivation needs (club.md §5-4). */
export interface RecordCandidate {
  gameId: string;
  params: unknown;
  challengeId: string;
  memberId: string;
  nickname: string;
  submittedAt: string;
  facts: unknown;
}

type Row = Record<string, SQLOutputValue>;

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
    (SELECT COUNT(*) FROM results r WHERE r.challenge_id = c.id) AS result_count,
    EXISTS (SELECT 1 FROM results r WHERE r.challenge_id = c.id AND r.member_id = ?) AS mine
  FROM challenges c
  JOIN members m ON m.id = c.created_by
  WHERE c.deleted_at IS NULL`;

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  // ---------- club ----------

  getClub(): ClubRow | null {
    const row = this.db.prepare(`SELECT * FROM club LIMIT 1`).get();
    return row === undefined ? null : toClub(row);
  }

  createClub(id: string, name: string, now: string): ClubRow {
    this.db
      .prepare(`INSERT INTO club (id, name, created_at, last_activity_at) VALUES (?, ?, ?, ?)`)
      .run(id, name, now, now);
    return { id, name, createdAt: now, referralUrl: null, lastActivityAt: now };
  }

  renameClub(name: string): void {
    this.db.prepare(`UPDATE club SET name = ?`).run(name);
  }

  setReferralUrl(url: string | null): void {
    this.db.prepare(`UPDATE club SET referral_url = ?`).run(url);
  }

  /** Every write a member makes moves `lastActivityAt` (club.md §5-2 Hosting). */
  touchActivity(now: string): void {
    this.db.prepare(`UPDATE club SET last_activity_at = ?`).run(now);
  }

  // ---------- members ----------

  activeMembers(): MemberRow[] {
    return this.db
      .prepare(`SELECT * FROM members WHERE revoked_at IS NULL ORDER BY seq`)
      .all()
      .map(toMember);
  }

  memberById(id: string): MemberRow | null {
    const row = this.db.prepare(`SELECT * FROM members WHERE id = ?`).get(id);
    return row === undefined ? null : toMember(row);
  }

  /** Active members only — a revoked token is a 401, not a ghost (club.md §5-3). */
  memberByTokenHash(hash: string): MemberRow | null {
    const row = this.db
      .prepare(`SELECT * FROM members WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(hash);
    return row === undefined ? null : toMember(row);
  }

  countActive(role?: Role): number {
    const row =
      role === undefined
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE revoked_at IS NULL`).get()
        : this.db
            .prepare(`SELECT COUNT(*) AS n FROM members WHERE revoked_at IS NULL AND role = ?`)
            .get(role);
    return row === undefined ? 0 : int(row, 'n');
  }

  createMember(
    id: string,
    nickname: string,
    role: Role,
    tokenHash: string,
    now: string,
  ): MemberRow {
    this.db
      .prepare(
        `INSERT INTO members (id, nickname, role, joined_at, token_hash) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, nickname, role, now, tokenHash);
    return { id, nickname, role, joinedAt: now, revokedAt: null };
  }

  revokeMember(id: string, now: string): void {
    this.db.prepare(`UPDATE members SET revoked_at = ? WHERE id = ?`).run(now, id);
  }

  // ---------- setup key ----------

  isSetupKeyUsed(hash: string): boolean {
    return this.db.prepare(`SELECT 1 FROM setup_keys_used WHERE hash = ?`).get(hash) !== undefined;
  }

  markSetupKeyUsed(hash: string, now: string): void {
    this.db.prepare(`INSERT INTO setup_keys_used (hash, used_at) VALUES (?, ?)`).run(hash, now);
  }

  // ---------- invites ----------

  /** The current member invite — the one the owner hands out. */
  memberInvite(): InviteRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM invites WHERE role = 'member' AND revoked_at IS NULL ORDER BY seq DESC`,
      )
      .get();
    return row === undefined ? null : toInvite(row);
  }

  /** Rotates: the previous member invite stops working the moment the new one exists. */
  replaceMemberInvite(id: string, token: string, tokenHash: string, now: string): InviteRow {
    this.db
      .prepare(`UPDATE invites SET revoked_at = ? WHERE role = 'member' AND revoked_at IS NULL`)
      .run(now);
    this.db
      .prepare(
        `INSERT INTO invites (id, role, token, token_hash, created_at) VALUES (?, 'member', ?, ?, ?)`,
      )
      .run(id, token, tokenHash, now);
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
    this.db
      .prepare(
        `INSERT INTO invites (id, role, token_hash, created_at, expires_at) VALUES (?, 'owner', ?, ?, ?)`,
      )
      .run(id, tokenHash, now, expiresAt);
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
    const row = this.db.prepare(`SELECT * FROM invites WHERE token_hash = ?`).get(hash);
    return row === undefined ? null : toInvite(row);
  }

  markInviteUsed(id: string, now: string): void {
    this.db.prepare(`UPDATE invites SET used_at = ? WHERE id = ?`).run(now, id);
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
    createdBy: string;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO challenges
           (id, game_id, contract_version, params_json, seed, board_digest, title, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.gameId,
        input.contractVersion,
        JSON.stringify(input.params),
        input.seed,
        input.boardDigest,
        input.title,
        input.createdBy,
        input.now,
      );
  }

  challengeById(id: string, viewerId: string): ChallengeRow | null {
    const row = this.db.prepare(`${CHALLENGE_SELECT} AND c.id = ?`).get(viewerId, id);
    return row === undefined ? null : toChallenge(row);
  }

  /** Newest first; `afterId` continues past that challenge (club.md §5-3). */
  listChallenges(viewerId: string, afterId: string | null, limit: number): ChallengeRow[] {
    const rows =
      afterId === null
        ? this.db.prepare(`${CHALLENGE_SELECT} ORDER BY c.seq DESC LIMIT ?`).all(viewerId, limit)
        : this.db
            .prepare(
              `${CHALLENGE_SELECT}
                 AND c.seq < (SELECT seq FROM challenges WHERE id = ?)
               ORDER BY c.seq DESC LIMIT ?`,
            )
            .all(viewerId, afterId, limit);
    return rows.map(toChallenge);
  }

  deleteChallenge(id: string, now: string): void {
    this.db.prepare(`UPDATE challenges SET deleted_at = ? WHERE id = ?`).run(now, id);
  }

  // ---------- results ----------

  /** Submission order (club.md §5-3); the client orders by the game's axis. */
  results(challengeId: string, limit: number): ResultRow[] {
    return this.db
      .prepare(`SELECT * FROM results WHERE challenge_id = ? ORDER BY seq LIMIT ?`)
      .all(challengeId, limit)
      .map(toResult);
  }

  hasResult(challengeId: string, memberId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM results WHERE challenge_id = ? AND member_id = ?`)
        .get(challengeId, memberId) !== undefined
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
    this.db
      .prepare(
        `INSERT INTO results (challenge_id, member_id, nickname, submitted_at, outcome, facts_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.challengeId,
        input.memberId,
        input.nickname,
        input.now,
        input.outcome,
        JSON.stringify(input.facts),
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

  /** Every completed result on a live challenge, oldest first — the records input. */
  completedResultsForRecords(): RecordCandidate[] {
    return this.db
      .prepare(
        `SELECT r.challenge_id, r.member_id, r.nickname, r.submitted_at, r.facts_json,
                c.game_id, c.params_json
         FROM results r
         JOIN challenges c ON c.id = r.challenge_id
         WHERE r.outcome = 'completed' AND c.deleted_at IS NULL
         ORDER BY r.seq`,
      )
      .all()
      .map((row) => ({
        gameId: text(row, 'game_id'),
        params: parseJson(text(row, 'params_json')),
        challengeId: text(row, 'challenge_id'),
        memberId: text(row, 'member_id'),
        nickname: text(row, 'nickname'),
        submittedAt: text(row, 'submitted_at'),
        facts: parseJson(text(row, 'facts_json')),
      }));
  }
}
