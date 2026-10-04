import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfigFromProcess } from '@medcourse/config';
import { createDatabase } from './index';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate';

/**
 * pnpm db:migrate | pnpm db:rollback [steps] | pnpm db:status
 *
 * Not part of the app bundles: it reads the .sql files next to the sources. Shipping
 * migrations with a deployment is a stage 14/15 concern.
 */

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const [command = 'status', argument] = process.argv.slice(2);

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

  const migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
  const db = createDatabase(config.databaseUrl, { maxConnections: 1 });

  try {
    switch (command) {
      case 'up': {
        const applied = await migrateUp(db.sql, migrations);
        print(applied.length === 0 ? 'nothing to apply' : `applied: ${applied.join(', ')}`);
        return 0;
      }
      case 'down': {
        if (config.isProduction) {
          print('refusing to roll back with APP_ENV=production: production only moves forward');
          return 1;
        }
        const steps = argument === undefined ? 1 : Number(argument);
        const reverted = await migrateDown(db.sql, migrations, { steps });
        print(reverted.length === 0 ? 'nothing to roll back' : `reverted: ${reverted.join(', ')}`);
        return 0;
      }
      case 'status': {
        for (const { id, state } of await migrationStatus(db.sql, migrations)) {
          print(`${state === 'applied' ? '[x]' : '[ ]'} ${id}`);
        }
        return 0;
      }
      default:
        print(`unknown command "${command}". Use: up | down [steps] | status`);
        return 1;
    }
  } finally {
    await db.close();
  }
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
