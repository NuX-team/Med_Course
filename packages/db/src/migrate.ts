import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';

/**
 * Plain-SQL migrations with a matching down for each (`0001_name.up.sql` / `.down.sql`).
 * Drizzle only describes the tables for typed queries; a test keeps it in step with the SQL.
 * Downs exist for local work and CI round-trips. Production only ever moves forward.
 */
export interface Migration {
  readonly id: string;
  readonly up: string;
  readonly down: string;
  /** Of the up script. A change after it was applied is reported, not silently ignored. */
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
/** Arbitrary constant: serialises concurrent migrators on one database. */
const ADVISORY_LOCK_KEY = 7_340_001;

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const scripts = new Map<string, { up?: string; down?: string }>();

  for (const file of await readdir(directory)) {
    const match = FILE_PATTERN.exec(file);
    if (match === null) {
      if (file.endsWith('.sql')) {
        throw new MigrationError(`unexpected migration file name: ${file}`);
      }
      continue;
    }
    const [, number = '', name = '', direction = ''] = match;
    const entry = scripts.get(`${number}_${name}`) ?? {};
    entry[direction as 'up' | 'down'] = await readFile(join(directory, file), 'utf8');
    scripts.set(`${number}_${name}`, entry);
  }

  const migrations = [...scripts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { up, down }]): Migration => {
      if (up === undefined || down === undefined) {
        throw new MigrationError(`migration ${id} needs both an .up.sql and a .down.sql`);
      }
      return { id, up, down, checksum: createHash('sha256').update(up).digest('hex') };
    });

  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (!migration.id.startsWith(`${expected}_`)) {
      throw new MigrationError(
        `migration numbers must be 0001, 0002, ... without gaps (${migration.id})`,
      );
    }
  });
  return migrations;
}

export interface MigrationStatus {
  readonly id: string;
  readonly state: 'applied' | 'pending';
}

/**
 * `create table if not exists` is not safe against itself: two sessions creating the same
 * table at once can fail on the catalog's unique index. So it runs under the migration lock.
 */
/**
 * People type their names into Telegram, emoji included. A database in a single-byte encoding
 * (the default on some Windows installs) fails on the first one, at runtime and in the middle of
 * a conversation, so it is refused here instead.
 */
async function assertUtf8(sql: Sql): Promise<void> {
  const [row] = await sql<{ encoding: string }[]>`
    select pg_encoding_to_char(encoding) as encoding from pg_database where datname = current_database()`;
  if (row?.encoding !== 'UTF8') {
    throw new MigrationError(
      `the database encoding is ${row?.encoding ?? 'unknown'}, not UTF8; create it with ENCODING 'UTF8'`,
    );
  }
}

async function ensureTable(sql: Sql): Promise<void> {
  await assertUtf8(sql);
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
    await tx`
      create table if not exists schema_migrations (
        id text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
  });
}

async function readApplied(sql: Sql | TransactionSql): Promise<{ id: string; checksum: string }[]> {
  return sql<
    { id: string; checksum: string }[]
  >`select id, checksum from schema_migrations order by id`;
}

/** What is applied must be exactly the first N known migrations, unchanged. */
function assertConsistent(
  applied: readonly { id: string; checksum: string }[],
  known: readonly Migration[],
): void {
  applied.forEach((row, index) => {
    const migration = known[index];
    if (migration?.id !== row.id) {
      throw new MigrationError(
        `database has migration ${row.id} applied, but the code at position ${String(index + 1)} is ${migration?.id ?? 'missing'}`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(`migration ${row.id} was edited after it was applied`);
    }
  });
}

export async function migrationStatus(
  sql: Sql,
  migrations: readonly Migration[],
): Promise<MigrationStatus[]> {
  await ensureTable(sql);
  const applied = await readApplied(sql);
  assertConsistent(applied, migrations);
  const appliedIds = new Set(applied.map((row) => row.id));
  return migrations.map((migration) => ({
    id: migration.id,
    state: appliedIds.has(migration.id) ? 'applied' : 'pending',
  }));
}

/** Applies pending migrations in order, each in its own transaction. Returns the ids applied. */
export async function migrateUp(
  sql: Sql,
  migrations: readonly Migration[],
  options: { readonly to?: string } = {},
): Promise<string[]> {
  await ensureTable(sql);
  if (options.to !== undefined && !migrations.some((migration) => migration.id === options.to)) {
    throw new MigrationError(`unknown migration: ${options.to}`);
  }

  const done: string[] = [];
  for (const migration of migrations) {
    const applied = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      // Re-read under the lock: another migrator may have won the race.
      const rows = await readApplied(tx);
      assertConsistent(rows, migrations);
      if (rows.some((row) => row.id === migration.id)) {
        return false;
      }
      await tx.unsafe(migration.up).simple();
      await tx`insert into schema_migrations (id, checksum) values (${migration.id}, ${migration.checksum})`;
      return true;
    });
    if (applied) {
      done.push(migration.id);
    }
    if (migration.id === options.to) {
      break;
    }
  }
  return done;
}

/** Reverts the latest `steps` migrations (default 1), newest first. Returns the ids reverted. */
export async function migrateDown(
  sql: Sql,
  migrations: readonly Migration[],
  options: { readonly steps?: number } = {},
): Promise<string[]> {
  await ensureTable(sql);
  const steps = options.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new MigrationError('steps must be a positive integer');
  }

  const done: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    const reverted = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      const rows = await readApplied(tx);
      assertConsistent(rows, migrations);
      const latest = rows.at(-1);
      const migration = migrations.find((candidate) => candidate.id === latest?.id);
      if (migration === undefined) {
        return undefined;
      }
      await tx.unsafe(migration.down).simple();
      await tx`delete from schema_migrations where id = ${migration.id}`;
      return migration.id;
    });
    if (reverted === undefined) {
      break;
    }
    done.push(reverted);
  }
  return done;
}
