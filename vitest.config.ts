import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Needs a real Postgres: DATABASE_URL if set (CI), otherwise a throwaway embedded one.
        test: {
          name: 'db',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.db.test.ts'],
          globalSetup: ['packages/db/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
