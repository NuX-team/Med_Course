import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfigFromProcess } from '@medcourse/config';
import { runBackupCommand } from './ops';

/**
 * pnpm db:backup <directory> [--keep <n>]   write an encrypted backup, keep the newest n files
 * pnpm db:restore <file>                     restore into the (empty) database of DATABASE_URL
 * pnpm db:restore-drill <file>               restore into a scratch database, check it, drop it
 *
 * The same commands, on a server, are `node ops.cjs backup | restore | drill` (apps/bot/src/ops).
 * The drill is the proof that a backup is worth having (TZ §12, §18.1): it needs a connection
 * that may create a database, the BACKUP_KEY the file was sealed with, and the ENCRYPTION_KEYS
 * of the data in it, and it says plainly whether all three still fit together.
 */

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfigFromProcess({ defaultHttpPort: 3000, receivesUpdates: false });
  } catch (error) {
    if (error instanceof ConfigError) {
      print(error.message);
      return 1;
    }
    throw error;
  }
  const [command, ...rest] = process.argv.slice(2);
  return runBackupCommand(command === undefined ? [] : [command, ...rest], {
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
    // The message only: a driver error can carry the connection string.
    print(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  },
);
