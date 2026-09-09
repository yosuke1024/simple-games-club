/**
 * Entry point: read the environment, open the one database on the volume,
 * listen. `SIGTERM` closes the listener and the database — the platform's
 * redeploy sends exactly that.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';

const config = loadConfig();
const db = openDatabase(join(config.dataDir, 'club.sqlite'));
const app = createApp({ config, db });
const server = createServer(app.handle);

server.listen(config.port, config.host, () => {
  console.log(`simple-games-club listening on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  web: ${config.webDir}`);
  if (app.store.getClub() === null) {
    console.log(
      config.setupKey === null
        ? 'not claimed yet, and CLUB_SETUP_KEY is not set — set it to allow the claim'
        : 'not claimed yet — waiting for POST /api/v1/claim with the setup key',
    );
  }
});

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
