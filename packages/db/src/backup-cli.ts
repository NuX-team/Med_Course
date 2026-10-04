import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfigFromProcess, requireBackupKey } from '@medcourse/config';
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
import { loadMigrations } from './migrate';

/**
 * pnpm db:backup <directory> [--keep <n>]   write an encrypted backup, keep the newest n files
 * pnpm db:restore <file>                     restore into the (empty) database of DATABASE_URL
 * pnpm db:restore-drill <file>               restore into a scratch database, check it, drop it
 *
 * The drill is the proof that a backup is worth having (TZ §12, §18.1): it needs a connection
 * that may create a database, the BACKUP_KEY the file was sealed with, and the ENCRYPTION_KEYS
 * of the data in it, and it says plainly whether all three still fit together.
 */

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));

function print(line: string): void {
  process.stdout.write(`${line}\n`);
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

async function main(): Promise<number> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (command === undefined || target === undefined) {
    print('usage: backup <directory> [--keep <n>] | restore <file> | drill <file>');
    return 2;
  }

  let config;
  let key;
  try {
    config = loadConfigFromProcess({ defaultHttpPort: 3000, receivesUpdates: false });
    key = requireBackupKey(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      print(error.message);
      return 1;
    }
    throw error;
  }
  const migrations = await loadMigrations(MIGRATIONS_DIRECTORY);

  try {
    switch (command) {
      case 'backup': {
        const keepAt = rest.indexOf('--keep');
        const keep = keepAt < 0 ? null : Number(rest[keepAt + 1]);
        if (keep !== null && (!Number.isInteger(keep) || keep < 1)) {
          print('--keep takes a whole number of files, at least 1');
          return 2;
        }
        await mkdir(target, { recursive: true });
        const now = new Date();
        const path = join(target, backupFileName(now));
        const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
        try {
          const manifest = await writeBackup(db.sql, key, path, now);
          const rows = Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0);
          print(
            `written: ${path} (${String(await backupSize(path))} bytes, ${String(Object.keys(manifest.tables).length)} tables, ${String(rows)} rows, key "${key.id}")`,
          );
        } finally {
          await db.close();
        }
        if (keep !== null) {
          const removed = await pruneBackups(target, keep);
          if (removed.length > 0) {
            print(`removed ${String(removed.length)} older backup(s)`);
          }
        }
        return 0;
      }

      case 'restore': {
        if (config.isProduction && !rest.includes('--yes-this-is-production')) {
          print('refusing to restore with APP_ENV=production without --yes-this-is-production');
          return 1;
        }
        const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
        try {
          const report = await restoreBackup(db.sql, [key], target, migrations);
          for (const problem of report.problems) {
            print(`PROBLEM: ${problem}`);
          }
          print(
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
        print(
          `backup of ${manifest.createdAt}: ${String(Object.keys(manifest.tables).length)} tables, ${String(rows)} rows`,
        );
        print(
          `restored into a scratch database and compared: ${problems.length === 0 ? 'every table matches' : 'PROBLEMS'}`,
        );
        for (const problem of problems) {
          print(`PROBLEM: ${problem}`);
        }
        print(`encrypted fields readable with the current ENCRYPTION_KEYS: ${readable}`);
        print('the scratch database was dropped');
        return problems.length === 0 && readable !== 'CANNOT DECRYPT' ? 0 : 1;
      }

      default:
        print(`unknown command "${command}". Use: backup | restore | drill`);
        return 2;
    }
  } catch (error) {
    if (error instanceof BackupError) {
      print(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
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
