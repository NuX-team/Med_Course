import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import * as schema from './schema';
import { ENUM_COLUMNS } from './schema';

/**
 * The SQL migrations own the schema; the Drizzle definitions only type the queries. These
 * tests are the guard that they describe the same database.
 */

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.drop();
});

const drizzleTables = Object.values<unknown>(schema).filter((value): value is PgTable =>
  is(value, PgTable),
);

/** "numeric(10, 3)" and "numeric(10,3)", "time(0) without time zone" and "time(0)": same type. */
function normalizeType(type: string): string {
  return type
    .toLowerCase()
    .replaceAll(' ', '')
    .replace('withouttimezone', '')
    .replace('withtimezone', 'tz');
}

interface DbColumn {
  table_name: string;
  column_name: string;
  type: string;
  not_null: boolean;
}

describe('Drizzle definitions match the migrated database', () => {
  it('describe exactly the same set of tables', async () => {
    const rows = await testDatabase.db.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'schema_migrations'`;

    const inDatabase = rows.map((row) => row.table_name).sort();
    const inDrizzle = drizzleTables.map((table) => getTableConfig(table).name).sort();
    expect(inDrizzle).toEqual(inDatabase);
  });

  it('describe the same columns, types and nullability', async () => {
    const rows = await testDatabase.db.sql<DbColumn[]>`
      select c.relname as table_name, a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and c.relname <> 'schema_migrations'`;

    const inDatabase = new Map(
      rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        `${normalizeType(row.type)} ${row.not_null ? 'not null' : 'null'}`,
      ]),
    );

    const inDrizzle = new Map<string, string>();
    for (const table of drizzleTables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        inDrizzle.set(
          `${config.name}.${column.name}`,
          `${normalizeType(column.getSQLType())} ${column.notNull ? 'not null' : 'null'}`,
        );
      }
    }

    expect(Object.fromEntries([...inDrizzle].sort())).toEqual(
      Object.fromEntries([...inDatabase].sort()),
    );
  });

  it('name only indexes that exist', async () => {
    const rows = await testDatabase.db.sql<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'public'`;
    const existing = new Set(rows.map((row) => row.indexname));

    const declared = drizzleTables
      .flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name))
      .filter((name): name is string => name !== undefined);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(existing, `index ${name}`).toContain(name);
    }
  });
});

interface CheckRow {
  table_name: string;
  column_name: string;
  definition: string;
}

/**
 * CHECK constraints that involve exactly one column and name text values, i.e. the allowed-values
 * lists. (Postgres prints a one-value list as `= 'X'` and a longer one as `= ANY (ARRAY[...])`.)
 */
async function enumChecks(): Promise<CheckRow[]> {
  const rows = await testDatabase.db.sql<CheckRow[]>`
    select c.relname as table_name, a.attname as column_name, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = con.conkey[1]
    where n.nspname = 'public' and con.contype = 'c' and cardinality(con.conkey) = 1`;
  // A pattern match (`~`) is a format rule, not a list of allowed values.
  return rows.filter(
    (row) => quotedValues(row.definition).length > 0 && !row.definition.includes(' ~ '),
  );
}

function quotedValues(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1] ?? '').sort();
}

describe('enum columns', () => {
  it('have a CHECK that allows exactly the values listed in TypeScript', async () => {
    const checks = await enumChecks();

    for (const { table, column, values } of ENUM_COLUMNS) {
      const found = checks.filter((row) => row.table_name === table && row.column_name === column);
      expect(found, `${table}.${column} needs exactly one single-column CHECK`).toHaveLength(1);
      expect(quotedValues(found[0]?.definition ?? ''), `${table}.${column}`).toEqual(
        [...values].sort(),
      );
    }
  });

  it('are all registered: no enum-like column exists only in SQL', async () => {
    const registered = new Set(ENUM_COLUMNS.map(({ table, column }) => `${table}.${column}`));
    const inDatabase = (await enumChecks()).map((row) => `${row.table_name}.${row.column_name}`);

    for (const name of inDatabase) {
      expect(registered, `${name} is missing from ENUM_COLUMNS`).toContain(name);
    }
  });
});
