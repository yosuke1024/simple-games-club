import type { Row, SqlDriver } from '../db/driver.js';
import type { ClubSettings } from '../db/policy.js';

export interface ManagedOwner {
  id: string;
  reference: string;
  plan: 'basic';
  validUntil: string;
  tokenHash: string;
  createdAt: string;
  credentialVersion: number;
}

export interface ManagedClub extends ClubSettings {
  id: string;
  ownerId: string;
  clientId: string;
  name: string;
  nickname: string;
  createdAt: string;
  memberCount: number;
  status: 'provisioning' | 'ready';
}

/** The directory is metadata only; scores and member credentials stay in each club. */
export const MANAGED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS managed_owners (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL CHECK (plan = 'basic'),
  valid_until TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS managed_clubs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES managed_owners(id),
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'provisioning',
  visibility TEXT NOT NULL DEFAULT 'private',
  approval_required INTEGER NOT NULL DEFAULT 0,
  allowed_game_ids TEXT,
  listed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_id, client_id)
);
CREATE INDEX IF NOT EXISTS managed_clubs_owner ON managed_clubs(owner_id, seq);
CREATE INDEX IF NOT EXISTS managed_clubs_directory ON managed_clubs(listed, seq);
`;

const ownerOf = (row: Row): ManagedOwner => ({
  id: String(row.id),
  reference: String(row.reference),
  plan: 'basic',
  validUntil: String(row.valid_until),
  tokenHash: String(row.token_hash),
  createdAt: String(row.created_at),
  credentialVersion: Number(row.credential_version),
});

const clubOf = (row: Row): ManagedClub => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  clientId: String(row.client_id),
  name: String(row.name),
  nickname: String(row.nickname),
  createdAt: String(row.created_at),
  memberCount: Number(row.member_count),
  status: row.status === 'ready' ? 'ready' : 'provisioning',
  visibility: row.visibility === 'public' ? 'public' : 'private',
  approvalRequired: row.approval_required === 1,
  allowedGameIds:
    row.allowed_game_ids === null ? null : (JSON.parse(String(row.allowed_game_ids)) as string[]),
});

export class ManagedStore {
  constructor(private readonly db: SqlDriver) {
    db.exec(MANAGED_SCHEMA_SQL);
    // Also safe for a development database made before credential rotation was added.
    if (
      !db
        .all('PRAGMA table_info(managed_owners)')
        .some((column) => column.name === 'credential_version')
    ) {
      db.exec(
        'ALTER TABLE managed_owners ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1',
      );
    }
  }

  owner(id: string): ManagedOwner | null {
    const row = this.db.get('SELECT * FROM managed_owners WHERE id = ?', id);
    return row === undefined ? null : ownerOf(row);
  }

  ownerByToken(hash: string): ManagedOwner | null {
    const row = this.db.get('SELECT * FROM managed_owners WHERE token_hash = ?', hash);
    return row === undefined ? null : ownerOf(row);
  }

  ownerByReference(reference: string): ManagedOwner | null {
    const row = this.db.get('SELECT * FROM managed_owners WHERE reference = ?', reference);
    return row === undefined ? null : ownerOf(row);
  }

  addOwner(owner: ManagedOwner): void {
    this.db.run(
      `INSERT INTO managed_owners (id, reference, plan, valid_until, token_hash, created_at, credential_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      owner.id,
      owner.reference,
      owner.plan,
      owner.validUntil,
      owner.tokenHash,
      owner.createdAt,
      owner.credentialVersion,
    );
  }

  renewOwner(id: string, validUntil: string): void {
    this.db.run('UPDATE managed_owners SET valid_until = ? WHERE id = ?', validUntil, id);
  }

  rotateOwnerToken(id: string, hash: string): ManagedOwner {
    this.db.run(
      'UPDATE managed_owners SET token_hash = ?, credential_version = credential_version + 1 WHERE id = ?',
      hash,
      id,
    );
    return this.owner(id)!;
  }

  club(id: string): ManagedClub | null {
    const row = this.db.get('SELECT * FROM managed_clubs WHERE id = ?', id);
    return row === undefined ? null : clubOf(row);
  }

  clubs(ownerId: string): ManagedClub[] {
    return this.db
      .all('SELECT * FROM managed_clubs WHERE owner_id = ? ORDER BY seq', ownerId)
      .map(clubOf);
  }

  clubByClientId(ownerId: string, clientId: string): ManagedClub | null {
    const row = this.db.get(
      'SELECT * FROM managed_clubs WHERE owner_id = ? AND client_id = ?',
      ownerId,
      clientId,
    );
    return row === undefined ? null : clubOf(row);
  }

  /** Called synchronously with the capacity check, before any remote provisioning awaits. */
  reserveClub(club: ManagedClub): void {
    this.db.run(
      `INSERT INTO managed_clubs (id, owner_id, client_id, name, nickname, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      club.id,
      club.ownerId,
      club.clientId,
      club.name,
      club.nickname,
      club.createdAt,
    );
  }

  /** Hide first when changing settings: a failed sync must never keep a private club listed. */
  hideClub(id: string): void {
    this.db.run('UPDATE managed_clubs SET listed = 0 WHERE id = ?', id);
  }

  syncClub(
    id: string,
    metadata: { name: string; memberCount: number; settings: ClubSettings },
  ): void {
    const { settings } = metadata;
    this.db.run(
      `UPDATE managed_clubs SET name = ?, member_count = ?, status = 'ready',
      visibility = ?, approval_required = ?, allowed_game_ids = ?, listed = ? WHERE id = ?`,
      metadata.name,
      metadata.memberCount,
      settings.visibility,
      settings.approvalRequired ? 1 : 0,
      settings.allowedGameIds === null ? null : JSON.stringify(settings.allowedGameIds),
      settings.visibility === 'public' ? 1 : 0,
      id,
    );
  }

  directory(
    after: string | null,
    now: string,
  ): { clubs: ManagedClub[]; nextCursor: string | null } {
    const cursor =
      after === null
        ? 0
        : Number(this.db.get('SELECT seq FROM managed_clubs WHERE id = ?', after)?.seq ?? 0);
    const rows = this.db.all(
      `SELECT c.* FROM managed_clubs c
      JOIN managed_owners o ON o.id = c.owner_id
      WHERE c.listed = 1 AND c.status = 'ready' AND c.seq > ? AND o.valid_until > ?
      ORDER BY c.seq LIMIT 51`,
      cursor,
      now,
    );
    const clubs = rows.slice(0, 50).map(clubOf);
    return { clubs, nextCursor: rows.length > 50 ? clubs.at(-1)!.id : null };
  }
}
