import { sql as drizzleSql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { createDatabase } from './index';

describe('createDatabase against a live server', () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase({ migrate: false });
  });

  afterAll(async () => {
    await testDatabase.drop();
  });

  it('pings', async () => {
    await expect(testDatabase.db.ping()).resolves.toBeUndefined();
  });

  it('runs raw queries', async () => {
    const rows = await testDatabase.db.sql<{ answer: number }[]>`select 42 as answer`;
    expect(rows[0]?.answer).toBe(42);
  });

  // Regression: drizzle() rewrites the serializers of the client it is given. Raw queries must
  // keep working with Date parameters and keep returning Date objects once an ORM exists.
  it('keeps raw Date handling intact next to the ORM', async () => {
    const { sql, orm } = testDatabase.db;
    const moment = new Date('2026-10-02T12:34:56.000Z');

    const [raw] = await sql<{ at: Date }[]>`select ${moment}::timestamptz as at`;
    expect(raw?.at).toBeInstanceOf(Date);
    expect(raw?.at.toISOString()).toBe(moment.toISOString());

    const viaOrm = await orm.execute<{ at: string }>(
      drizzleSql`select ${moment.toISOString()}::timestamptz as at`,
    );
    expect(new Date(viaOrm[0]?.at ?? '').toISOString()).toBe(moment.toISOString());
  });
});

describe('createDatabase without a server', () => {
  it('does not connect on creation and rejects ping when the server is unreachable', async () => {
    // Port 1 is reserved; nothing listens there.
    const db = createDatabase('postgres://nobody:nothing@127.0.0.1:1/none', { maxConnections: 1 });
    await expect(db.ping(1_500)).rejects.toThrow();
    await db.close();
  });
});
