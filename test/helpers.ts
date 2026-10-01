/**
 * A real server on a random port, per test, for whichever deployment
 * `CLUB_IMPL` names (vitest.config.ts): the Node process (test/impl/node.ts)
 * or the Worker and its Durable Object in workerd (test/impl/workers.ts).
 * Nothing is mocked: requests go over HTTP and rows go into SQLite. The
 * clock is the one injectable, so a test can walk past an owner link's expiry.
 */
import type { HostingConfig } from '../src/api/deps.js';
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

export interface Clock {
  now: Date;
  advance(ms: number): void;
}

export interface TestServer {
  url: string;
  clock: Clock;
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

export const DEFAULTS: ServerOptions = {
  setupKey: SETUP_KEY,
  limits: {},
  webDir: null,
  publicOrigin: null,
  corsOrigins: [],
  hosting: { provider: null, manageUrl: null },
};

export const newClock = (): Clock => ({
  now: new Date(START),
  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms);
  },
});

/** The `api()` of a TestServer: JSON in, status + headers + parsed JSON out. */
export const apiCaller =
  (url: () => string, extraHeaders: () => Record<string, string> = () => ({})) =>
  async (path: string, init: RequestInit_ = {}): Promise<Reply> => {
    const headers: Record<string, string> = { ...extraHeaders(), ...init.headers };
    if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
    let body: string | undefined;
    if (init.raw !== undefined) {
      body = init.raw;
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const response = await fetch(`${url()}${path}`, {
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
  };

export async function startServer(overrides: Partial<ServerOptions> = {}): Promise<TestServer> {
  if (process.env.CLUB_IMPL === 'workers') {
    const { startWorkersServer } = await import('./impl/workers.js');
    return startWorkersServer(overrides);
  }
  const { startNodeServer } = await import('./impl/node.js');
  return startNodeServer(overrides);
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
