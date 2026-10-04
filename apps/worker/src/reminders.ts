import {
  createRepositories,
  systemActor,
  type DueReminder,
  type Executor,
  type ReminderOutcome,
  type RepositoryDeps,
} from '@medcourse/db';
import type { Logger } from '@medcourse/logger';
import { reminderMessage, replyMarkup, type TelegramApi } from '@medcourse/telegram';
import type { Pacer } from './pacer';

/** Reminders taken per round. Sending is paced (see `Pacer`), so a bigger batch only means fewer trips to the database. */
export const OUTBOX_BATCH = 100;
/** Sends in flight at once within a round: the rate is the pacer's, this only hides each answer's latency. */
export const OUTBOX_CONCURRENCY = 10;
/** Messages per second the bot sends in all. Telegram's limit is about 30. */
export const SEND_RATE_PER_SECOND = 25;
/** How long a burst of rounds may run before the loop's other duties get their turn. */
export const OUTBOX_BURST_MS = 20_000;
/** How long a reminder stays reserved for the worker that took it. */
export const SEND_LOCK_MS = 60_000;
/** How often unanswered doses past their deadline are turned into misses. */
export const MISSED_SWEEP_INTERVAL_MS = 30_000;

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

const system = systemActor('worker reminders');

export type Decision = { readonly send: true } | { readonly send: false; readonly reason: string };

/**
 * Whether a reminder taken from the queue should still be sent, decided at the last moment
 * before sending (ARCHITECTURE §8). Anything that has changed since it was queued (an answer,
 * a paused or stopped course, a replaced plan, a closed account, the deadline itself) cancels it:
 * a reminder for something that is no longer true is worse than no reminder.
 */
export function decide(reminder: DueReminder, now: Date): Decision {
  if (!reminder.recipient.active) {
    return { send: false, reason: 'recipient inactive' };
  }
  if (reminder.courseStatus !== 'ACTIVE') {
    return { send: false, reason: 'course not running' };
  }
  if (!reminder.revisionCurrent) {
    return { send: false, reason: 'plan replaced' };
  }
  if (!['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(reminder.doseStatus)) {
    return { send: false, reason: 'dose answered' };
  }
  if (now >= reminder.deadlineAt) {
    return { send: false, reason: 'deadline passed' };
  }
  if (
    reminder.kind === 'DOSE_LEAD' &&
    (now >= reminder.scheduledAt || reminder.doseStatus !== 'SCHEDULED')
  ) {
    return { send: false, reason: 'heads-up too late' };
  }
  return { send: true };
}

function numberField(value: unknown, field: string): number | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

/**
 * What to do after Telegram (or the network) refused a reminder. Only the status code is kept:
 * the error itself is never logged or stored, since an HTTP error can carry the request address.
 * - blocked bot or missing chat (403, 400): it will never arrive, so it is not retried;
 * - rate limit (429): wait as long as Telegram says;
 * - anything else (network, 5xx, a wrong token): retry with a growing pause.
 * A retry that would land at or after the moment the reminder stops making sense is not made.
 */
export function outcomeOfFailure(
  error: unknown,
  reminder: Pick<DueReminder, 'tries' | 'kind' | 'scheduledAt' | 'deadlineAt'>,
  now: Date,
  random: () => number = Math.random,
): ReminderOutcome {
  const code = numberField(error, 'error_code');
  const name = code === null ? 'NETWORK' : `HTTP_${String(code)}`;
  if (code === 403 || code === 400) {
    return { status: 'FAILED', error: name, at: now };
  }

  let waitMs: number;
  if (code === 429) {
    const seconds = numberField((error as { parameters?: unknown }).parameters, 'retry_after');
    waitMs = seconds === null || seconds <= 0 ? DEFAULT_RATE_LIMIT_WAIT_MS : seconds * 1000;
  } else {
    waitMs =
      Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** reminder.tries) + Math.floor(random() * 1000);
  }
  const at = new Date(now.getTime() + waitMs);
  const pointlessFrom = reminder.kind === 'DOSE_LEAD' ? reminder.scheduledAt : reminder.deadlineAt;
  return at >= pointlessFrom
    ? { status: 'CANCELLED', reason: `gave up after ${name}` }
    : { status: 'RETRY', at, error: name };
}

export interface OutboxResult {
  readonly sent: number;
  readonly cancelled: number;
  readonly retried: number;
  readonly failed: number;
}

export interface OutboxOptions {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly api: Pick<TelegramApi, 'sendMessage'>;
  readonly logger: Logger;
  /** Injected so tests control the clock. */
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly limit?: number;
  /** Shared between rounds so the rate holds across them. Absent: sends are not spaced out. */
  readonly pacer?: Pacer;
  readonly concurrency?: number;
}

