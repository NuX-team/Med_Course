import { createRepositories, systemActor, type Executor, type RepositoryDeps } from '@medcourse/db';
import { t } from '@medcourse/i18n';
import type { Logger } from '@medcourse/logger';
import { formatLocalDate } from '@medcourse/schedule';
import type { TelegramApi } from '@medcourse/telegram';

/** How often running courses are checked for having reached the end of their last day. */
export const COMPLETION_SWEEP_INTERVAL_MS = 5 * 60_000;

const system = systemActor('worker completion');

export function completionSweepDue(lastRunAt: Date | null, now: Date): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= COMPLETION_SWEEP_INTERVAL_MS;
}

/**
 * Closes courses whose last day is over (ACTIVE to COMPLETED) and tells each patient so. The
 * closing is what matters and is recorded in the database first; the message is a courtesy sent
 * once, after the fact, and is not retried: a patient who misses it loses nothing but the note.
 * Repeats until a round closes nothing. Returns how many courses were closed.
 */
export async function runCompletionSweep(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly api: Pick<TelegramApi, 'sendMessage'>;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<number> {
  const { lifecycle } = createRepositories(options.orm, options.repositoryDeps);
  let total = 0;
  let undelivered = 0;
  for (;;) {
    const completed = await lifecycle.completeDue(system, options.now);
    if (completed.length === 0) {
      break;
    }
    total += completed.length;
    for (const course of completed) {
      if (course.patient === null) {
        continue;
      }
      try {
        await options.api.sendMessage(
          course.patient.telegramUserId,
          t(course.patient.locale, 'course.completed', { last: formatLocalDate(course.lastDay) }),
        );
      } catch {
        // Counted, never logged in detail: an HTTP error can carry the request address.
        undelivered += 1;
      }
    }
  }
  if (total > 0) {
    options.logger.info({ coursesCompleted: total, undelivered }, 'courses completed');
  }
  return total;
}
