// Builds the Simple Games web build this server hands invite links to
// (simple-games docs/architecture/club.md §7-1) and puts it in web/, the
// directory both wrangler configurations serve as assets.
//
//   node scripts/build-web.mjs <simple-games checkout> [origin] [--allow-dirty]
//   node scripts/build-web.mjs --check <origin>    (before a deploy: pnpm deploy:*)
//
// origin is the deployment the copy is for (default https://club.pixapps.ai; the
// staging Worker's workers.dev address for wrangler.staging.toml). It becomes the
// build's VITE_MANAGED_CLUB_ORIGIN, so this copy acts on managed invites to its own
// origin whatever the app's MANAGED_CLUBS_ENABLED says.
//
// The copy carries no ads and no analytics: every VITE_ ad and GA variable is set
// empty, and an empty variable outranks any .env file in the checkout. Ad networks
// approve a site, and club.pixapps.ai is not one of pixapps.ai's.
//
// The checkout must be clean unless --allow-dirty, so the commit recorded in
// web/.build-info.json (not served; web/.assetsignore) is what was built.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { URL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
/** Tracked in this repository; everything else in web/ is the previous build. */
const KEEP = new Set(['README.md', '.gitkeep', '.assetsignore']);
/** web-build.yml's build step, all empty: no network is contacted and nothing is measured. */
const BLANK = [
  'VITE_ADSENSE_USE_TEST_ADS',
  'VITE_ADSENSE_CLIENT',
  'VITE_ADSENSE_SLOT_HOME',
  'VITE_ADSENSE_SLOT_RESULT',
  'VITE_ADMAX_SLOT_HOME_728X90',
  'VITE_ADMAX_SLOT_HOME_320X100',
  'VITE_ADMAX_SLOT_RESULT_320X100',
  'VITE_ADMAX_ANCHOR_728X90',
  'VITE_ADMAX_ANCHOR_320X100',
  'VITE_GA_MEASUREMENT_ID',
];

const args = process.argv.slice(2);

// A copy built for staging or a local origin would send its managed invites and
// owner tools there; a deploy checks what web/ was built for first.
if (args[0] === '--check') {
  const expected = args[1];
  const infoFile = join(WEB, '.build-info.json');
  if (!existsSync(infoFile)) {
    throw new Error(`web/ has no build (run pnpm build:web first)`);
  }
  const info = JSON.parse(readFileSync(infoFile, 'utf8'));
  if (info.origin !== expected) {
    throw new Error(`web/ was built for ${info.origin}, not ${expected}`);
  }
  if (info.dirty) throw new Error('web/ was built from uncommitted changes');
  console.log(`web/ holds simple-games ${String(info.commit).slice(0, 12)} for ${expected}`);
  process.exit(0);
}

const allowDirty = args.includes('--allow-dirty');
const [checkoutArg, originArg = 'https://club.pixapps.ai'] = args.filter(
  (a) => a !== '--allow-dirty',
);
if (checkoutArg === undefined) {
  throw new Error(
    'usage: node scripts/build-web.mjs <simple-games checkout> [origin] [--allow-dirty]',
  );
}
const checkout = resolve(checkoutArg);
const app = join(checkout, 'apps', 'simple-games');
if (!existsSync(join(app, 'package.json'))) throw new Error(`${app} is not the Simple Games app`);

// The same rule as the app's managedOrigin (ui/clubFeatures.ts): an exact origin,
// https, or http to the loopback for a local check.
const url = new URL(originArg);
const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
if (
  url.origin !== originArg ||
  !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
) {
  throw new Error(`${originArg} is not an https origin (no path, no trailing slash)`);
}

const git = (...gitArgs) =>
  execFileSync('git', ['-C', checkout, ...gitArgs], { encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain') !== '';
if (dirty && !allowDirty)
  throw new Error(`${checkout} has uncommitted changes (--allow-dirty to build them anyway)`);
const commit = git('rev-parse', 'HEAD');

const env = { ...process.env, VITE_MANAGED_CLUB_ORIGIN: originArg };
for (const name of BLANK) env[name] = '';
execFileSync('pnpm', ['build:web'], { cwd: app, stdio: 'inherit', env });

const dist = join(app, 'dist-web');
if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist}/index.html was not built`);

for (const entry of readdirSync(WEB)) {
  if (!KEEP.has(entry)) rmSync(join(WEB, entry), { recursive: true, force: true });
}
cpSync(dist, WEB, { recursive: true });
writeFileSync(
  join(WEB, '.build-info.json'),
  `${JSON.stringify({ commit, dirty, origin: originArg, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(
  `web/ now holds simple-games ${commit.slice(0, 12)}${dirty ? ' (dirty)' : ''} for ${originArg}`,
);
