/** Durable Object adapters for the shared managed service. No product decisions live here. */
import { DurableObject } from 'cloudflare:workers';
import { migrate } from '../db/driver.js';
import type { ApiRequest, ApiResponse } from '../http/api.js';
import { createManagedApi, managedConfigFrom, type ManagedApi } from '../managed/api.js';
import { ManagedStore } from '../managed/store.js';
import {
  ManagedTenant,
  type ManagedProvision,
  type ManagedSession,
  type ManagedMetadata,
  type ManagedCredential,
} from '../managed/tenant.js';
import { sqlDriver } from './driver.js';
import { apiConfigFrom, settingsFrom, type Env } from './env.js';

const CLIENT_IP_HEADER = 'X-Club-Client-Ip';
const ORIGIN_HEADER = 'X-Club-Origin';
const TEST_NOW_HEADER = 'X-Club-Test-Now';
const CREDENTIAL_HEADER = 'X-Club-Managed-Owner-Key';
const CREDENTIAL_VERSION_HEADER = 'X-Club-Managed-Owner-Version';
const MAX_MEMBERS_HEADER = 'X-Club-Managed-Max-Members';

function apiRequest(request: Request, env: Env): ApiRequest {
  const url = new URL(request.url);
  const settings = settingsFrom(env);
  const given = settings.testMode ? request.headers.get(TEST_NOW_HEADER) : null;
  const date = given === null ? new Date() : new Date(given);
  return {
    method: request.method,
    url,
    header: (name) => request.headers.get(name) ?? undefined,
    clientIp: request.headers.get(CLIENT_IP_HEADER) ?? 'unknown',
    origin: request.headers.get(ORIGIN_HEADER) ?? url.origin,
    now: Number.isFinite(date.getTime()) ? date : new Date(),
    body: {
      contentLength: request.headers.get('content-length') ?? undefined,
      contentType: request.headers.get('content-type') ?? undefined,
      async *chunks() {
        if (request.body === null) return;
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      },
    },
  };
}

function fetchRequest(request: ApiRequest, credential: ManagedCredential): Request {
  const headers = new Headers();
  for (const name of ['authorization', 'origin', 'content-type', 'content-length']) {
    const value = request.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  headers.set(CLIENT_IP_HEADER, request.clientIp);
  headers.set(ORIGIN_HEADER, request.origin);
  headers.set(TEST_NOW_HEADER, request.now.toISOString());
  headers.set(CREDENTIAL_HEADER, credential.memberToken);
  headers.set(CREDENTIAL_VERSION_HEADER, String(credential.version));
  headers.set(MAX_MEMBERS_HEADER, String(credential.maxMembers));
  const iterator = request.body.chunks()[Symbol.asyncIterator]();
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          async cancel() {
            await iterator.return?.();
          },
        });
  return new Request(request.url.toString(), { method: request.method, headers, body });
}

const responseOf = (reply: ApiResponse): Response =>
  new Response(reply.body, { status: reply.status, headers: reply.headers });

export class ManagedDirectoryObject extends DurableObject<Env> {
  private readonly api: ManagedApi;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = managedConfigFrom(env, apiConfigFrom(env, '').corsOrigins);
    if (config === null || env.MANAGED_CLUB === undefined)
      throw new Error('managed hosting is disabled');
    const db = sqlDriver(ctx.storage.sql, { read: 0, written: 0 });
    db.exec('PRAGMA foreign_keys = ON');
    const namespace = env.MANAGED_CLUB;
    const tenant = (id: string) => namespace.get(namespace.idFromName(id));
    this.api = createManagedApi({
      store: new ManagedStore(db),
      config,
      transport: {
        initialize: async (input) => tenant(input.club.id).initialize(input),
        connect: async (id, credential) => tenant(id).connectOwner(credential),
        describe: async (id) => tenant(id).describe(),
        rekeyOwner: async (id, credential) => tenant(id).rekeyOwner(credential),
        authorizeOwner: async (id, token, credential) =>
          tenant(id).authorizeOwner(token, credential),
        request: async (id, request, credential) => {
          const response = await tenant(id).fetch(fetchRequest(request, credential));
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: response.status === 204 ? null : await response.text(),
          };
        },
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    return responseOf(await this.api.handle(apiRequest(request, this.env)));
  }
}

/** This class is only reached through the registry; it is never bound to a public route. */
export class ManagedClubObject extends DurableObject<Env> {
  private readonly tenant: ManagedTenant;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = managedConfigFrom(env, apiConfigFrom(env, '').corsOrigins);
    if (config === null) throw new Error('managed hosting is disabled');
    const db = sqlDriver(ctx.storage.sql, { read: 0, written: 0 });
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    this.tenant = new ManagedTenant(db, apiConfigFrom(env, config.secret));
  }

  initialize(input: ManagedProvision): ManagedSession {
    return this.tenant.initialize(input);
  }
  connectOwner(credential: ManagedCredential): ManagedSession {
    return this.tenant.connect(credential);
  }
  describe(): ManagedMetadata {
    return this.tenant.describe();
  }
  rekeyOwner(credential: ManagedCredential): void {
    this.tenant.rekeyOwner(credential);
  }
  authorizeOwner(token: string, credential: ManagedCredential): boolean {
    return this.tenant.authorizeOwner(token, credential);
  }

  override async fetch(request: Request): Promise<Response> {
    return responseOf(
      await this.tenant.handle(apiRequest(request, this.env), {
        memberToken: request.headers.get(CREDENTIAL_HEADER) ?? '',
        version: Number(request.headers.get(CREDENTIAL_VERSION_HEADER) ?? 0),
        maxMembers: Number(request.headers.get(MAX_MEMBERS_HEADER) ?? 0),
      }),
    );
  }
}
