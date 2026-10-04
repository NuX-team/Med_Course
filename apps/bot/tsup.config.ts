import { defineConfig } from 'tsup';

// One self-contained file: workspace packages ship as TypeScript source, so they are
// inlined, and so is everything else. The runtime image needs nothing but Node.
export default defineConfig({
  // `admin.cjs` is the command line for verifying doctors: node admin.cjs list-doctors --by <id>
  entry: { main: 'src/main.ts', admin: 'src/admin/cli.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
});
