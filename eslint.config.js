import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The same base rules as simple-games (packages/eslint-config/base.js), inlined
// because this repository is not part of that workspace.
export default tseslint.config(
  { ignores: ['dist/', 'dist-worker/', '.wrangler/', 'node_modules/', 'web/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain-JS scripts run on Node; the TypeScript files get these from @types/node.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', fetch: 'readonly', TextEncoder: 'readonly' },
    },
  },
);
