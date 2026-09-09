import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // node:sqlite prints an ExperimentalWarning per worker; the warning is
    // noise, the API is the one we chose on purpose (README「Why node:sqlite」).
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
