import { defineConfig } from 'vitest/config';

// node:sqlite prints an ExperimentalWarning per worker; the warning is noise,
// the API is the one we chose on purpose (README「Why node:sqlite」).
const execArgv = ['--disable-warning=ExperimentalWarning'];

// The same contract tests run against both deployments (club.md §5: "the same"
// means the same tests, not shared code). `test/helpers.ts` starts whichever
// `CLUB_IMPL` names. Two files are Node's alone: the static file server
// (Workers serve the build from the assets binding), the Node unit tests and
// the migration test (it opens a node:sqlite file by hand).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          env: { CLUB_IMPL: 'node' },
          execArgv,
        },
      },
      {
        test: {
          name: 'workers',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/static.test.ts', 'test/units.test.ts', 'test/migrate.test.ts'],
          env: { CLUB_IMPL: 'workers' },
          globalSetup: ['test/workers/globalSetup.ts'],
          execArgv,
        },
      },
    ],
  },
});
