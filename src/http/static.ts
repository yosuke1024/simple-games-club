/**
 * Serving the Simple Games web build (club.md §7-1): `index.html` at `/` and
 * at `/join`, `/join/` redirected to `/join` (the build's relative `base`
 * would otherwise resolve its assets one directory too deep), everything
 * else as files. Without a build installed, `/` says so in one sentence
 * instead of a 404 — the API is up either way.
 */
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { PLACEHOLDER_HTML } from './placeholder.js';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

export interface StaticOptions {
  webDir: string;
}

/** Handles the request when it is for the web build; returns false to let the API try. */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: StaticOptions,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (pathname === '/join/') {
    res.writeHead(301, { Location: '/join' });
    res.end();
    return true;
  }

  const wantsIndex = pathname === '/' || pathname === '/index.html' || pathname === '/join';
  const relative = wantsIndex ? 'index.html' : safeRelative(pathname);
  if (relative === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }

  const root = resolve(options.webDir);
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }

  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    if (wantsIndex) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : PLACEHOLDER_HTML);
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // Vite names hashed assets, so they can be cached forever; the entry page
  // must not be, or a redeploy keeps serving the previous build's index.
  const cache = relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': cache });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

/** A URL path as a relative file path, or null when it cannot be one. */
function safeRelative(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}
