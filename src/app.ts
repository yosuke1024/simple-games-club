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
import type { Limits } from './limits.js';

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
}

export function createApp(options: AppOptions): App {
  const { config } = options;
  const store = new Store(options.db);
  const api = createApi({ store, config, limits: options.limits });
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
    return `${proto}://${host}`;
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
    const reply = await api.handle({
      method: req.method ?? 'GET',
      url,
      header: (name) => header(req, name),
      body: bodyOf(req),
      clientIp: clientIp(req),
      origin: selfOrigin(req),
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
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.once('finish', () => log(req, res, startedAt));

    if (url.pathname.startsWith('/api/')) {
      void handleApi(req, res, url);
      return;
    }
    if (!serveStatic(req, res, url.pathname, { webDir: config.webDir })) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  };

  return { handle, store };
}
