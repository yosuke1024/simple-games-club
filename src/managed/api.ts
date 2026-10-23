/** Managed contracts, tenancy, and public directory. Identical on Node and Workers. */
import {
  bearerToken,
  hashToken,
  MEMBER_TOKEN_BYTES,
  newId,
  randomToken,
  safeEqual,
} from '../auth/tokens.js';
import type { ApiRequest, ApiResponse } from '../http/api.js';
import { API_VERSION_HEADER, API_VERSION_VALUE } from '../http/api.js';
import { readJsonObject, type JsonObject } from '../http/body.js';
import { corsHeaders } from '../http/cors.js';
import {
  ApiError,
  forbidden,
  invalidRequest,
  notFound,
  rateLimited,
  unauthorized,
} from '../http/errors.js';
import { RateLimiter } from '../http/rateLimit.js';
import { DEFAULT_LIMITS } from '../limits.js';
import * as v from '../validate.js';
import {
  AD_REMOVAL_MEMBERS,
  MANAGED_CLUB_PATH,
  MANAGED_PLANS,
  MANAGED_PREFIX,
  planOf,
  type ManagedPlanId,
} from './plans.js';
import { ManagedStore, type ManagedClub, type ManagedOwner } from './store.js';
import { managedMemberToken, type ManagedTransport } from './tenant.js';

export interface ManagedConfig {
  /** Separate, stable secret for directory token hashes and reconnect credentials. */
  secret: string;
  /** Operator credential, never included in a client build or response. */
  adminKey: string;
  corsOrigins: readonly string[];
}

export interface ManagedApi {
  handle(request: ApiRequest): Promise<ApiResponse>;
}

export const managedConfigFrom = (
  env: {
    CLUB_MANAGED_ENABLED?: string;
    CLUB_MANAGED_SECRET?: string;
    CLUB_MANAGED_ADMIN_KEY?: string;
  },
  corsOrigins: readonly string[],
): ManagedConfig | null => {
  if (env.CLUB_MANAGED_ENABLED !== '1') return null;
  const secret = env.CLUB_MANAGED_SECRET?.trim() ?? '';
  const adminKey = env.CLUB_MANAGED_ADMIN_KEY?.trim() ?? '';
  if (secret.length < 32 || adminKey.length < 32) {
    throw new Error('managed hosting requires separate 32+ character secrets');
  }
  if (secret === adminKey) throw new Error('managed secrets must be different');
  return { secret, adminKey, corsOrigins };
};

const active = (owner: ManagedOwner, now: Date): boolean =>
  owner.validUntil === null || owner.validUntil > now.toISOString();
const ownerShape = (owner: ManagedOwner, now: Date) => ({
  id: owner.id,
  plan: owner.plan,
  validUntil: owner.validUntil,
  status: active(owner, now) ? ('active' as const) : ('expired' as const),
});

const clubShape = (club: ManagedClub, origin: string) => ({
  id: club.id,
  name: club.name,
  endpoint: `${origin}/clubs/${club.id}`,
  createdAt: club.createdAt,
  memberCount: club.memberCount,
  visibility: club.visibility,
  approvalRequired: club.approvalRequired,
  allowedGameIds: club.allowedGameIds,
  status: club.status,
});

const futurePlan = (): ApiError =>
  new ApiError(409, 'plan_unavailable', 'only Trial and Basic are available');
const requireActive = (owner: ManagedOwner, now: Date): void => {
  if (!active(owner, now))
    throw new ApiError(403, 'subscription_inactive', 'the hosting entitlement has expired');
};

function validUntil(plan: ManagedPlanId, value: unknown): string | null {
  if (value === null && plan === 'trial') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw invalidRequest('validUntil must be an ISO date and time');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw invalidRequest('validUntil must be an ISO date and time');
  return date.toISOString();
}

/** Expiry stops new hosting usage, while keeping record access and deletion available. */
function requiresEntitlement(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  return (
    path === '/api/v1/join' ||
    path === '/api/v1/invite' ||
    path === '/api/v1/challenges' ||
    path === '/api/v1/rankings/results' ||
    path === '/api/v1/albums' ||
    /^\/api\/v1\/challenges\/[^/]+\/results$/.test(path) ||
    /^\/api\/v1\/join-requests\/[^/]+\/approve$/.test(path)
  );
}

