/** The Node server for the contract tests: `createApp` on a SQLite file in a temp directory. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { openDatabase, type NodeDatabase } from '../../src/db/database.js';
import { DEFAULTS, apiCaller, newClock, type ServerOptions, type TestServer } from '../helpers.js';

export async function startNodeServer(overrides: Partial<ServerOptions>): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'sg-club-'));
  const clock = newClock();
  let options: ServerOptions = { ...DEFAULTS, ...overrides };
  let db: NodeDatabase | null = null;
  let server: Server | null = null;
  let url = '';

  const listen = async (): Promise<void> => {
    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      webDir: options.webDir ?? join(dir, 'web-missing'),
      setupKey: options.setupKey,
      secret: 'test-secret',
      publicOrigin: options.publicOrigin,
      corsOrigins: options.corsOrigins,
      hosting: options.hosting,
      openJoin: options.openJoin,
      trustProxy: true,
      log: false,
    };
    db = openDatabase(join(dir, 'club.sqlite'));
    const app = createApp({
      config,
      db: db.driver,
      now: () => new Date(clock.now),
      limits: options.limits,
    });
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
    clock,
    api: apiCaller(() => url),
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
