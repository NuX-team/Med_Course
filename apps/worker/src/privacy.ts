import { createRepositories, systemActor, type Executor, type RepositoryDeps } from '@medcourse/db';
import type { Logger } from '@medcourse/logger';

/** How often deletion requests and course summaries are looked at. Neither is urgent to the hour. */
export const PRIVACY_SWEEP_INTERVAL_MS = 3_600_000;

const system = systemActor('worker privacy');

export function privacySweepDue(lastRunAt: Date | null, now: Date): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= PRIVACY_SWEEP_INTERVAL_MS;
}

export interface PrivacySweepResult {
  readonly accountsErased: number;
  readonly summariesWritten: number;
}

/**
 * Two slow duties of the service towards the people in it (TZ §12.1): carrying out requests for
 * deletion that have fallen due, and drawing up the short summary of each course three days
 * after it ended. An erased account is logged by its id alone: that line is what tells an
 * operator, after a restore from an older backup, whose data must be erased again.
 */
export async function runPrivacySweep(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<PrivacySweepResult> {
  const { privacy } = createRepositories(options.orm, options.repositoryDeps);
  const erased = await privacy.eraseDue(system, options.now);
  for (const userId of erased) {
    options.logger.info({ userId }, 'deletion request carried out');
  }
  let summariesWritten = 0;
  for (;;) {
    const written = await privacy.summariseDue(system, options.now);
    summariesWritten += written;
    if (written === 0) {
      break;
    }
  }
  if (summariesWritten > 0) {
    options.logger.info({ summariesWritten }, 'course summaries drawn up');
  }
  return { accountsErased: erased.length, summariesWritten };
}
