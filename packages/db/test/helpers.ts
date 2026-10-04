import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { inject } from 'vitest';
import { createDatabase, loadMigrations, migrateUp, type Database } from '../src';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A superuser connection. Each test file creates its own database through it. */
    adminDatabaseUrl: string;
  }
}

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));

export interface TestDatabase {
  readonly db: Database;
  readonly url: string;
  /** Closes connections and drops the database. Call in afterAll. */
  drop(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function adminCommand(adminUrl: string, statement: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** A fresh database with every migration applied, private to the calling test file. */
export async function createTestDatabase(
  options: { migrate?: boolean; encoding?: string } = {},
): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `mc_test_${randomBytes(6).toString('hex')}`;
  await adminCommand(
    adminUrl,
    options.encoding === undefined
      ? `create database ${name}`
      : `create database ${name} encoding '${options.encoding}' template template0 lc_collate 'C' lc_ctype 'C'`,
  );

  const url = withDatabase(adminUrl, name);
  const db = createDatabase(url, { maxConnections: 6 });
  if (options.migrate !== false) {
    await migrateUp(db.sql, await loadMigrations(MIGRATIONS_DIRECTORY));
  }

  return {
    db,
    url,
    async drop() {
      await db.close();
      await adminCommand(adminUrl, `drop database if exists ${name} with (force)`);
    },
  };
}