/** Only membership and owner settings affect discovery; game submissions never fan out. */
function changesDirectory(method: string, path: string): boolean {
  return (
    (method === 'PATCH' && (path === '/api/v1/settings' || path === '/api/v1/club')) ||
    (method === 'POST' &&
      (path === '/api/v1/join' || /^\/api\/v1\/join-requests\/[^/]+\/approve$/.test(path))) ||
    (method === 'DELETE' && /^\/api\/v1\/members\/[^/]+$/.test(path))
  );
}

export function createManagedApi(options: {
  store: ManagedStore;
  config: ManagedConfig;
  transport: ManagedTransport;
}): ManagedApi {
  const { store, config, transport } = options;
  const ownerLimiter = new RateLimiter(60, 60_000);
  const publicLimiter = new RateLimiter(60, 60_000);
  const trialLimiter = new RateLimiter(10, 60_000);
  const clubMutations = new Map<string, Promise<void>>();

  // The directory and a tenant are different databases. Keep each metadata mutation and
  // its acknowledgement together, so a delayed public snapshot cannot republish a club
  // after another request made it private. Ordinary tenant reads and result submissions
  // never take this lock; the explicit owner-benefit refresh shares it with mutations.
  const withClubMutation = async <T>(clubId: string, action: () => Promise<T>): Promise<T> => {
    const previous = clubMutations.get(clubId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    clubMutations.set(clubId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (clubMutations.get(clubId) === current) clubMutations.delete(clubId);
    }
  };

  return {
    async handle(request): Promise<ApiResponse> {
      const origin = new URL(request.origin).origin;
      const headers = {
        [API_VERSION_HEADER]: API_VERSION_VALUE,
        'Cache-Control': 'no-store',
        ...corsHeaders(request.header('origin'), origin, config.corsOrigins),
      };
      const json = (status: number, body: unknown): ApiResponse => ({
        status,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
        body: body === undefined ? null : JSON.stringify(body),
      });
      let bodyRead = false;
      let forwarded = false;
      const body = async (): Promise<JsonObject> => {
        bodyRead = true;
        return readJsonObject(request.body, DEFAULT_LIMITS.bodyBytes);
      };
      const ownerAuth = (): ManagedOwner => {
        const token = bearerToken(request.header('authorization'));
        const owner = token === null ? null : store.ownerByToken(hashToken(config.secret, token));
        if (owner === null) throw unauthorized('a valid owner access key is required');
        if (!ownerLimiter.allow(owner.id, request.now.getTime())) throw rateLimited();
        return owner;
      };
      // An operator may rotate a key while this request awaits a body or another object.
      // Re-read the presented key before handing out any freshly derived member key.
      const ownerAfterAwait = (id: string): ManagedOwner => {
        const token = bearerToken(request.header('authorization'));
        const owner = token === null ? null : store.ownerByToken(hashToken(config.secret, token));
        if (owner === null || owner.id !== id)
          throw unauthorized('the owner access key has been replaced');
        return owner;
      };
      const ownerSpace = async (id: string) => {
        // Directory acknowledgements can be lost after the tenant committed a join or
        // removal. Refresh the bounded set of ready clubs before deciding the benefit,
        // using the same lock as metadata mutations so stale snapshots cannot win.
        for (const club of store.clubs(id)) {
          if (club.status !== 'ready') continue;
          await withClubMutation(club.id, async () => {
            store.syncClub(club.id, await transport.describe(club.id));
          });
          ownerAfterAwait(id);
        }
        const owner = ownerAfterAwait(id);
        const clubs = store.clubs(id);
        const memberCount = clubs.reduce(
          (sum, club) => sum + (club.status === 'ready' ? club.memberCount : 0),
          0,
        );
        const plan = planOf(owner.plan);
        return {
          owner: ownerShape(owner, request.now),
          limits: { maxClubs: plan.maxClubs, maxMembersPerClub: plan.maxMembersPerClub },
          clubs: clubs.map((club) => clubShape(club, origin)),
          benefits: {
            adRemoval: {
              requiredMembers: AD_REMOVAL_MEMBERS,
              memberCount,
              active: active(owner, request.now) && memberCount >= AD_REMOVAL_MEMBERS,
              validUntil: owner.validUntil,
            },
          },
        };
      };
      const adminAuth = (): void => {
        const token = bearerToken(request.header('authorization'));
        if (
          token === null ||
          !safeEqual(hashToken(config.secret, token), hashToken(config.secret, config.adminKey))
        ) {
          throw unauthorized('operator authentication is required');
        }
        if (!ownerLimiter.allow('operator', request.now.getTime())) throw rateLimited();
      };

      try {
        if (request.method === 'OPTIONS') return { status: 204, headers, body: null };
        const path = request.url.pathname;
        const method = request.method;

        // Validate against the registry before ever opening a tenant database. An arbitrary
        // URL cannot allocate a Durable Object or make a SQLite file.
        const tenantPath = MANAGED_CLUB_PATH.exec(path);
        if (tenantPath !== null) {
          const club = store.club(tenantPath[1]!);
          if (club === null || club.status !== 'ready') throw notFound('no such club');
          const holder = store.owner(club.ownerId);
          if (holder === null) throw notFound('no such club');
          const apiPath = '/' + tenantPath[2]!.split('/').filter(Boolean).join('/');
          if (apiPath === '/api/v1/claim')
            throw forbidden('managed clubs are created by their contract holder');
          if (requiresEntitlement(method, apiPath)) requireActive(holder, request.now);
          const sync = changesDirectory(method, apiPath);
          const changesVisibility = method === 'PATCH' && apiPath === '/api/v1/settings';
          const credential = {
            memberToken: managedMemberToken(
              config.secret,
              holder.id,
              club.id,
              holder.credentialVersion,
            ),
            version: holder.credentialVersion,
            maxMembers: planOf(holder.plan).maxMembersPerClub,
          };
          const forward = async (): Promise<ApiResponse> => {
            let hidden = false;
            // Validate before hiding: an unauthenticated PATCH cannot remove a listing.
            // Hide before the remote mutation, so a lost acknowledgement cannot leave a
            // newly private club visible. Retry of the same settings repairs a failed sync.
            if (changesVisibility) {
              const token = bearerToken(request.header('authorization'));
              if (token !== null && (await transport.authorizeOwner(club.id, token, credential))) {
                store.hideClub(club.id);
                hidden = true;
              }
            }
            const url = new URL(request.url);
            url.pathname = apiPath;
            forwarded = true;
            const response = await transport.request(
              club.id,
              {
                ...request,
                url,
                origin: `${origin}/clubs/${club.id}`,
              },
              credential,
            );
            const successful = response.status >= 200 && response.status < 300;
            if (sync && (successful || hidden)) {
              try {
                // A rejected owner edit must restore the unchanged public listing. If the
                // tenant is unreachable, keeping it hidden is the safe retryable outcome.
                store.syncClub(club.id, await transport.describe(club.id));
              } catch (error) {
                if (successful) throw error;
              }
            }
            return { ...response, headers: { ...response.headers, ...headers } };
          };
          return sync ? await withClubMutation(club.id, forward) : await forward();
        }

        if (method === 'GET' && path === `${MANAGED_PREFIX}/plans`) {
          return json(200, { plans: MANAGED_PLANS });
        }
        if (method === 'GET' && path === `${MANAGED_PREFIX}/directory`) {
          if (!publicLimiter.allow(request.clientIp, request.now.getTime())) throw rateLimited();
          const after = request.url.searchParams.get('after');
          if (after !== null && !/^c_[A-Za-z0-9_-]{12}$/.test(after))
            throw invalidRequest('invalid directory cursor');
          const page = store.directory(after, request.now.toISOString());
          return json(200, {
            clubs: page.clubs.map((club) => clubShape(club, origin)),
            nextCursor: page.nextCursor,
          });
        }
        if (method === 'POST' && path === `${MANAGED_PREFIX}/trial`) {
          const token = bearerToken(request.header('authorization'));
          if (token === null || !/^[a-f0-9]{64}$/.test(token)) {
            throw unauthorized('a newly generated 32-byte hexadecimal owner key is required');
          }
          const input = await body();
          if (Object.keys(input).length > 0) throw invalidRequest('the trial body must be empty');
          const tokenHash = hashToken(config.secret, token);
          const existing = store.ownerByToken(tokenHash);
          if (existing !== null) {
            if (!ownerLimiter.allow(existing.id, request.now.getTime())) throw rateLimited();
            return json(200, await ownerSpace(existing.id));
          }
          // Keep an opaque bootstrap reference after rotation. Replaying a revoked key
          // must not recreate a new entitlement or appear to recover the lost clubs.
          const reference = `trial_${tokenHash}`;
          if (store.ownerByReference(reference) !== null)
            throw unauthorized('the owner access key has been replaced');
          if (!trialLimiter.allow(request.clientIp, request.now.getTime())) throw rateLimited();
          const owner: ManagedOwner = {
            id: newId('o'),
            reference,
            plan: 'trial',
            validUntil: null,
            tokenHash,
            createdAt: request.now.toISOString(),
            credentialVersion: 1,
          };
          store.addOwner(owner);
          return json(201, await ownerSpace(owner.id));
        }
        if (method === 'GET' && path === `${MANAGED_PREFIX}/admin/owners`) {
          adminAuth();
          const reference = request.url.searchParams.get('reference');
          if (reference === null || !/^[A-Za-z0-9_-]{1,128}$/.test(reference)) {
            throw invalidRequest('reference must be an opaque billing reference');
          }
          const owner = store.ownerByReference(reference);
          if (owner === null) throw notFound('no such owner');
          return json(200, { owner: ownerShape(owner, request.now) });
        }
        if (method === 'POST' && path === `${MANAGED_PREFIX}/admin/owners`) {
          adminAuth();
          const input = await body();
          if (input.plan !== 'basic' && input.plan !== 'trial') throw futurePlan();
          if (
            typeof input.reference !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(input.reference)
          ) {
            throw invalidRequest('reference must be an opaque billing reference');
          }
          const until = validUntil(input.plan, input.validUntil);
          if (store.ownerByReference(input.reference) !== null) {
            throw new ApiError(409, 'owner_exists', 'this reference already has an owner');
          }
          const ownerToken = randomToken(MEMBER_TOKEN_BYTES);
          const owner: ManagedOwner = {
            id: newId('o'),
            reference: input.reference,
            plan: input.plan,
            validUntil: until,
            tokenHash: hashToken(config.secret, ownerToken),
            createdAt: request.now.toISOString(),
            credentialVersion: 1,
          };
          store.addOwner(owner);
          return json(201, { owner: ownerShape(owner, request.now), ownerToken });
        }
        const adminOwner = new RegExp(
          `^${MANAGED_PREFIX}/admin/owners/(o_[A-Za-z0-9_-]{12})(/rotate-token)?$`,
        ).exec(path);
        if (adminOwner !== null) {
          adminAuth();
          let owner = store.owner(adminOwner[1]!);
          if (owner === null) throw notFound('no such owner');
          if (method === 'PATCH' && adminOwner[2] === undefined) {
            const input = await body();
            owner = store.owner(owner.id)!;
            const plan = input.plan ?? owner.plan;
            if (plan !== 'basic' && plan !== 'trial') throw futurePlan();
            if (owner.plan === 'basic' && plan === 'trial') {
              throw new ApiError(409, 'plan_unavailable', 'downgrading to Trial is not supported');
            }
            const until = validUntil(plan, input.validUntil);
            store.renewOwner(owner.id, until, plan);
            return json(200, {
              owner: ownerShape({ ...owner, plan, validUntil: until }, request.now),
            });
          }
          if (method === 'POST' && adminOwner[2] !== undefined) {
            const ownerToken = randomToken(MEMBER_TOKEN_BYTES);
            const tokenHash = hashToken(config.secret, ownerToken);
            const rotated = store.rotateOwnerToken(owner.id, tokenHash);
            for (const club of store.clubs(owner.id)) {
              if (club.status !== 'ready') continue;
              await withClubMutation(club.id, () =>
                transport.rekeyOwner(club.id, {
                  memberToken: managedMemberToken(
                    config.secret,
                    owner.id,
                    club.id,
                    rotated.credentialVersion,
                  ),
                  version: rotated.credentialVersion,
                  maxMembers: planOf(rotated.plan).maxMembersPerClub,
                }),
              );
            }
            const current = store.owner(owner.id)!;
            if (current.tokenHash !== tokenHash) {
              throw unauthorized('the generated access key has already been replaced');
            }
            return json(200, { owner: ownerShape(current, request.now), ownerToken });
          }
          if (method === 'GET' && adminOwner[2] === undefined) {
            return json(200, { owner: ownerShape(owner, request.now) });
          }
        }
        if (method === 'GET' && path === `${MANAGED_PREFIX}/owner`) {
          const owner = ownerAuth();
          return json(200, await ownerSpace(owner.id));
        }
        if (method === 'POST' && path === `${MANAGED_PREFIX}/clubs`) {
          let owner = ownerAuth();
          requireActive(owner, request.now);
          const input = await body();
          owner = ownerAfterAwait(owner.id);
          requireActive(owner, request.now);
          const name = v.clubName(input.name);
          const nickname = v.nickname(input.nickname);
          if (typeof input.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(input.clientId)) {
            throw invalidRequest('clientId must be an 8..64 character idempotency key');
          }
          let club = store.clubByClientId(owner.id, input.clientId);
          const existing = club !== null;
          if (club === null) {
            if (store.clubs(owner.id).length >= planOf(owner.plan).maxClubs) {
              throw new ApiError(409, 'too_many_clubs', 'the plan club limit has been reached');
            }
            club = {
              id: newId('c'),
              ownerId: owner.id,
              clientId: input.clientId,
              name,
              nickname,
              createdAt: request.now.toISOString(),
              memberCount: 1,
              status: 'provisioning',
              visibility: 'private',
              approvalRequired: false,
              allowedGameIds: null,
            };
            store.reserveClub(club);
          }
          const reserved = club;
          return await withClubMutation(reserved.id, async () => {
            owner = ownerAfterAwait(owner.id);
            requireActive(owner, request.now);
            const memberToken = managedMemberToken(
              config.secret,
              owner.id,
              reserved.id,
              owner.credentialVersion,
            );
            const session = await transport.initialize({
              club: reserved,
              memberToken,
              credentialVersion: owner.credentialVersion,
              maxMembers: planOf(owner.plan).maxMembersPerClub,
            });
            owner = ownerAfterAwait(owner.id);
            requireActive(owner, request.now);
            const metadata = await transport.describe(reserved.id);
            owner = ownerAfterAwait(owner.id);
            requireActive(owner, request.now);
            store.syncClub(reserved.id, metadata);
            return json(existing ? 200 : 201, {
              ...session,
              endpoint: `${origin}/clubs/${reserved.id}`,
            });
          });
        }
        const connect = new RegExp(`^${MANAGED_PREFIX}/clubs/(c_[A-Za-z0-9_-]{12})/connect$`).exec(
          path,
        );
        if (method === 'POST' && connect !== null) {
          let owner = ownerAuth();
          const club = store.club(connect[1]!);
          if (club === null || club.ownerId !== owner.id) throw notFound('no such club');
          return await withClubMutation(club.id, async () => {
            owner = ownerAfterAwait(owner.id);
            const current = store.club(club.id)!;
            if (current.status !== 'ready') requireActive(owner, request.now);
            const credential = {
              memberToken: managedMemberToken(
                config.secret,
                owner.id,
                club.id,
                owner.credentialVersion,
              ),
              version: owner.credentialVersion,
              maxMembers: planOf(owner.plan).maxMembersPerClub,
            };
            // The owner can recover a reserved slot even if the original creation's reply
            // was lost together with the local idempotency key.
            const session =
              current.status === 'ready'
                ? await transport.connect(club.id, credential)
                : await transport.initialize({
                    club: current,
                    memberToken: credential.memberToken,
                    credentialVersion: credential.version,
                    maxMembers: credential.maxMembers,
                  });
            owner = ownerAfterAwait(owner.id);
            if (current.status !== 'ready') {
              requireActive(owner, request.now);
              const metadata = await transport.describe(club.id);
              owner = ownerAfterAwait(owner.id);
              requireActive(owner, request.now);
              store.syncClub(club.id, metadata);
            }
            return json(200, { ...session, endpoint: `${origin}/clubs/${club.id}` });
          });
        }
        throw notFound('no such endpoint');
      } catch (error) {
        if (error instanceof ApiError)
          return json(error.status, { error: { code: error.code, message: error.message } });
        // Do not log bodies or headers: both operator and member credentials travel here.
        console.error('managed club request failed');
        return json(500, { error: { code: 'internal_error', message: 'internal error' } });
      } finally {
        if (!forwarded && !bodyRead && request.method !== 'GET' && request.method !== 'HEAD') {
          let size = 0;
          try {
            for await (const chunk of request.body.chunks()) {
              size += chunk.byteLength;
              if (size > DEFAULT_LIMITS.bodyBytes) break;
            }
          } catch {
            /* A closed connection must not change an already settled response. */
          }
        }
      }
    },
  };
}
