import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The same base rules as simple-games (packages/eslint-config/base.js), inlined
// because this repository is not part of that workspace.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'web/'] },
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
);
