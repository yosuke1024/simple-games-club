/**
 * The Node HTTP handler: the static web build on one side, `/api/v1` on the
 * other. The API itself is src/http/api.ts; this file only turns an
 * `IncomingMessage` into an `ApiRequest` — reading the proxy headers the
 * platform sets — and writes the `ApiResponse` back.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { SqlDriver } from './db/driver.js';
import { Store } from './db/store.js';
import { API_VERSION_HEADER, API_VERSION_VALUE, createApi } from './http/api.js';
import type { BodySource } from './http/body.js';
import { serveStatic } from './http/static.js';
import { appLinksBody } from './http/appLinks.js';
import type { Limits } from './limits.js';
import { createNodeManaged } from './managed/node.js';
import { isManagedPath } from './managed/plans.js';

export interface AppOptions {
  config: Config;
  db: SqlDriver;
  /** Injectable clock — tests move it past an owner link's expiry. */
  now?: () => Date;
  limits?: Partial<Limits>;
}

export interface App {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  store: Store;
  close(): void;
}

export function createApp(options: AppOptions): App {
  const { config } = options;
  const store = new Store(options.db);
  const api = createApi({ store, config, limits: options.limits });
  const managed = createNodeManaged(config);
  const clock = options.now ?? (() => new Date());

  const header = (req: IncomingMessage, name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  /** The first hop of X-Forwarded-For behind a trusted proxy, else the socket. */
  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const forwarded = header(req, 'x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /** The origin this server is reached on — for invite URLs and same-origin CORS. */
  const selfOrigin = (req: IncomingMessage): string => {
    if (config.publicOrigin !== null) return config.publicOrigin;
    const forwardedProto = config.trustProxy
      ? header(req, 'x-forwarded-proto')?.split(',')[0]?.trim()
      : undefined;
    const encrypted = 'encrypted' in req.socket && req.socket.encrypted === true;
    const proto = forwardedProto || (encrypted ? 'https' : 'http');
    const host =
      (config.trustProxy ? header(req, 'x-forwarded-host') : undefined) ??
      header(req, 'host') ??
      'localhost';
    const origin = `${proto}://${host}`;
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new TypeError('invalid request origin');
    }
    return origin;
  };

  // Header and transport errors happen outside the shared API's handler guard.
  // Close this connection without echoing untrusted headers or leaving a rejected
  // promise to terminate the Node process. A configured public origin remains
  // authoritative, so unused Host / forwarded values need not parse as origins.
  const fail = (res: ServerResponse, status: 400 | 500): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    res.end(
      JSON.stringify({
        error:
          status === 400
            ? { code: 'invalid_request', message: 'invalid request URL or origin' }
            : { code: 'internal_error', message: 'internal error' },
      }),
    );
  };

  const bodyOf = (req: IncomingMessage): BodySource => ({
    contentLength: header(req, 'content-length'),
    contentType: header(req, 'content-type'),
    async *chunks() {
      for await (const chunk of req) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      }
    },
  });

  const log = (req: IncomingMessage, res: ServerResponse, startedAt: number): void => {
    if (!config.log) return;
    const path = (req.url ?? '/').split('?')[0];
    console.log(`${req.method ?? '-'} ${path} ${res.statusCode} ${Date.now() - startedAt}ms`);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    let origin: string;
    try {
      origin = selfOrigin(req);
    } catch {
      fail(res, 400);
      return;
    }
    const handler = isManagedPath(url.pathname) && managed !== null ? managed.api : api;
    const reply = await handler.handle({
      method: req.method ?? 'GET',
      url,
      header: (name) => header(req, name),
      body: bodyOf(req),
      clientIp: clientIp(req),
      origin,
      now: clock(),
    });
    if (reply.body === null) {
      res.writeHead(reply.status, reply.headers);
      res.end();
      return;
    }
    res.writeHead(reply.status, {
      ...reply.headers,
      'Content-Length': Buffer.byteLength(reply.body),
    });
    res.end(reply.body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const startedAt = Date.now();
    res.setHeader(API_VERSION_HEADER, API_VERSION_VALUE);
    res.once('finish', () => log(req, res, startedAt));
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      fail(res, 400);
      return;
    }

    if (url.pathname.startsWith('/api/') || isManagedPath(url.pathname)) {
      void handleApi(req, res, url).catch(() => {
        if (config.log) console.error('club API request failed');
        fail(res, 500);
      });
      return;
    }
    if (url.pathname.startsWith('/.well-known/')) {
      const body = appLinksBody(url.pathname, config.appLinks);
      res.writeHead(body === null ? 404 : 200, {
        'Content-Type': body === null ? 'text/plain; charset=utf-8' : 'application/json',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(body === null ? 'Not found' : req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (!serveStatic(req, res, url.pathname, { webDir: config.webDir })) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  };

  return { handle, store, close: () => managed?.close() };
}
