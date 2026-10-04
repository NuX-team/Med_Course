import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIRECTORY, createTestDatabase, type TestDatabase } from '../test/helpers';
import { createDatabase } from './index';
import {
  MigrationError,
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
  type Migration,
} from './migrate';
import type { Sql } from 'postgres';

let migrations: Migration[];
const opened: TestDatabase[] = [];

beforeAll(async () => {
  migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((database) => database.drop()));
});

async function emptyDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrate: false });
  opened.push(database);
  return database;
}

/** Everything the migrations create, in a comparable form. */
async function schemaSnapshot(sql: Sql): Promise<Record<string, unknown>> {
  const columns = await sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name <> 'schema_migrations'
    order by table_name, ordinal_position`;
  const constraints = await sql`
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where connamespace = 'public'::regnamespace and conrelid::regclass::text <> 'schema_migrations'
    order by 1, 2`;
  const indexes = await sql`
    select indexname, indexdef from pg_indexes
    where schemaname = 'public' and tablename <> 'schema_migrations' order by 1`;
  const triggers = await sql`
    select tgname, tgrelid::regclass::text as table_name from pg_trigger
    where not tgisinternal order by 1`;
  const functions = await sql`
    select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1`;
  return { columns, constraints, indexes, triggers, functions };
}

async function userTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name <> 'schema_migrations' order by 1`;
  return rows.map((row) => row.table_name);
}

describe('the migration files', () => {
  it('are numbered, paired and non-empty', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    for (const migration of migrations) {
      expect(migration.up.trim()).not.toBe('');
      expect(migration.down.trim()).not.toBe('');
    }
  });
});

describe('migrateUp', () => {
  it('applies everything, reports it, and is a no-op the second time', async () => {
    const { db } = await emptyDatabase();

    expect(await migrateUp(db.sql, migrations)).toEqual(migrations.map((m) => m.id));
    expect(await migrateUp(db.sql, migrations)).toEqual([]);
    expect((await migrationStatus(db.sql, migrations)).every((s) => s.state === 'applied')).toBe(
      true,
    );
    expect(await userTables(db.sql)).toContain('treatment_courses');
  });

  it('stops at the requested migration', async () => {
    const { db } = await emptyDatabase();
    const second = migrations[1]?.id ?? '';

    expect(await migrateUp(db.sql, migrations, { to: second })).toEqual(
      migrations.slice(0, 2).map((m) => m.id),
    );
    const states = await migrationStatus(db.sql, migrations);
    expect(states.map((s) => s.state)).toEqual(
      migrations.map((_m, index) => (index < 2 ? 'applied' : 'pending')),
    );
    await expect(migrateUp(db.sql, migrations, { to: '9999_nope' })).rejects.toThrow(
      MigrationError,
    );
  });

  it('applies each migration exactly once when two migrators race', async () => {
    const first = await emptyDatabase();
    const second = createDatabase(first.url, { maxConnections: 2 });

    try {
      const [a, b] = await Promise.all([
        migrateUp(first.db.sql, migrations),
        migrateUp(second.sql, migrations),
      ]);
      expect([...a, ...b].sort()).toEqual(migrations.map((m) => m.id).sort());
      expect(
        (await migrationStatus(first.db.sql, migrations)).every((s) => s.state === 'applied'),
      ).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('rolls a failing migration back completely', async () => {
    const { db } = await emptyDatabase();
    const broken: Migration[] = [
      { id: '0001_ok', up: 'create table kept (id int);', down: 'drop table kept;', checksum: 'a' },
      {
        id: '0002_broken',
        up: 'create table half_done (id int); select * from does_not_exist;',
        down: 'drop table half_done;',
        checksum: 'b',
      },
    ];

    await expect(migrateUp(db.sql, broken)).rejects.toThrow();

    expect(await userTables(db.sql)).toEqual(['kept']);
    expect((await migrationStatus(db.sql, broken)).map((s) => s.state)).toEqual([
      'applied',
      'pending',
    ]);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const { db } = await emptyDatabase();
    await migrateUp(db.sql, migrations);

    const edited = migrations.map((m, index) => (index === 0 ? { ...m, checksum: 'tampered' } : m));
    await expect(migrateUp(db.sql, edited)).rejects.toThrow(/edited after it was applied/);
    await expect(migrationStatus(db.sql, edited)).rejects.toThrow(MigrationError);
  });

  it('refuses to run code that is behind the database', async () => {
    const { db } = await emptyDatabase();
    await migrateUp(db.sql, migrations);

    await expect(migrateUp(db.sql, migrations.slice(0, 2))).rejects.toThrow(MigrationError);
  });
});

describe('the database encoding', () => {
  it('must be UTF8: anything else is refused before a single table is created', async () => {
    const database = await createTestDatabase({ migrate: false, encoding: 'LATIN1' });
    opened.push(database);

    await expect(migrateUp(database.db.sql, migrations)).rejects.toThrow(/not UTF8/);
    await expect(migrationStatus(database.db.sql, migrations)).rejects.toThrow(MigrationError);
    expect(await userTables(database.db.sql)).toEqual([]);
  });

  it('stores emoji and Cyrillic, which is what names look like', async () => {
    const { db } = await emptyDatabase();
    await migrateUp(db.sql, migrations);
    const [row] = await db.sql<{ name: string }[]>`
      insert into clinics (name) values (${'Клиника «Нур» 🙂 Toshkent'}) returning name`;
    expect(row?.name).toBe('Клиника «Нур» 🙂 Toshkent');
  });
});

describe('migrateDown', () => {
  it('reverts the newest migration first, one step by default', async () => {
    const { db } = await emptyDatabase();
    await migrateUp(db.sql, migrations);

    expect(await migrateDown(db.sql, migrations)).toEqual([migrations.at(-1)?.id]);
    // Only the newest one is undone; everything before it is still in place.
    expect((await migrationStatus(db.sql, migrations)).map((s) => s.state)).toEqual(
      migrations.map((_m, index) => (index === migrations.length - 1 ? 'pending' : 'applied')),
    );
    expect(await userTables(db.sql)).toContain('audit_log');
  });

  it('rejects a nonsensical step count', async () => {
    const { db } = await emptyDatabase();
    await expect(migrateDown(db.sql, migrations, { steps: 0 })).rejects.toThrow(MigrationError);
    await expect(migrateDown(db.sql, migrations, { steps: 1.5 })).rejects.toThrow(MigrationError);
  });

  it('does nothing on an empty database', async () => {
    const { db } = await emptyDatabase();
    expect(await migrateDown(db.sql, migrations, { steps: 3 })).toEqual([]);
  });

  it('goes all the way down to an empty schema and back up to an identical one', async () => {
    const { db } = await emptyDatabase();
    await migrateUp(db.sql, migrations);
    const before = await schemaSnapshot(db.sql);

    const reverted = await migrateDown(db.sql, migrations, { steps: migrations.length });
    expect(reverted).toEqual([...migrations].reverse().map((m) => m.id));
    expect(await userTables(db.sql)).toEqual([]);
    const leftovers = await schemaSnapshot(db.sql);
    expect(leftovers).toEqual({
      columns: [],
      constraints: [],
      indexes: [],
      triggers: [],
      functions: [],
    });

    await migrateUp(db.sql, migrations);
    expect(await schemaSnapshot(db.sql)).toEqual(before);
  });
});
