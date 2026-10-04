import type { Sql, TransactionSql } from 'postgres';

/**
 * Tools for race tests that are deterministic. A plain `Promise.all` of N calls proves little:
 * with a warm pool the calls often run one after another. Here another connection holds a row
 * lock, the test waits until every participant is really blocked behind it (as the database
 * itself reports), and only then lets them go.
 */

export interface HeldLock {
  /** Commits the holding transaction, releasing everything queued behind it. */
  release(): Promise<void>;
}

/** Opens a transaction on its own connection, takes the lock, and keeps it until released. */
export async function holdLock(
  sql: Sql,
  take: (tx: TransactionSql) => Promise<unknown>,
): Promise<HeldLock> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = (): void => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = sql.begin(async (tx) => {
    await take(tx);
    locked();
    await released;
  });
  await isLocked;
  return {
    async release() {
      release();
      await holder;
    },
  };
}

/** How many connections to this database are waiting for a lock right now. */
export async function blockedCount(sql: Sql): Promise<number> {
  const [row] = await sql<{ waiting: number }[]>`
    select count(*)::int as waiting from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`;
  return row?.waiting ?? 0;
}

/**
 * Waits until exactly `count` connections are blocked on a lock, and fails the test if that
 * never happens: a race test whose participants did not all queue up has proved nothing.
 */
export async function waitForBlocked(sql: Sql, count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await blockedCount(sql)) >= count) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const waiting = await blockedCount(sql);
  if (waiting !== count) {
    throw new Error(`expected ${String(count)} blocked connections, saw ${String(waiting)}`);
  }
}
