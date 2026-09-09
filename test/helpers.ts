/**
 * A real server on a random port, per test. Nothing is mocked: requests go
 * over HTTP, rows go into a SQLite file in a temp directory, and the clock
 * is the one injectable — so a test can walk past an owner link's expiry.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import type { Config, HostingConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import type { Limits } from '../src/limits.js';

export const SETUP_KEY = 'test-setup-key-0123456789abcdef';
export const START = new Date('2026-09-09T09:00:00.000Z');

export interface RequestInit_ {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw body: skips JSON encoding (for the size and content-type tests). */
  raw?: string;
}

export interface Reply {
  status: number;
  headers: Headers;
  // Contract tests read arbitrary JSON; the shape is what each test asserts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
}

export interface TestServer {
  url: string;
  dir: string;
  config: Config;
  clock: { now: Date; advance(ms: number): void };
  api(path: string, init?: RequestInit_): Promise<Reply>;
  /** Restarts the server on the same database, optionally with new env-like settings. */
  reopen(overrides?: Partial<ServerOptions>): Promise<void>;
  close(): Promise<void>;
}

export interface ServerOptions {
  setupKey: string | null;
  limits: Partial<Limits>;
  webDir: string | null;
  publicOrigin: string | null;
  corsOrigins: string[];
  hosting: HostingConfig;
}

const DEFAULTS: ServerOptions = {
  setupKey: SETUP_KEY,
  limits: {},
  webDir: null,
  publicOrigin: null,
  corsOrigins: [],
  hosting: { provider: null, manageUrl: null },
};

export async function startServer(overrides: Partial<ServerOptions> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'sg-club-'));
  const clock = {
    now: new Date(START),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  let options: ServerOptions = { ...DEFAULTS, ...overrides };
  let db: DatabaseSync | null = null;
  let server: Server | null = null;
  let config: Config | null = null;
  let url = '';

  const listen = async (): Promise<void> => {
    config = {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      webDir: options.webDir ?? join(dir, 'web-missing'),
      setupKey: options.setupKey,
      secret: 'test-secret',
      publicOrigin: options.publicOrigin,
      corsOrigins: options.corsOrigins,
      hosting: options.hosting,
      trustProxy: true,
      log: false,
    };
    db = openDatabase(join(dir, 'club.sqlite'));
    const app = createApp({ config, db, now: () => new Date(clock.now), limits: options.limits });
    server = createServer(app.handle);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}`;
  };

  const stop = async (): Promise<void> => {
    if (server !== null) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve, reject) =>
        closing.close((error) => (error ? reject(error) : resolve())),
      );
    }
    db?.close();
    db = null;
  };

  await listen();

  return {
    get url() {
      return url;
    },
    dir,
    get config() {
      return config!;
    },
    clock,
    async api(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
      let body: string | undefined;
      if (init.raw !== undefined) {
        body = init.raw;
      } else if (init.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.body);
      }
      const response = await fetch(`${url}${path}`, {
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
      });
      const text = await response.text();
      const isJson = (response.headers.get('content-type') ?? '').startsWith('application/json');
      return {
        status: response.status,
        headers: response.headers,
        json: isJson && text !== '' ? JSON.parse(text) : null,
        text,
      };
    },
    async reopen(next = {}) {
      await stop();
      options = { ...options, ...next };
      await listen();
    },
    async close() {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  token: string;
  memberId: string;
  clubId: string;
}

/** `POST /claim` with the test setup key — the first owner. */
export async function claimOwner(server: TestServer, nickname = 'Yoh'): Promise<Session> {
  const reply = await server.api('/api/v1/claim', { body: { setupKey: SETUP_KEY, nickname } });
  if (reply.status !== 201) throw new Error(`claim failed: ${reply.status} ${reply.text}`);
  return {
    token: reply.json.memberToken,
    memberId: reply.json.member.id,
    clubId: reply.json.club.id,
  };
}

/** Joins through the current member invite. */
export async function joinMember(
  server: TestServer,
  owner: Session,
  nickname = 'Ken',
  ip = '203.0.113.10',
): Promise<Session> {
  const invite = await server.api('/api/v1/invite', { token: owner.token });
  if (invite.status !== 200) throw new Error(`invite failed: ${invite.status} ${invite.text}`);
  const reply = await server.api('/api/v1/join', {
    body: { inviteToken: invite.json.token, nickname },
    headers: { 'X-Forwarded-For': ip },
  });
  if (reply.status !== 201) throw new Error(`join failed: ${reply.status} ${reply.text}`);
  return {
    token: reply.json.memberToken,
    memberId: reply.json.member.id,
    clubId: reply.json.club.id,
  };
}
