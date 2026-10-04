import { randomUUID } from 'node:crypto';
import { availableSnoozeOptions, type ReminderPolicy } from '@medcourse/schedule';
import { and, asc, count, eq, inArray, lt, lte, or } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import type { Executor } from '../orm';
import {
  courseMedications,
  doseEvents,
  notifications,
  reminderPolicies,
  scheduledDoses,
  treatmentCourses,
  users,
  type CourseStatus,
  type DoseStatus,
} from '../schema';
import { noteUndelivered } from './alerts';
import type { RepositoryDeps } from './context';
import { createPlanReader, type DoseUnit, type FoodRule } from './plans';

export type NotificationKind = (typeof notifications.$inferSelect)['kind'];

/** A reminder taken from the queue, with everything needed to decide about it and to write it. */
export interface DueReminder {
  readonly notificationId: string;
  readonly kind: NotificationKind;
  readonly attemptNo: number;
  readonly dueAt: Date;
  /** How many times sending has already failed. */
  readonly tries: number;
  readonly doseId: string;
  readonly doseStatus: DoseStatus;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date;
  readonly courseId: string;
  readonly courseStatus: CourseStatus;
  readonly timezone: string;
  /** False when the dose belongs to a plan that has since been replaced. */
  readonly revisionCurrent: boolean;
  readonly medication: {
    readonly displayName: string;
    readonly doseValue: string;
    readonly doseDisplay: string | null;
    readonly doseUnit: DoseUnit;
    readonly foodRule: FoodRule;
    readonly instructions: string | null;
  };
  readonly recipient: {
    readonly userId: string;
    readonly telegramUserId: number;
    readonly locale: 'ru' | 'uz';
    readonly active: boolean;
  };
  /** The "later" choices that still fit before the deadline, as of the moment of claiming. */
  readonly snoozeOptions: readonly number[];
}

/** What became of a reminder that was taken from the queue. */
export type ReminderOutcome =
  | { readonly status: 'SENT'; readonly at: Date }
  /** No longer wanted: the dose is answered, the course stopped, the deadline passed. */
  | { readonly status: 'CANCELLED'; readonly reason: string }
  /** Telegram will never deliver it (the bot is blocked, the chat is gone). */
  | { readonly status: 'FAILED'; readonly error: string; readonly at?: Date }
  /** Try again at `at` (a network error, a rate limit). */
  | { readonly status: 'RETRY'; readonly at: Date; readonly error: string };

function requireSystem(actor: Actor): void {
  if (actor.kind !== 'SYSTEM') {
    throw new ForbiddenError('only the system works the reminder queue');
  }
}

/**
 * The reminder queue as the worker sees it (ARCHITECTURE §8). Rows are taken with
 * `FOR UPDATE SKIP LOCKED`, so any number of workers can run side by side, and marked SENDING
 * with a lock that expires: if a worker dies mid-send, another takes the row over later. That
 * means a reminder is sent at least once, possibly twice, and never silently lost.
 */
