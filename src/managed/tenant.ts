/** A managed tenant runs the ordinary club API, on either SQLite implementation. */
import { createHmac } from 'node:crypto';
import type { ApiConfig } from '../api/deps.js';
import { clubShape, memberShape } from '../api/shape.js';
import { hashToken, INVITE_TOKEN_BYTES, newId, randomToken } from '../auth/tokens.js';
import type { SqlDriver } from '../db/driver.js';
import { Store } from '../db/store.js';
import { createApi, type Api, type ApiRequest, type ApiResponse } from '../http/api.js';
import { forbidden, notFound, unauthorized } from '../http/errors.js';
import type { ClubSettings } from '../db/policy.js';
import type { ManagedClub } from './store.js';
import { BASIC_PLAN } from './plans.js';

export interface ManagedProvision {
  club: ManagedClub;
  memberToken: string;
  credentialVersion: number;
}

/** Trusted registry-to-tenant metadata; never accepted from a public request. */
export interface ManagedCredential {
  memberToken: string;
  version: number;
}

export interface ManagedSession {
  club: ReturnType<typeof clubShape>;
  member: ReturnType<typeof memberShape>;
  memberToken: string;
}

export interface ManagedMetadata {
  name: string;
  memberCount: number;
  settings: ClubSettings;
}

export interface ManagedTransport {
  initialize(input: ManagedProvision): Promise<ManagedSession>;
  connect(clubId: string, credential: ManagedCredential): Promise<ManagedSession>;
  describe(clubId: string): Promise<ManagedMetadata>;
  rekeyOwner(clubId: string, credential: ManagedCredential): Promise<void>;
  authorizeOwner(clubId: string, token: string, credential: ManagedCredential): Promise<boolean>;
  request(clubId: string, request: ApiRequest, credential: ManagedCredential): Promise<ApiResponse>;
}

/** Reconnect without retaining a plaintext member credential in the directory database. */
export const managedMemberToken = (
  secret: string,
  ownerId: string,
  clubId: string,
  version: number,
): string =>
  createHmac('sha256', secret)
    .update(`managed-member-v1:${ownerId}:${clubId}:${version}`)
    .digest('base64url');

export class ManagedTenant {
  private readonly store: Store;
  private readonly config: ApiConfig;
  private readonly api: Api;

  constructor(
    private readonly db: SqlDriver,
    config: ApiConfig,
  ) {
    this.store = new Store(db);
    const holder = db.get("SELECT value FROM meta WHERE key = 'managed_owner_member'");
    this.config = {
      ...config,
      setupKey: null,
      openJoin: false,
      managed: true,
      hosting: { provider: 'managed', manageUrl: null },
      managedOwnerMemberId: holder === undefined ? undefined : String(holder.value),
    };
    this.api = this.makeApi();
  }

  private makeApi(): Api {
    return createApi({
      store: this.store,
      config: this.config,
      limits: { maxMembers: BASIC_PLAN.maxMembersPerClub },
    });
  }

  initialize(input: ManagedProvision): ManagedSession {
    const { club, memberToken, credentialVersion } = input;
    const current = this.store.getClub();
    if (current !== null && current.id !== club.id) throw forbidden('tenant does not match');
    if (current === null) this.store.createClub(club.id, club.name, club.createdAt);
    // Every step is idempotent, including retry after a response was lost half way through.
    if (this.store.memberInvite() === null) {
      const invite = randomToken(INVITE_TOKEN_BYTES);
      this.store.replaceMemberInvite(
        newId('inv'),
        invite,
        hashToken(this.config.secret, invite),
        club.createdAt,
      );
    }
    // Reserve the holder identity before creating the member. A crash followed by a
    // credential rotation can then finish the same member, never create a second owner.
    if (this.config.managedOwnerMemberId === undefined) {
      const existing = this.store.memberByTokenHash(hashToken(this.config.secret, memberToken));
      const id = existing?.role === 'owner' ? existing.id : newId('m');
      this.db.run(
        "INSERT INTO meta (key, value) VALUES ('managed_owner_member', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        id,
      );
      this.config.managedOwnerMemberId = id;
    }
    let member = this.store.memberById(this.config.managedOwnerMemberId);
    if (member === null) {
      member = this.store.createMember(
        this.config.managedOwnerMemberId,
        club.nickname,
        'owner',
        hashToken(this.config.secret, memberToken),
        club.createdAt,
      );
    } else {
      this.rekeyOwner({ memberToken, version: credentialVersion });
    }
    this.db.run(
      "INSERT INTO meta (key, value) VALUES ('managed_owner_credential_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(credentialVersion),
    );
    return { club: clubShape(this.store.getClub()!), member: memberShape(member), memberToken };
  }

  connect(credential: ManagedCredential): ManagedSession {
    this.rekeyOwner(credential);
    const { memberToken } = credential;
    const club = this.store.getClub();
    const member = this.store.memberByTokenHash(hashToken(this.config.secret, memberToken));
    if (club === null || member === null || member.id !== this.config.managedOwnerMemberId) {
      throw notFound('managed club owner is unavailable');
    }
    return { club: clubShape(club), member: memberShape(member), memberToken };
  }

  describe(): ManagedMetadata {
    const club = this.store.getClub();
    if (club === null) throw notFound('club has not been provisioned');
    return {
      name: club.name,
      memberCount: this.store.countActive(),
      settings: this.store.policy.settings(false),
    };
  }

  /**
   * Monotonic versions stop an in-flight old reconnect from restoring a revoked key.
   * Updating the hash before its version makes interrupted rotation retryable: an old
   * same-version credential never overwrites a different hash, while the newer one can
   * finish the two writes. Member identity, records, and ordinary member tokens stay put.
   */
  private ensureOwnerCredential(credential: ManagedCredential): boolean {
    const id = this.config.managedOwnerMemberId;
    if (id === undefined) throw notFound('managed club owner is unavailable');
    if (!Number.isSafeInteger(credential.version) || credential.version < 1) {
      throw unauthorized('invalid managed credential version');
    }
    const version = Number(
      this.db.get("SELECT value FROM meta WHERE key = 'managed_owner_credential_version'")?.value ??
        0,
    );
    if (credential.version < version) return false;
    const member = this.db.get('SELECT token_hash, revoked_at FROM members WHERE id = ?', id);
    if (member === undefined || member.revoked_at !== null)
      throw notFound('managed club owner is unavailable');
    const hash = hashToken(this.config.secret, credential.memberToken);
    if (credential.version === version) return member.token_hash === hash;
    this.db.run('UPDATE members SET token_hash = ? WHERE id = ?', hash, id);
    this.db.run(
      "INSERT INTO meta (key, value) VALUES ('managed_owner_credential_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(credential.version),
    );
    return true;
  }

  rekeyOwner(credential: ManagedCredential): void {
    if (!this.ensureOwnerCredential(credential))
      throw unauthorized('the owner credential has been replaced');
  }

  authorizeOwner(token: string, credential: ManagedCredential): boolean {
    this.ensureOwnerCredential(credential);
    return this.store.memberByTokenHash(hashToken(this.config.secret, token))?.role === 'owner';
  }

  handle(request: ApiRequest, credential: ManagedCredential): Promise<ApiResponse> {
    // Every registry-forwarded request carries the current credential. A partially failed
    // operator rotation therefore cannot leave an old owner key usable in another club.
    // If a request raced a newer rotation, keep the newer hash and let normal auth decide.
    this.ensureOwnerCredential(credential);
    return this.api.handle(request);
  }
}
