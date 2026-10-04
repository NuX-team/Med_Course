import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import * as schema from './schema';

/**
 * Either the root database or a transaction: repositories accept both and never care which.
 * (A transaction is a database whose statements share one connection and commit together.)
 */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/**
 * `client` must be dedicated to Drizzle: it changes the client's type serializers and parsers
 * (see createDatabase). Never pass the same client you also use for raw queries.
 */
export function createOrm(client: Sql): Executor {
  return drizzle(client, { schema });
}
