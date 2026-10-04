import { createRepositories, systemActor, type Executor, type RepositoryDeps } from '@medcourse/db';
import type { Logger } from '@medcourse/logger';

/** How often the worker looks at whether it is keeping up. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

const system = systemActor('worker reconciliation');

export function reconcileDue(lastRunAt: Date | null, now: Date): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= RECONCILE_INTERVAL_MS;
}

/**
 * Looks for signs that the service has fallen behind (reminders or messages to doctors waiting
 * long past their time, rows taken and never reported on, doses past their deadline that nobody
 * recorded as missed) and opens an incident for the technical administrators, at most one of a
 * kind per day. Run at the start of a round, so that it measures how far behind things were
 * before this round began catching up. Returns how many incidents it opened.
 */
export async function runReconciliation(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<number> {
  const { incidents } = createRepositories(options.orm, options.repositoryDeps);
  const opened = await incidents.reconcile(system, options.now);
  if (opened > 0) {
    options.logger.warn({ incidentsOpened: opened }, 'the service has fallen behind');
  }
  return opened;
}