/**
 * One round of the outbox: take what is due, check each reminder once more, send it, and write
 * down what happened. A reminder is reserved before it is sent and released only by the report,
 * so a crash in between leads to a second send later, never to a lost reminder; the answer
 * buttons are idempotent, which makes that duplicate harmless. One reminder failing does not
 * stop the others.
 */
export async function runOutbox(options: OutboxOptions): Promise<OutboxResult> {
  const now = options.now ?? (() => new Date());
  const { outbox } = createRepositories(options.orm, options.repositoryDeps);
  const result = { sent: 0, cancelled: 0, retried: 0, failed: 0 };

  const due = await outbox.claimDue(system, {
    now: now(),
    limit: options.limit ?? OUTBOX_BATCH,
    lockMs: SEND_LOCK_MS,
  });
  // Each reminder is its own piece of work: one recipient never has two in a round, so they can
  // go side by side. The pacer, not the number of workers, decides how fast they leave.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < due.length; index = next++) {
      const reminder = due[index];
      if (reminder !== undefined) {
        await deliver(reminder);
      }
    }
  };
  const deliver = async (reminder: (typeof due)[number]): Promise<void> => {
    let outcome: ReminderOutcome;
    const decision = decide(reminder, now());
    if (!decision.send) {
      outcome = { status: 'CANCELLED', reason: decision.reason };
    } else if (!(await outbox.stillClaimed(system, reminder.notificationId))) {
      // Withdrawn between being taken and being sent: the course was paused or stopped, or its
      // plan was replaced. The row is already cancelled; there is nothing to send or record.
      result.cancelled += 1;
      return;
    } else {
      const message = reminderMessage(reminder.recipient.locale, reminder);
      try {
        await options.pacer?.take();
        await options.api.sendMessage(
          reminder.recipient.telegramUserId,
          message.text,
          replyMarkup(message.buttons),
        );
        outcome = { status: 'SENT', at: now() };
      } catch (error) {
        outcome = outcomeOfFailure(error, reminder, now(), options.random);
        if (numberField(error, 'error_code') === 429) {
          // Told to wait: everybody waits, not just this one.
          const seconds = numberField(
            (error as { parameters?: unknown }).parameters,
            'retry_after',
          );
          options.pacer?.pauseFor((seconds === null || seconds <= 0 ? 5 : seconds) * 1000);
        }
        // The code only: nothing about the message, the person or the request.
        options.logger.warn(
          {
            notificationId: reminder.notificationId,
            outcome: outcome.status,
            tries: reminder.tries,
          },
          'a reminder could not be sent',
        );
      }
    }

    try {
      await outbox.finish(system, reminder.notificationId, outcome);
    } catch (err) {
      // Left SENDING: its lock will expire and it will be taken again.
      options.logger.error(
        { err, notificationId: reminder.notificationId },
        'could not record a reminder',
      );
      return;
    }
    if (outcome.status === 'SENT') result.sent += 1;
    else if (outcome.status === 'CANCELLED') result.cancelled += 1;
    else if (outcome.status === 'RETRY') result.retried += 1;
    else result.failed += 1;
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? OUTBOX_CONCURRENCY, due.length) }, worker),
  );

  if (due.length > 0) {
    options.logger.debug(result, 'outbox round done');
  }
  return result;
}

/**
 * Rounds back to back for as long as the queue has more than a round's worth waiting, up to a
 * time budget. A peak (everyone's 08:00 at once) is thereby worked off as fast as the pacer lets
 * it go, instead of one batch every two seconds; the rest of the worker's duties follow after.
 */
export async function runOutboxBurst(
  options: OutboxOptions,
  budgetMs: number = OUTBOX_BURST_MS,
): Promise<OutboxResult> {
  const total = { sent: 0, cancelled: 0, retried: 0, failed: 0 };
  const limit = options.limit ?? OUTBOX_BATCH;
  const startedAt = Date.now();
  for (;;) {
    const round = await runOutbox(options);
    total.sent += round.sent;
    total.cancelled += round.cancelled;
    total.retried += round.retried;
    total.failed += round.failed;
    const handled = round.sent + round.cancelled + round.retried + round.failed;
    if (handled < limit || Date.now() - startedAt >= budgetMs) {
      return total;
    }
  }
}

export function missedSweepDue(lastRunAt: Date | null, now: Date): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= MISSED_SWEEP_INTERVAL_MS;
}

/** Turns every unanswered dose past its deadline into a miss; repeats until none is left. */
export async function runMissedSweep(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<number> {
  const { answers } = createRepositories(options.orm, options.repositoryDeps);
  let total = 0;
  for (;;) {
    const missed = await answers.sweepMissed(system, options.now);
    total += missed;
    if (missed === 0) {
      break;
    }
  }
  if (total > 0) {
    options.logger.info({ dosesMissed: total }, 'missed doses recorded');
  }
  return total;
}
