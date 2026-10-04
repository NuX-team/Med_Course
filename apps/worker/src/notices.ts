import { createRepositories, systemActor, type Executor, type RepositoryDeps } from '@medcourse/db';
import { t } from '@medcourse/i18n';
import type { Logger } from '@medcourse/logger';
import type { TelegramApi } from '@medcourse/telegram';

/** Incidents announced per round: a flood is told in several rounds, not in one burst. */
const NOTICE_BATCH = 20;

const system = systemActor('worker incident notices');

export interface NoticeResult {
  /** Incidents looked at in this round. */
  readonly incidents: number;
  /** Messages that reached somebody. */
  readonly delivered: number;
  /** Messages Telegram did not take. */
  readonly failed: number;
}

/**
 * Tells the people who handle an incident that there is one (ARCHITECTURE §12): technical
 * administrators about the service's own, a clinic's staff about their patients'. The message
 * says what kind of incident it is and where to look: nothing about a patient, a drug or a
 * number, because Telegram is not where that is kept. Sent at least once and not more than a few
 * times: an incident that reached nobody is tried again after a pause, and the panel stays the
 * place where it can always be found. Only the count of failures is logged, never their text.
 */
export async function runIncidentNotices(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly api: Pick<TelegramApi, 'sendMessage'>;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<NoticeResult> {
  const { incidents } = createRepositories(options.orm, options.repositoryDeps);
  const due = await incidents.claimNotices(system, { now: options.now, limit: NOTICE_BATCH });
  let delivered = 0;
  let failed = 0;
  for (const notice of due) {
    let reached = 0;
    for (const person of notice.recipients) {
      try {
        await options.api.sendMessage(
          person.telegramUserId,
          t(person.locale, 'incident.notice', {
            what: t(person.locale, `pn.inc.type.${notice.type}`),
          }),
        );
        reached += 1;
      } catch {
        // Counted, never logged in detail: an HTTP error can carry the request address.
        failed += 1;
      }
    }
    delivered += reached;
    await incidents.finishNotice(system, {
      incidentId: notice.incidentId,
      reached,
      recipients: notice.recipients.length,
      now: options.now,
    });
  }
  if (failed > 0) {
    options.logger.warn({ failed }, 'incident notices could not be delivered');
  }
  if (delivered > 0) {
    options.logger.info({ delivered }, 'incident notices sent');
  }
  return { incidents: due.length, delivered, failed };
}
