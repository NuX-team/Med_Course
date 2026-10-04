import { defineConfig } from 'tsup';

// One self-contained file; see apps/bot/tsup.config.ts.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
});
