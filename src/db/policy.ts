import type { Row, SqlDriver } from './driver.js';

export interface ClubSettings {
  visibility: 'public' | 'private';
  approvalRequired: boolean;
  /** null means every supported game, including games added later; [] means none. */
  allowedGameIds: string[] | null;
}

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface JoinRequestRow {
  id: string;
  nickname: string;
  tokenHash: string;
  memberId: string;
  status: JoinRequestStatus;
  createdAt: string;
  expiresAt: string;
}

export const JOIN_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_REQUESTS = 100;
const MAX_DECIDED_REQUESTS = 200;

const requestRow = (row: Row): JoinRequestRow => ({
  id: String(row.id),
  nickname: String(row.nickname),
  tokenHash: String(row.token_hash),
  memberId: String(row.member_id),
  status: String(row.status) as JoinRequestStatus,
  createdAt: String(row.created_at),
  expiresAt: String(row.expires_at),
});

export class PolicyStore {
  constructor(private readonly db: SqlDriver) {}

  /** An old club inherits its deployment's joining rule until an owner saves settings. */
  settings(defaultOpenJoin: boolean): ClubSettings {
    const row = this.db.get(`SELECT * FROM club_settings WHERE singleton = 1`);
    if (row === undefined) {
      return {
        visibility: defaultOpenJoin ? 'public' : 'private',
        approvalRequired: false,
        allowedGameIds: null,
      };
    }
    return {
      visibility: String(row.visibility) as ClubSettings['visibility'],
      approvalRequired: Number(row.approval_required) === 1,
      allowedGameIds:
        row.allowed_game_ids_json === null
          ? null
          : (JSON.parse(String(row.allowed_game_ids_json)) as string[]),
    };
  }

  saveSettings(settings: ClubSettings): void {
    this.db.run(
      `INSERT INTO club_settings (singleton, visibility, approval_required, allowed_game_ids_json)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         visibility = excluded.visibility,
         approval_required = excluded.approval_required,
         allowed_game_ids_json = excluded.allowed_game_ids_json`,
      settings.visibility,
      settings.approvalRequired ? 1 : 0,
      settings.allowedGameIds === null ? null : JSON.stringify(settings.allowedGameIds),
    );
  }

  /** Expiry is applied on a request, never by a timer or background job. */
  pruneRequests(now: string): void {
    this.db.run(
      `UPDATE join_requests SET status = 'expired', decided_at = expires_at
       WHERE status = 'pending' AND expires_at <= ?`,
      now,
    );
    const before = new Date(new Date(now).getTime() - JOIN_REQUEST_TTL_MS).toISOString();
    this.db.run(
      `DELETE FROM join_requests WHERE status <> 'pending' AND
         (decided_at <= ? OR seq NOT IN
           (SELECT seq FROM join_requests WHERE status <> 'pending' ORDER BY seq DESC LIMIT ?))`,
      before,
      MAX_DECIDED_REQUESTS,
    );
  }

  createRequest(request: JoinRequestRow): boolean {
    // Admission is bounded even under simultaneous requests. The pending row never appears
    // in members and its credential cannot authenticate until an owner approves it.
    this.db.run(
      `INSERT INTO join_requests
        (id, nickname, token_hash, member_id, status, created_at, expires_at)
       SELECT ?, ?, ?, ?, 'pending', ?, ?
       WHERE (SELECT COUNT(*) FROM join_requests WHERE status = 'pending') < ?`,
      request.id,
      request.nickname,
      request.tokenHash,
      request.memberId,
      request.createdAt,
      request.expiresAt,
      MAX_PENDING_REQUESTS,
    );
    return this.requestById(request.id) !== null;
  }

  requestById(id: string): JoinRequestRow | null {
    const row = this.db.get(`SELECT * FROM join_requests WHERE id = ?`, id);
    return row === undefined ? null : requestRow(row);
  }

  requestByTokenHash(hash: string): JoinRequestRow | null {
    const row = this.db.get(`SELECT * FROM join_requests WHERE token_hash = ?`, hash);
    return row === undefined ? null : requestRow(row);
  }

  pendingRequests(): JoinRequestRow[] {
    return this.db
      .all(
        `SELECT * FROM join_requests WHERE status = 'pending' ORDER BY seq LIMIT ?`,
        MAX_PENDING_REQUESTS,
      )
      .map(requestRow);
  }

  decideRequest(id: string, status: 'rejected' | 'cancelled', now: string): void {
    this.db.run(
      `UPDATE join_requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
      status,
      now,
      id,
    );
  }

  approveRequest(request: JoinRequestRow, now: string, maxMembers: number): boolean {
    // A single conditional INSERT owns the last seat. The reserved member id also makes an
    // approval retry safe if a process stopped between this INSERT and the status update.
    this.db.run(
      `INSERT OR IGNORE INTO members (id, nickname, role, joined_at, token_hash)
       SELECT member_id, nickname, 'member', ?, token_hash FROM join_requests
       WHERE id = ? AND status = 'pending' AND expires_at > ?
         AND (SELECT COUNT(*) FROM members WHERE revoked_at IS NULL) < ?`,
      now,
      request.id,
      now,
      maxMembers,
    );
    const member = this.db.get(`SELECT id FROM members WHERE id = ?`, request.memberId);
    if (member === undefined) return false;
    this.db.run(
      `UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'`,
      now,
      request.id,
    );
    return true;
  }
}
