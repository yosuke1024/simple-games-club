/**
 * Before the Workers project runs: bundle the Worker exactly as a deploy
 * would (`wrangler deploy --dry-run`, which also validates wrangler.toml),
 * and derive the Miniflare options from that same file, so the tests run
 * what gets deployed and no number is written twice.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

export const ROOT = join(import.meta.dirname, '..', '..');
export const OUT_DIR = join(ROOT, 'dist-worker');
export const OPTIONS_FILE = join(OUT_DIR, 'miniflare-options.json');
/** Bundled only to validate it; the tests run the production file, which carries managed too. */
const STAGING_OUT_DIR = join(ROOT, 'dist-worker-staging');
const STAGING_OPTIONS_FILE = join(STAGING_OUT_DIR, 'miniflare-options.json');

export default function setup(): void {
  for (const [config, output, optionsFile] of [
    ['wrangler.toml', OUT_DIR, OPTIONS_FILE],
    ['wrangler.staging.toml', STAGING_OUT_DIR, STAGING_OPTIONS_FILE],
  ] as const) {
    execFileSync(
      join(ROOT, 'node_modules', '.bin', 'wrangler'),
      ['deploy', '--dry-run', '--config', config, '--outdir', output],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    const { workerOptions } = unstable_getMiniflareWorkerOptions(join(ROOT, config));
    // Only what the tests must not restate: the runtime the Worker declares and
    // the object class with its storage backend. Bindings are the tests' own,
    // and assets are the Node static test's concern.
    const { name, compatibilityDate, compatibilityFlags, durableObjects } = workerOptions;
    writeFileSync(
      optionsFile,
      JSON.stringify({ name, compatibilityDate, compatibilityFlags, durableObjects }, null, 2),
    );
  }
}
