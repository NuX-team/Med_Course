import postgres, { type Sql } from 'postgres';
import { createOrm, type Executor } from './orm';

export * from './access/actor';
export * from './access/errors';
export * from './access/scopes';
export * from './audit';
export * from './backup';
export * from './field-cipher';
export * from './migrate';
export * from './orm';
export * from './repositories';
export * from './schema';

export interface Database {
  /** Raw driver, for migrations and anything Drizzle cannot express. Own connection pool. */
  readonly sql: Sql;
  /** Typed queries. Repositories take this (or a transaction handle). Own connection pool. */
  readonly orm: Executor;
  /** Resolves if the database answers a trivial query in time, rejects otherwise. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly maxConnections?: number;
}

const DEFAULT_PING_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_SECONDS = 5;
const CLOSE_TIMEOUT_SECONDS = 5;

const RAW_POOL_SIZE = 3;

/**
 * Two clients, on purpose. `drizzle()` rewrites the type serializers and parsers of the client
 * it is given (timestamps and JSON pass through untouched, because Drizzle's own column
 * mappers convert them). On a shared client that would break raw queries: a `Date` parameter
 * would fail to bind and timestamps would come back as strings. So Drizzle gets its own.
 *
 * Connections are opened lazily on first query, so creating this never throws because the
 * database is down.
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): Database {
  const common = { connect_timeout: CONNECT_TIMEOUT_SECONDS, onnotice: () => undefined };
  const max = options.maxConnections ?? 10;
  const sql = postgres(url, { ...common, max: Math.min(max, RAW_POOL_SIZE) });
  const ormClient = postgres(url, { ...common, max });

  return {
    sql,
    orm: createOrm(ormClient),

    async ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`database ping timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);
      });

      try {
        await Promise.race([sql`select 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    async close() {
      await Promise.all([
        sql.end({ timeout: CLOSE_TIMEOUT_SECONDS }),
        ormClient.end({ timeout: CLOSE_TIMEOUT_SECONDS }),
      ]);
    },
  };
}
