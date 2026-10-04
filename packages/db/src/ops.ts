import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, requireBackupKey, type Config } from '@medcourse/config';
import {
  BackupError,
  backupFileName,
  backupSize,
  inspectBackup,
  pruneBackups,
  restoreBackup,
  writeBackup,
} from './backup';
import { FieldCipher, fieldAad } from './field-cipher';
import { createDatabase } from './index';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate';

/**
 * What an operator does to the database from a command line: migrate it, back it up, restore a
 * backup, rehearse the restore. One implementation, used by the developer's `pnpm db:*` commands
 * and by the `ops` program that ships in the server image, which has no `tsx` and no source tree.
 */
export interface OpsContext {
  readonly config: Config;
  /** Where the .sql files are: next to the sources in a checkout, `/app/migrations` in the image. */
  readonly migrationsDirectory: string;
  readonly out: (line: string) => void;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * After a restore: is one encrypted field of the restored data readable with the keys in hand?
 * A backup whose data cannot be decrypted is as good as lost, and that is found out here.
 */
async function decryptsWith(
  url: string,
  cipher: FieldCipher,
): Promise<'ok' | 'nothing to check' | 'CANNOT DECRYPT'> {
  const db = createDatabase(url, { maxConnections: 1 });
  try {
    const [sample] = await db.sql<{ id: string; text: string }[]>`
      select id, instructions_enc as text from course_medications
      where instructions_enc is not null limit 1`;
    if (sample === undefined) {
      return 'nothing to check';
    }
    try {
      cipher.decrypt(sample.text, fieldAad('course_medications', 'instructions_enc', sample.id));
      return 'ok';
    } catch {
      return 'CANNOT DECRYPT';
    }
  } finally {
    await db.close();
  }
}

/** `up` | `down [steps]` | `status`: the migrations of the database in the configuration. */
export async function runMigrateCommand(
  argv: readonly string[],
  context: OpsContext,
): Promise<number> {
  const { config, out } = context;
  const [command = 'status', argument] = argv;
  const migrations = await loadMigrations(context.migrationsDirectory);
  const db = createDatabase(config.databaseUrl, { maxConnections: 1 });
  try {
    switch (command) {
      case 'up': {
        const applied = await migrateUp(db.sql, migrations);
        out(applied.length === 0 ? 'nothing to apply' : `applied: ${applied.join(', ')}`);
        return 0;
      }
      case 'down': {
        if (config.isProduction) {
          out('refusing to roll back with APP_ENV=production: production only moves forward');
          return 1;
        }
        const steps = argument === undefined ? 1 : Number(argument);
        if (!Number.isInteger(steps) || steps < 1) {
          out('down takes a whole number of migrations to roll back, at least 1');
          return 2;
        }
        const reverted = await migrateDown(db.sql, migrations, { steps });
        out(reverted.length === 0 ? 'nothing to roll back' : `reverted: ${reverted.join(', ')}`);
        return 0;
      }
      case 'status': {
        for (const { id, state } of await migrationStatus(db.sql, migrations)) {
          out(`${state === 'applied' ? '[x]' : '[ ]'} ${id}`);
        }
        return 0;
      }
      default:
        out(`unknown command "${command}". Use: up | down [steps] | status`);
        return 1;
    }
  } finally {
    await db.close();
  }
}

/** `backup <dir> [--keep n]` | `restore <file>` | `drill <file>`: see packages/db/src/backup.ts. */
export async function runBackupCommand(
  argv: readonly string[],
  context: OpsContext,
): Promise<number> {
  const { config, out } = context;
  const [command, target, ...rest] = argv;
  if (command === undefined || target === undefined) {
    out('usage: backup <directory> [--keep <n>] | restore <file> | drill <file>');
    return 2;
  }
  let key;
  try {
    key = requireBackupKey(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      out(error.message);
      return 1;
    }
    throw error;
  }
  const migrations = await loadMigrations(context.migrationsDirectory);

  try {
    switch (command) {
      case 'backup': {
        const keepAt = rest.indexOf('--keep');
        const keep = keepAt < 0 ? null : Number(rest[keepAt + 1]);
        if (keep !== null && (!Number.isInteger(keep) || keep < 1)) {
          out('--keep takes a whole number of files, at least 1');
          return 2;
        }
        await mkdir(target, { recursive: true });
        const now = new Date();
        const path = join(target, backupFileName(now));
        const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
        try {
          const manifest = await writeBackup(db.sql, key, path, now);
          const rows = Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0);
          out(
            `written: ${path} (${String(await backupSize(path))} bytes, ${String(Object.keys(manifest.tables).length)} tables, ${String(rows)} rows, key "${key.id}")`,
          );
        } finally {
          await db.close();
        }
        if (keep !== null) {
          const removed = await pruneBackups(target, keep);
          if (removed.length > 0) {
            out(`removed ${String(removed.length)} older backup(s)`);
          }
        }
        return 0;
      }

      case 'restore': {
        if (config.isProduction && !rest.includes('--yes-this-is-production')) {
          out('refusing to restore with APP_ENV=production without --yes-this-is-production');
          return 1;
        }
        const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
        try {
          const report = await restoreBackup(db.sql, [key], target, migrations);
          for (const problem of report.problems) {
            out(`PROBLEM: ${problem}`);
          }
          out(
            report.problems.length === 0
              ? `restored the backup of ${report.manifest.createdAt}: every table matches`
              : 'the restore finished with problems: do not use this database',
          );
          return report.problems.length === 0 ? 0 : 1;
        } finally {
          await db.close();
        }
      }

      case 'drill': {
        const manifest = await inspectBackup(target, [key]);
        const scratch = `medcourse_drill_${randomBytes(4).toString('hex')}`;
        const admin = createDatabase(config.databaseUrl, { maxConnections: 1 });
        await admin.sql.unsafe(
          `create database ${scratch} encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'`,
        );
        let problems: readonly string[] = ['the restore did not run'];
        let readable = 'not checked';
        try {
          const url = withDatabase(config.databaseUrl, scratch);
          const db = createDatabase(url, { maxConnections: 2 });
          try {
            ({ problems } = await restoreBackup(db.sql, [key], target, migrations));
          } finally {
            await db.close();
          }
          readable = await decryptsWith(url, new FieldCipher(config.encryptionKeys));
        } finally {
          await admin.sql.unsafe(`drop database if exists ${scratch} with (force)`);
          await admin.close();
        }
        const rows = Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0);
        out(
          `backup of ${manifest.createdAt}: ${String(Object.keys(manifest.tables).length)} tables, ${String(rows)} rows`,
        );
        out(
          `restored into a scratch database and compared: ${problems.length === 0 ? 'every table matches' : 'PROBLEMS'}`,
        );
        for (const problem of problems) {
          out(`PROBLEM: ${problem}`);
        }
        out(`encrypted fields readable with the current ENCRYPTION_KEYS: ${readable}`);
        out('the scratch database was dropped');
        return problems.length === 0 && readable !== 'CANNOT DECRYPT' ? 0 : 1;
      }

      default:
        out(`unknown command "${command}". Use: backup | restore | drill`);
        return 2;
    }
  } catch (error) {
    if (error instanceof BackupError) {
      out(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
