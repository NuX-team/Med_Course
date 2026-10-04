import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfigFromProcess } from '@medcourse/config';
import { runMigrateCommand } from './ops';

/**
 * pnpm db:migrate | pnpm db:rollback [steps] | pnpm db:status
 *
 * Not part of the app bundles: it reads the .sql files next to the sources. On a server the same
 * commands are `node ops.cjs migrate up | status` (apps/bot/src/ops), with the files in the image.
 */

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfigFromProcess({ defaultHttpPort: 3000 });
  } catch (error) {
    if (error instanceof ConfigError) {
      print(error.message);
      return 1;
    }
    throw error;
  }
  return runMigrateCommand(process.argv.slice(2), {
    config,
    migrationsDirectory: fileURLToPath(new URL('../migrations', import.meta.url)),
    out: print,
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
