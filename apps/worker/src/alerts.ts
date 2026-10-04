import {
  createRepositories,
  systemActor,
  type DueAlert,
  type Executor,
  type ReminderOutcome,
  type RepositoryDeps,
} from '@medcourse/db';
import type { Logger } from '@medcourse/logger';
import { SERIES_AT } from '@medcourse/schedule';
import { alertMessage, replyMarkup, type TelegramApi } from '@medcourse/telegram';
import type { Decision } from './reminders';

/** Alerts taken per round: one per doctor, so this is also "doctors written to per round". */
export const ALERT_BATCH = 25;
export const ALERT_LOCK_MS = 60_000;
/** After this many failed tries an alert is given up: by then it is hours old. */
export const ALERT_MAX_TRIES = 8;

const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 15 * 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

const system = systemActor('worker alerts');

/**
 * Whether an alert taken from the queue is still worth sending, decided at the last moment. An
 * alert is written when something happens and sent a moment later: in between the patient may
 * have put it right, the doctor may have ended the course or lost the right to see it. A
 * message about something that is no longer true is worse than no message.
 */
export function decideAlert(alert: DueAlert): Decision {
  if (!alert.recipient.entitled) {
    return { send: false, reason: 'recipient not entitled' };
  }
  if (alert.courseStatus === 'CANCELLED') {
    return { send: false, reason: 'course cancelled' };
  }
  switch (alert.kind) {
    case 'MISSED':
    case 'SKIPPED':
      return alert.doses.length > 0 ? { send: true } : { send: false, reason: 'put right' };
    case 'SERIES':
      return alert.run >= SERIES_AT ? { send: true } : { send: false, reason: 'run ended' };
    case 'DIGEST':
      // Only what goes beyond the escalation the doctor has already had.
      return alert.run > SERIES_AT ? { send: true } : { send: false, reason: 'run ended' };
    case 'PRN_OVER':
      return alert.prn?.stillOver === true
        ? { send: true }
        : { send: false, reason: 'mark taken back' };
    case 'PAUSE_REQUEST':
      return alert.courseStatus === 'ACTIVE'
        ? { send: true }
        : { send: false, reason: 'course not running' };
    case 'UNDELIVERED':
      return { send: true };
  }
}

function numberField(value: unknown, field: string): number | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

/**
 * What to do after Telegram (or the network) refused an alert. As with reminders, only the
 * status code is kept. A doctor who blocked the bot is not retried; anything else is, with a
 * growing pause, until the alert has been tried `ALERT_MAX_TRIES` times.
 */
export function alertOutcomeOfFailure(
  error: unknown,
  alert: Pick<DueAlert, 'tries'>,
  now: Date,
  random: () => number = Math.random,
): ReminderOutcome {
  const code = numberField(error, 'error_code');
  const name = code === null ? 'NETWORK' : `HTTP_${String(code)}`;
  if (code === 403 || code === 400 || alert.tries + 1 >= ALERT_MAX_TRIES) {
    return { status: 'FAILED', error: name, at: now };
  }
  let waitMs: number;
  if (code === 429) {
    const seconds = numberField((error as { parameters?: unknown }).parameters, 'retry_after');
    waitMs = seconds === null || seconds <= 0 ? DEFAULT_RATE_LIMIT_WAIT_MS : seconds * 1000;
  } else {
    waitMs =
      Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** alert.tries) + Math.floor(random() * 1000);
  }
  return { status: 'RETRY', at: new Date(now.getTime() + waitMs), error: name };
}

export interface AlertsResult {
  readonly sent: number;
  readonly cancelled: number;
  readonly retried: number;
  readonly failed: number;
}

/**
 * One round of the alert queue: take what is due (one alert per doctor), check each once more,
 * send it, and write down what happened. Reserved before sending and released by the report, so
 * a crash in between means a second send later, never a lost alert.
 */
export async function runAlerts(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly api: Pick<TelegramApi, 'sendMessage'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly limit?: number;
}): Promise<AlertsResult> {
  const now = options.now ?? (() => new Date());
  const { alerts } = createRepositories(options.orm, options.repositoryDeps);
  const result = { sent: 0, cancelled: 0, retried: 0, failed: 0 };

  const due = await alerts.claimDue(system, {
    now: now(),
    limit: options.limit ?? ALERT_BATCH,
    lockMs: ALERT_LOCK_MS,
  });
  for (const alert of due) {
    let outcome: ReminderOutcome;
    const decision = decideAlert(alert);
    if (!decision.send) {
      outcome = { status: 'CANCELLED', reason: decision.reason };
    } else {
      const message = alertMessage(alert.recipient.locale, alert);
      try {
        await options.api.sendMessage(
          alert.recipient.telegramUserId,
          message.text,
          replyMarkup(message.buttons),
        );
        outcome = { status: 'SENT', at: now() };
      } catch (error) {
        outcome = alertOutcomeOfFailure(error, alert, now(), options.random);
        // The code only: nothing about the message, the people or the request.
        options.logger.warn(
          { alertId: alert.alertId, kind: alert.kind, outcome: outcome.status, tries: alert.tries },
          'an alert could not be sent',
        );
      }
    }
    try {
      await alerts.finish(system, alert.alertId, outcome);
    } catch (err) {
      // Left SENDING: its lock will expire and it will be taken again.
      options.logger.error({ err, alertId: alert.alertId }, 'could not record an alert');
      continue;
    }
    if (outcome.status === 'SENT') result.sent += 1;
    else if (outcome.status === 'CANCELLED') result.cancelled += 1;
    else if (outcome.status === 'RETRY') result.retried += 1;
    else result.failed += 1;
  }
  if (due.length > 0) {
    options.logger.debug(result, 'alert round done');
  }
  return result;
}
