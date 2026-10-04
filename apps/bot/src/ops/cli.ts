import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigError, loadConfigFromProcess } from '@medcourse/config';
import { createDatabase, loadMigrations, runBackupCommand, runMigrateCommand } from '@medcourse/db';
import { Api } from 'grammy';
import { formatCheck, preflightExitCode, runPreflight, type PreflightApi } from './preflight';

/**
 * What an operator runs on the server (docs/PILOT.md), from the image: no source tree, no tsx.
 *
 *   node ops.cjs migrate up | status           apply (or list) the database migrations
 *   node ops.cjs backup <dir> [--keep <n>]     an encrypted backup, the newest n kept
 *   node ops.cjs drill <file>                  restore it into a scratch database and compare
 *   node ops.cjs restore <file>                restore into an empty database (production: --yes-this-is-production)
 *   node ops.cjs preflight [--backups <dir>] [--offline]
 *                                              is this installation ready for patients?
 *
 * `--migrations <dir>` says where the .sql files are (default ./migrations next to the program).
 */

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** `--name value` taken out of the list; the rest is returned. */
function flag(argv: readonly string[], name: string): { value: string | null; rest: string[] } {
  const at = argv.indexOf(name);
  if (at < 0) {
    return { value: null, rest: [...argv] };
  }
  return {
    value: argv[at + 1] ?? null,
    rest: argv.filter((_, index) => index !== at && index !== at + 1),
  };
}

async function main(): Promise<number> {
  const given = process.argv.slice(2);
  const migrations = flag(given, '--migrations');
  const backups = flag(migrations.rest, '--backups');
  const offline = backups.rest.includes('--offline');
  const [command, ...rest] = backups.rest.filter((word) => word !== '--offline');
  const migrationsDirectory = resolve(migrations.value ?? 'migrations');

  let config;
  try {
    // Only the check of the installation needs to know how updates reach the bot; migrations and
    // backups run in containers that are not given the webhook settings.
    config = loadConfigFromProcess({
      defaultHttpPort: 3000,
      receivesUpdates: command === 'preflight',
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      // Names of the problems, never values.
      print(`invalid configuration: ${error.problems.join('; ')}`);
      return 2;
    }
    throw error;
  }
  const context = { config, migrationsDirectory, out: print };

  switch (command) {
    case 'migrate':
      return runMigrateCommand(rest, context);
    case 'backup':
    case 'restore':
    case 'drill':
      return runBackupCommand([command, ...rest], context);
    case 'preflight': {
      const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
      try {
        const files =
          backups.value === null
            ? null
            : await Promise.all(
                (await readdir(backups.value))
                  .filter((name) => /^medcourse-\d{8}-\d{6}\.mcbk$/.test(name))
                  .map(async (name) => ({
                    name,
                    writtenAt: (await stat(join(backups.value ?? '', name))).mtime,
                  })),
              );
        const api: PreflightApi | null =
          offline || config.telegram === null ? null : new Api(config.telegram.botToken);
        const checks = await runPreflight({
          config,
          sql: db.sql,
          api,
          migrations: await loadMigrations(migrationsDirectory),
          backups: files,
          now: new Date(),
        });
        for (const check of checks) {
          print(formatCheck(check));
        }
        const failed = checks.filter((check) => check.status === 'fail').length;
        const warned = checks.filter((check) => check.status === 'warn').length;
        print(
          failed === 0
            ? `ready: ${String(checks.length)} checks, ${String(warned)} warning(s)`
            : `NOT READY: ${String(failed)} check(s) failed`,
        );
        return preflightExitCode(checks);
      } finally {
        await db.close();
      }
    }
    default:
      print(
        'usage: ops migrate up|status | backup <dir> | drill <file> | restore <file> | preflight',
      );
      return 2;
  }
}

// `exitCode`, not `exit()`: exiting at once can cut off output still waiting in a pipe.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // The message only: errors from the database driver or HTTP client can carry addresses.
    print(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  },
);
