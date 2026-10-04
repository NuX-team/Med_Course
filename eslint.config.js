import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Generated data (the report's fonts) and the one-off script that generates it.
      '**/*.generated.ts',
      'packages/report/scripts/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `const { omitted, ...rest } = row` is how a field is dropped; `_x` marks a deliberate skip.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Configuration is read once, validated, and passed down (packages/config).
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read the environment only in packages/config; take a Config instead.',
        },
      ],
    },
  },

  // The one legitimate reader, and test gating on an optional integration database.
  {
    files: [
      'packages/config/src/**',
      '**/*.test.ts',
      'packages/db/test/**',
      'packages/db/src/dev-db.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },

  // Root-level tooling files are outside every tsconfig.
  {
    files: ['*.js', '*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
