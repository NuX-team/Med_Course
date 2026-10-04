import { loadConfigFromProcess, ConfigError } from '@medcourse/config';
import { createDatabase, createRepositories, createRepositoryDeps } from '@medcourse/db';
import { Api } from 'grammy';
import { runAdminCommand } from './commands';

/** pnpm admin ...  (see commands.ts for what it does). */

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  let config: ReturnType<typeof loadConfigFromProcess>;
  try {
    config = loadConfigFromProcess({ defaultHttpPort: 3000 });
  } catch (err) {
    if (err instanceof ConfigError) {
      // Names of the problems, never values.
      print(`invalid configuration: ${err.problems.join('; ')}`);
      return 2;
    }
    throw err;
  }

  const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
  try {
    return await runAdminCommand(process.argv.slice(2), {
      repos: createRepositories(db.orm, createRepositoryDeps(config.encryptionKeys)),
      api: config.telegram === null ? null : new Api(config.telegram.botToken),
      out: print,
    });
  } finally {
    await db.close();
  }
}

// `exitCode`, not `exit()`: exiting at once can cut off output still waiting in a pipe.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // The message only: errors from the database driver or HTTP client can carry addresses.
    print(`failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  },
);