export function createOutboxRepository(db: Executor, deps: RepositoryDeps) {
  const { decryptInstructions } = createPlanReader(deps);

  return {
    /**
     * Takes up to `limit` reminders that are due (or were left SENDING by a worker that died),
     * at most one per recipient: a person is not sent several messages in the same instant.
     * The rest stay queued for the next round.
     */
    async claimDue(
      actor: Actor,
      input: { now: Date; limit: number; lockMs: number },
    ): Promise<DueReminder[]> {
      requireSystem(actor);
      const { now } = input;
      return db.transaction(async (tx) => {
        const candidates = await tx
          .select({ id: notifications.id, recipientUserId: notifications.recipientUserId })
          .from(notifications)
          .where(
            or(
              and(eq(notifications.status, 'QUEUED'), lte(notifications.dueAt, now)),
              and(eq(notifications.status, 'SENDING'), lt(notifications.lockedUntil, now)),
            ),
          )
          .orderBy(asc(notifications.dueAt), asc(notifications.attemptNo))
          .limit(input.limit * 4)
          .for('update', { skipLocked: true });

        const seen = new Set<string>();
        const chosen: string[] = [];
        for (const candidate of candidates) {
          if (chosen.length < input.limit && !seen.has(candidate.recipientUserId)) {
            seen.add(candidate.recipientUserId);
            chosen.push(candidate.id);
          }
        }
        if (chosen.length === 0) {
          return [];
        }
        await tx
          .update(notifications)
          .set({ status: 'SENDING', lockedUntil: new Date(now.getTime() + input.lockMs) })
          .where(inArray(notifications.id, chosen));

        const rows = await tx
          .select({
            notification: notifications,
            dose: scheduledDoses,
            courseStatus: treatmentCourses.status,
            timezone: treatmentCourses.timezone,
            currentRevisionId: treatmentCourses.currentRevisionId,
            medication: courseMedications,
            telegramUserId: users.telegramUserId,
            locale: users.locale,
            userStatus: users.status,
            policy: reminderPolicies,
          })
          .from(notifications)
          .innerJoin(scheduledDoses, eq(scheduledDoses.id, notifications.scheduledDoseId))
          .innerJoin(treatmentCourses, eq(treatmentCourses.id, notifications.courseId))
          .innerJoin(courseMedications, eq(courseMedications.id, scheduledDoses.medicationId))
          .innerJoin(users, eq(users.id, notifications.recipientUserId))
          .innerJoin(reminderPolicies, eq(reminderPolicies.courseId, notifications.courseId))
          .where(inArray(notifications.id, chosen))
          .orderBy(asc(notifications.dueAt), asc(notifications.attemptNo));

        const snoozes = await tx
          .select({ doseId: doseEvents.scheduledDoseId, used: count() })
          .from(doseEvents)
          .where(
            and(
              eq(doseEvents.eventType, 'SNOOZED'),
              inArray(
                doseEvents.scheduledDoseId,
                rows.map((row) => row.dose.id),
              ),
            ),
          )
          .groupBy(doseEvents.scheduledDoseId);
        const snoozesUsed = new Map(snoozes.map((row) => [row.doseId, row.used]));

        return rows.map((row) => {
          const policy: ReminderPolicy = {
            attempts: row.policy.attempts,
            retryIntervalMinutes: row.policy.retryIntervalMinutes,
            missAfterMinutes: row.policy.missAfterMinutes,
            snoozeOptionsMinutes: row.policy.snoozeOptionsMinutes,
            maxSnoozes: row.policy.maxSnoozes,
            correctionWindowMinutes: row.policy.correctionWindowMinutes,
            leadMinutes: row.policy.leadMinutes,
          };
          return {
            notificationId: row.notification.id,
            kind: row.notification.kind,
            attemptNo: row.notification.attemptNo,
            dueAt: row.notification.dueAt,
            tries: row.notification.tries,
            doseId: row.dose.id,
            doseStatus: row.dose.status,
            scheduledAt: row.dose.scheduledAt,
            deadlineAt: row.dose.deadlineAt,
            courseId: row.notification.courseId,
            courseStatus: row.courseStatus,
            timezone: row.timezone,
            revisionCurrent: row.dose.revisionId === row.currentRevisionId,
            medication: {
              displayName: row.medication.displayName,
              doseValue: row.medication.doseValue,
              doseDisplay: row.medication.doseDisplay,
              doseUnit: row.medication.doseUnit,
              foodRule: row.medication.foodRule,
              instructions: decryptInstructions(row.medication),
            },
            recipient: {
              userId: row.notification.recipientUserId,
              telegramUserId: row.telegramUserId,
              locale: row.locale,
              active: row.userStatus === 'ACTIVE',
            },
            snoozeOptions: availableSnoozeOptions(
              {
                now,
                deadlineAt: row.dose.deadlineAt,
                snoozesUsed: snoozesUsed.get(row.dose.id) ?? 0,
              },
              policy,
            ),
          };
        });
      });
    },

    /**
     * Whether a claimed reminder is still this worker's to send. Asked at the last moment before
     * sending: a pause, a cancellation or a change of plan cancels the reminders it makes stale
     * even after a worker has taken them from the queue.
     */
    async stillClaimed(actor: Actor, notificationId: string): Promise<boolean> {
      requireSystem(actor);
      const [row] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, notificationId), eq(notifications.status, 'SENDING')));
      return row !== undefined;
    },

    /**
     * Records what happened to a claimed reminder. Only a row still SENDING is touched, so a
     * late report from a worker whose lock expired cannot overwrite what another worker did.
     * A first reminder that was sent moves its dose to NOTIFIED and writes the event, in the
     * same transaction. Returns false if the row was no longer this worker's to finish.
     */
    async finish(actor: Actor, notificationId: string, outcome: ReminderOutcome): Promise<boolean> {
      requireSystem(actor);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(notifications)
          .where(and(eq(notifications.id, notificationId), eq(notifications.status, 'SENDING')))
          .for('update');
        if (row === undefined) {
          return false;
        }

        switch (outcome.status) {
          case 'CANCELLED':
            await tx
              .update(notifications)
              .set({
                status: 'CANCELLED',
                lockedUntil: null,
                lastError: outcome.reason.slice(0, 60),
              })
              .where(eq(notifications.id, notificationId));
            return true;
          case 'FAILED':
            await tx
              .update(notifications)
              .set({
                status: 'FAILED',
                lockedUntil: null,
                tries: row.tries + 1,
                lastError: outcome.error.slice(0, 60),
              })
              .where(eq(notifications.id, notificationId));
            // Telegram will never deliver it: the doctor should reach the patient another way.
            await noteUndelivered(tx, { courseId: row.courseId, now: outcome.at ?? row.dueAt });
            return true;
          case 'RETRY':
            await tx
              .update(notifications)
              .set({
                status: 'QUEUED',
                lockedUntil: null,
                dueAt: outcome.at,
                tries: row.tries + 1,
                lastError: outcome.error.slice(0, 60),
              })
              .where(eq(notifications.id, notificationId));
            return true;
          case 'SENT': {
            await tx
              .update(notifications)
              .set({ status: 'SENT', lockedUntil: null, sentAt: outcome.at, lastError: null })
              .where(eq(notifications.id, notificationId));
            if (row.kind !== 'DOSE_REMINDER') {
              return true;
            }
            // The dose has now been announced: SCHEDULED or SNOOZED becomes NOTIFIED.
            const [dose] = await tx
              .select()
              .from(scheduledDoses)
              .where(eq(scheduledDoses.id, row.scheduledDoseId))
              .for('update');
            if (dose?.status === 'SCHEDULED' || dose?.status === 'SNOOZED') {
              await tx
                .update(scheduledDoses)
                .set({ status: 'NOTIFIED' })
                .where(eq(scheduledDoses.id, dose.id));
            }
            if (dose !== undefined) {
              await tx
                .insert(doseEvents)
                .values({
                  id: randomUUID(),
                  scheduledDoseId: dose.id,
                  courseId: dose.courseId,
                  eventType: 'NOTIFIED',
                  actorKind: 'SYSTEM',
                  actorUserId: null,
                  source: 'SYSTEM',
                  idempotencyKey: `notified:${notificationId}`,
                  details: { attempt: row.attemptNo },
                  occurredAt: outcome.at,
                })
                .onConflictDoNothing({ target: doseEvents.idempotencyKey });
            }
            return true;
          }
        }
      });
    },
  };
}

export type OutboxRepository = ReturnType<typeof createOutboxRepository>;
