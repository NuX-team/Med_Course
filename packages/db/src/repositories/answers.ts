import { randomUUID } from 'node:crypto';
import {
  availableSnoozeOptions,
  classifyAnswer,
  correctionWindowEnd,
  isOverdue,
  type ReminderPolicy,
} from '@medcourse/schedule';
import { and, asc, count, desc, eq, gt, inArray, lte, max } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import { fieldAad } from '../field-cipher';
import type { Executor } from '../orm';
import {
  courseMedications,
  doseEvents,
  notifications,
  reminderPolicies,
  scheduledDoses,
  treatmentCourses,
  type DoseStatus,
} from '../schema';
import { noteNotTaken } from './alerts';
import type { RepositoryDeps } from './context';
import type { DoseUnit, FoodRule } from './plans';

export type SkipReason = 'FORGOT' | 'NO_MEDICATION' | 'OTHER';
export const MAX_SKIP_REASON_LENGTH = 300;

const UNRESOLVED: readonly DoseStatus[] = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'];
const SWEEP_BATCH = 200;

/** A dose as the patient is shown it after an answer. */
export interface DoseView {
  readonly doseId: string;
  readonly courseId: string;
  readonly timezone: string;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date;
  readonly status: DoseStatus;
  /** When the patient answered (taken, skipped, or taken late); null while there is no answer. */
  readonly answeredAt: Date | null;
  /** Until when the patient may take their own answer back; null when there is nothing to take back. */
  readonly correctableUntil: Date | null;
  readonly skipReason: SkipReason | null;
  /** A snoozed dose: when the reminder comes back. */
  readonly snoozedUntil: Date | null;
  /** The "later" choices on offer right now; empty unless the dose is waiting for an answer. */
  readonly snoozeOptions: readonly number[];
  readonly medication: {
    readonly displayName: string;
    readonly doseValue: string;
    readonly doseDisplay: string | null;
    readonly doseUnit: DoseUnit;
    readonly foodRule: FoodRule;
  };
}

export type AnswerOutcome =
  /** Not this patient's dose, no such dose, or the course is no longer running. */
  | { readonly result: 'NOT_AVAILABLE' }
  /** The answer was recorded. */
  | { readonly result: 'DONE'; readonly dose: DoseView }
  /** The dose already has this kind of outcome: a repeated tap changes nothing. */
  | { readonly result: 'ALREADY'; readonly dose: DoseView }
  /** More than an hour before the dose: treated as a mistap. */
  | { readonly result: 'TOO_EARLY'; readonly dose: DoseView }
  /** Past the deadline: the dose is a miss, and can only be marked as taken late. */
  | { readonly result: 'TOO_LATE'; readonly dose: DoseView }
  /** That "later" is not on offer (it would run past the deadline, or the limit is used up). */
  | { readonly result: 'SNOOZE_NOT_ALLOWED'; readonly dose: DoseView }
  /** The time to change the answer has passed. */
  | { readonly result: 'NOT_CORRECTABLE'; readonly dose: DoseView };

type DoseRow = typeof scheduledDoses.$inferSelect;

function requirePatient(actor: Actor): string {
  if (actor.kind !== 'PATIENT') {
    throw new ForbiddenError('only the patient answers for their own dose');
  }
  return actor.userId;
}

/**
 * What the patient does with a dose: took it, will take it later, skips it, or takes an answer
 * back (ARCHITECTURE §6.2). Every method works on the dose row under a lock, so two taps at
 * once, or a tap racing the sweeper, are settled one after the other and the second sees what
 * the first did. Nothing is ever edited in the event log: each change is a new event.
 */
export function createAnswerRepository(db: Executor, deps: RepositoryDeps) {
  const { cipher } = deps;

  const policyOf = async (tx: Executor, courseId: string): Promise<ReminderPolicy> => {
    const [row] = await tx
      .select()
      .from(reminderPolicies)
      .where(eq(reminderPolicies.courseId, courseId));
    if (row === undefined) {
      throw new Error('a course has no reminder policy');
    }
    return {
      attempts: row.attempts,
      retryIntervalMinutes: row.retryIntervalMinutes,
      missAfterMinutes: row.missAfterMinutes,
      snoozeOptionsMinutes: row.snoozeOptionsMinutes,
      maxSnoozes: row.maxSnoozes,
      correctionWindowMinutes: row.correctionWindowMinutes,
      leadMinutes: row.leadMinutes,
    };
  };

  /** The patient's own dose in a running course, locked. Null for anything else. */
  const lockDose = async (
    tx: Executor,
    actor: Actor,
    doseId: string,
  ): Promise<{ dose: DoseRow; timezone: string } | null> => {
    const patientId = requirePatient(actor);
    // The course is held still first: a pause, a cancellation or a change of plan waits for
    // this answer to finish, or this answer waits for it and then sees what it did.
    await tx
      .select({ id: treatmentCourses.id })
      .from(treatmentCourses)
      .innerJoin(scheduledDoses, eq(scheduledDoses.courseId, treatmentCourses.id))
      .where(eq(scheduledDoses.id, doseId))
      .for('share', { of: treatmentCourses });
    const [found] = await tx
      .select({ dose: scheduledDoses, timezone: treatmentCourses.timezone })
      .from(scheduledDoses)
      .innerJoin(treatmentCourses, eq(treatmentCourses.id, scheduledDoses.courseId))
      .where(
        and(
          eq(scheduledDoses.id, doseId),
          eq(treatmentCourses.patientId, patientId),
          eq(treatmentCourses.status, 'ACTIVE'),
          visibleCourses(actor),
        ),
      )
      .for('update', { of: scheduledDoses });
    if (found === undefined || found.dose.status === 'SUPERSEDED') {
      return null;
    }
    return found;
  };

  const viewOf = async (
    tx: Executor,
    dose: DoseRow,
    timezone: string,
    now: Date,
  ): Promise<DoseView> => {
    const [medication] = await tx
      .select({
        displayName: courseMedications.displayName,
        doseValue: courseMedications.doseValue,
        doseDisplay: courseMedications.doseDisplay,
        doseUnit: courseMedications.doseUnit,
        foodRule: courseMedications.foodRule,
      })
      .from(courseMedications)
      .where(eq(courseMedications.id, dose.medicationId));
    if (medication === undefined) {
      throw new Error('a dose has no medication');
    }
    const answered =
      dose.status === 'TAKEN' || dose.status === 'SKIPPED' || dose.status === 'TAKEN_LATE';
    const answeredAt = dose.status === 'TAKEN_LATE' ? dose.lateTakenAt : dose.finalizedAt;
    let skipReason: SkipReason | null = null;
    if (dose.status === 'SKIPPED') {
      const [event] = await tx
        .select({ reasonCode: doseEvents.reasonCode })
        .from(doseEvents)
        .where(and(eq(doseEvents.scheduledDoseId, dose.id), eq(doseEvents.eventType, 'SKIPPED')))
        .orderBy(desc(doseEvents.recordedAt), desc(doseEvents.occurredAt))
        .limit(1);
      skipReason = event?.reasonCode ?? null;
    }
    let snoozedUntil: Date | null = null;
    if (dose.status === 'SNOOZED') {
      const [next] = await tx
        .select({ dueAt: notifications.dueAt })
        .from(notifications)
        .where(
          and(
            eq(notifications.scheduledDoseId, dose.id),
            eq(notifications.kind, 'DOSE_REMINDER'),
            inArray(notifications.status, ['QUEUED', 'SENDING']),
          ),
        )
        .orderBy(asc(notifications.dueAt))
        .limit(1);
      snoozedUntil = next?.dueAt ?? null;
    }
    let snoozeOptions: number[] = [];
    if (
      (dose.status === 'SCHEDULED' || dose.status === 'NOTIFIED') &&
      !isOverdue(dose.deadlineAt, now)
    ) {
      const [used] = await tx
        .select({ used: count() })
        .from(doseEvents)
        .where(and(eq(doseEvents.scheduledDoseId, dose.id), eq(doseEvents.eventType, 'SNOOZED')));
      snoozeOptions = availableSnoozeOptions(
        { now, deadlineAt: dose.deadlineAt, snoozesUsed: used?.used ?? 0 },
        await policyOf(tx, dose.courseId),
      );
    }
    return {
      doseId: dose.id,
      courseId: dose.courseId,
      timezone,
      scheduledAt: dose.scheduledAt,
      deadlineAt: dose.deadlineAt,
      status: dose.status,
      answeredAt: answered ? answeredAt : null,
      correctableUntil:
        answered && answeredAt !== null
          ? correctionWindowEnd(answeredAt, await policyOf(tx, dose.courseId))
          : null,
      skipReason,
      snoozedUntil,
      snoozeOptions,
      medication,
    };
  };

  const addEvent = async (
    tx: Executor,
    actor: Actor,
    dose: DoseRow,
    event: {
      type: (typeof doseEvents.$inferInsert)['eventType'];
      at: Date;
      key: string;
      reasonCode?: SkipReason;
      reasonText?: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<void> => {
    const id = randomUUID();
    const system = actor.kind === 'SYSTEM';
    const text = event.reasonText?.trim() ?? '';
    await tx
      .insert(doseEvents)
      .values({
        id,
        scheduledDoseId: dose.id,
        courseId: dose.courseId,
        eventType: event.type,
        actorKind: actor.kind,
        actorUserId: actorUserId(actor),
        reasonCode: event.reasonCode ?? null,
        reasonTextEnc:
          text.length === 0
            ? null
            : cipher.encrypt(text, fieldAad('dose_events', 'reason_text_enc', id)),
        source: system ? 'SYSTEM' : 'TELEGRAM',
        idempotencyKey: event.key,
        details: event.details ?? null,
        occurredAt: event.at,
      })
      .onConflictDoNothing({ target: doseEvents.idempotencyKey });
  };

  /** Reminders still waiting for this dose are no longer wanted. */
  const cancelReminders = async (tx: Executor, doseId: string, upTo?: Date): Promise<void> => {
    await tx
      .update(notifications)
      .set({ status: 'CANCELLED', lastError: 'answered' })
      .where(
        and(
          eq(notifications.scheduledDoseId, doseId),
          eq(notifications.status, 'QUEUED'),
          upTo === undefined ? undefined : lte(notifications.dueAt, upTo),
        ),
      );
  };

  /**
   * The deadline has passed with no answer: the dose is a miss from the deadline itself, and
   * the doctor is to hear of it. `announce: false` is for the miss that is recorded only to be
   * followed, in the same breath, by the patient's late "took it".
   */
  const markMissed = async (tx: Executor, dose: DoseRow, announce = true): Promise<DoseRow> => {
    const [missed] = await tx
      .update(scheduledDoses)
      .set({ status: 'MISSED', missedAt: dose.deadlineAt, finalizedAt: dose.deadlineAt })
      .where(eq(scheduledDoses.id, dose.id))
      .returning();
    await addEvent(tx, { kind: 'SYSTEM', reason: 'deadline passed' }, dose, {
      type: 'MISSED',
      at: dose.deadlineAt,
      key: `missed:${dose.id}`,
    });
    await cancelReminders(tx, dose.id);
    if (announce) {
      await noteNotTaken(tx, { dose, kind: 'MISSED', now: dose.deadlineAt, key: 'deadline' });
    }
    return missed ?? dose;
  };

  return {
    /** The dose as it stands, for showing. Null if it is not this patient's. */
    async get(actor: Actor, doseId: string, now: Date): Promise<DoseView | null> {
      return db.transaction(async (tx) => {
        const found = await lockDose(tx, actor, doseId);
        return found === null ? null : viewOf(tx, found.dose, found.timezone, now);
      });
    },

    /**
     * "Took it". Before the deadline the dose becomes TAKEN. After it, the miss stands and the
     * dose becomes TAKEN_LATE next to it: a late tap never erases the fact that the deadline
     * passed (TZ §7.7). More than an hour ahead of the dose it is refused as a mistap.
     * `key` identifies the tap (the callback id), so a redelivered tap writes nothing twice.
     */
    async take(
      actor: Actor,
      input: { doseId: string; now: Date; key: string },
    ): Promise<AnswerOutcome> {
      return db.transaction(async (tx) => {
        const found = await lockDose(tx, actor, input.doseId);
        if (found === null) {
          return { result: 'NOT_AVAILABLE' };
        }
        let { dose } = found;
        const view = (row: DoseRow): Promise<DoseView> =>
          viewOf(tx, row, found.timezone, input.now);

        if (dose.status === 'TAKEN' || dose.status === 'TAKEN_LATE' || dose.status === 'SKIPPED') {
          return { result: 'ALREADY', dose: await view(dose) };
        }
        if (dose.status !== 'MISSED') {
          const timing = classifyAnswer({
            now: input.now,
            scheduledAt: dose.scheduledAt,
            deadlineAt: dose.deadlineAt,
          });
          if (timing === 'TOO_EARLY') {
            return { result: 'TOO_EARLY', dose: await view(dose) };
          }
          if (timing === 'ON_TIME') {
            const [taken] = await tx
              .update(scheduledDoses)
              .set({ status: 'TAKEN', finalizedAt: input.now })
              .where(eq(scheduledDoses.id, dose.id))
              .returning();
            await addEvent(tx, actor, dose, {
              type: 'TAKEN',
              at: input.now,
              key: `taken:${input.key}`,
              details: { from: dose.status },
            });
            await cancelReminders(tx, dose.id);
            return { result: 'DONE', dose: await view(taken ?? dose) };
          }
          // Past the deadline before the sweeper got here: the miss is recorded first.
          dose = await markMissed(tx, dose, false);
        }

        const [late] = await tx
          .update(scheduledDoses)
          .set({ status: 'TAKEN_LATE', lateTakenAt: input.now })
          .where(eq(scheduledDoses.id, dose.id))
          .returning();
        await addEvent(tx, actor, dose, {
          type: 'LATE_TAKEN',
          at: input.now,
          key: `late:${input.key}`,
        });
        return { result: 'DONE', dose: await view(late ?? dose) };
      });
    },

    /**
     * "Skip", with a reason and, for "other", optional words of the patient's own (encrypted).
     * Only before the deadline: after it the dose is already a miss.
     */
    async skip(
      actor: Actor,
      input: { doseId: string; now: Date; key: string; reason: SkipReason; text?: string | null },
    ): Promise<AnswerOutcome> {
      const text = input.text?.trim() ?? '';
      if (Array.from(text).length > MAX_SKIP_REASON_LENGTH) {
        throw new RangeError('the reason is too long');
      }
      if (text.length > 0 && input.reason !== 'OTHER') {
        throw new RangeError('only "other" takes words of its own');
      }
      return db.transaction(async (tx) => {
        const found = await lockDose(tx, actor, input.doseId);
        if (found === null) {
          return { result: 'NOT_AVAILABLE' };
        }
        const { dose } = found;
        const view = (row: DoseRow): Promise<DoseView> =>
          viewOf(tx, row, found.timezone, input.now);

        if (dose.status === 'TAKEN' || dose.status === 'TAKEN_LATE' || dose.status === 'SKIPPED') {
          return { result: 'ALREADY', dose: await view(dose) };
        }
        if (dose.status === 'MISSED' || isOverdue(dose.deadlineAt, input.now)) {
          const missed = dose.status === 'MISSED' ? dose : await markMissed(tx, dose);
          return { result: 'TOO_LATE', dose: await view(missed) };
        }
        const [skipped] = await tx
          .update(scheduledDoses)
          .set({ status: 'SKIPPED', finalizedAt: input.now })
          .where(eq(scheduledDoses.id, dose.id))
          .returning();
        await addEvent(tx, actor, dose, {
          type: 'SKIPPED',
          at: input.now,
          key: `skipped:${input.key}`,
          reasonCode: input.reason,
          reasonText: text,
          details: { from: dose.status },
        });
        await cancelReminders(tx, dose.id);
        await noteNotTaken(tx, { dose, kind: 'SKIPPED', now: input.now, key: input.key });
        return { result: 'DONE', dose: await view(skipped ?? dose) };
      });
    },

    /**
     * "Later": the reminder comes back in `minutes`. Only the choices that still land before the
     * deadline are allowed, and only so many times per dose; an impossible choice is refused,
     * never quietly shortened (TZ §7.9). The planned time of the dose does not move.
     */
    async snooze(
      actor: Actor,
      input: { doseId: string; now: Date; key: string; minutes: number },
    ): Promise<AnswerOutcome> {
      return db.transaction(async (tx) => {
        const found = await lockDose(tx, actor, input.doseId);
        if (found === null) {
          return { result: 'NOT_AVAILABLE' };
        }
        const { dose } = found;
        const view = (row: DoseRow): Promise<DoseView> =>
          viewOf(tx, row, found.timezone, input.now);

        if (!UNRESOLVED.includes(dose.status)) {
          return {
            result: dose.status === 'MISSED' ? 'TOO_LATE' : 'ALREADY',
            dose: await view(dose),
          };
        }
        if (isOverdue(dose.deadlineAt, input.now)) {
          return { result: 'TOO_LATE', dose: await view(await markMissed(tx, dose)) };
        }
        // A second tap on "later" while the first is still pending adds nothing.
        if (dose.status === 'SNOOZED') {
          return { result: 'ALREADY', dose: await view(dose) };
        }

        const policy = await policyOf(tx, dose.courseId);
        const [used] = await tx
          .select({ used: count() })
          .from(doseEvents)
          .where(and(eq(doseEvents.scheduledDoseId, dose.id), eq(doseEvents.eventType, 'SNOOZED')));
        const options = availableSnoozeOptions(
          { now: input.now, deadlineAt: dose.deadlineAt, snoozesUsed: used?.used ?? 0 },
          policy,
        );
        if (!options.includes(input.minutes)) {
          return { result: 'SNOOZE_NOT_ALLOWED', dose: await view(dose) };
        }

        const until = new Date(input.now.getTime() + input.minutes * 60_000);
        // Reminders that would fire before the chosen moment are replaced by one at that moment;
        // the ones planned for later still stand.
        await cancelReminders(tx, dose.id, until);
        const [last] = await tx
          .select({ attemptNo: max(notifications.attemptNo) })
          .from(notifications)
          .where(
            and(
              eq(notifications.scheduledDoseId, dose.id),
              eq(notifications.kind, 'DOSE_REMINDER'),
            ),
          );
        const [course] = await tx
          .select({ patientId: treatmentCourses.patientId })
          .from(treatmentCourses)
          .where(eq(treatmentCourses.id, dose.courseId));
        await tx.insert(notifications).values({
          courseId: dose.courseId,
          scheduledDoseId: dose.id,
          recipientUserId: course?.patientId ?? requirePatient(actor),
          kind: 'DOSE_REMINDER',
          attemptNo: (last?.attemptNo ?? 0) + 1,
          dueAt: until,
        });
        const [snoozed] = await tx
          .update(scheduledDoses)
          .set({ status: 'SNOOZED' })
          .where(eq(scheduledDoses.id, dose.id))
          .returning();
        await addEvent(tx, actor, dose, {
          type: 'SNOOZED',
          at: input.now,
          key: `snoozed:${input.key}`,
          details: { minutes: input.minutes },
        });
        return { result: 'DONE', dose: await view(snoozed ?? dose) };
      });
    },

    /**
     * The patient takes their own answer back, within the correction window (TZ §5.3). The
     * answer stays in the log and a CORRECTION event is added. The dose goes back to waiting
     * for an answer, with its remaining reminders restored, or to a miss if its deadline has
     * passed meanwhile; a late "took it" goes back to the miss it was.
     */
    async undo(
      actor: Actor,
      input: { doseId: string; now: Date; key: string },
    ): Promise<AnswerOutcome> {
      return db.transaction(async (tx) => {
        const found = await lockDose(tx, actor, input.doseId);
        if (found === null) {
          return { result: 'NOT_AVAILABLE' };
        }
        const { dose } = found;
        const view = (row: DoseRow): Promise<DoseView> =>
          viewOf(tx, row, found.timezone, input.now);
        if (dose.status !== 'TAKEN' && dose.status !== 'SKIPPED' && dose.status !== 'TAKEN_LATE') {
          return { result: 'ALREADY', dose: await view(dose) };
        }

        const answeredAt = dose.status === 'TAKEN_LATE' ? dose.lateTakenAt : dose.finalizedAt;
        const policy = await policyOf(tx, dose.courseId);
        if (answeredAt === null || input.now > correctionWindowEnd(answeredAt, policy)) {
          return { result: 'NOT_CORRECTABLE', dose: await view(dose) };
        }

        const overdue = isOverdue(dose.deadlineAt, input.now);
        const [reverted] = await tx
          .update(scheduledDoses)
          .set(
            dose.status === 'TAKEN_LATE'
              ? { status: 'MISSED', lateTakenAt: null }
              : overdue
                ? { status: 'MISSED', missedAt: dose.deadlineAt, finalizedAt: dose.deadlineAt }
                : { status: 'NOTIFIED', finalizedAt: null },
          )
          .where(eq(scheduledDoses.id, dose.id))
          .returning();
        await addEvent(tx, actor, dose, {
          type: 'CORRECTION',
          at: input.now,
          key: `correction:${input.key}`,
          details: { from: dose.status, to: reverted?.status ?? dose.status },
        });
        if (dose.status !== 'TAKEN_LATE' && overdue) {
          await addEvent(tx, { kind: 'SYSTEM', reason: 'deadline passed' }, dose, {
            type: 'MISSED',
            at: dose.deadlineAt,
            key: `missed:${dose.id}`,
          });
          // An answer taken back after the deadline leaves a miss the doctor has not heard of.
          await noteNotTaken(tx, { dose, kind: 'MISSED', now: input.now, key: 'deadline' });
        }
        if (reverted?.status === 'NOTIFIED') {
          // The reminders the answer had cancelled, and that are still ahead, are wanted again.
          await tx
            .update(notifications)
            .set({ status: 'QUEUED', lastError: null })
            .where(
              and(
                eq(notifications.scheduledDoseId, dose.id),
                eq(notifications.status, 'CANCELLED'),
                eq(notifications.kind, 'DOSE_REMINDER'),
                gt(notifications.dueAt, input.now),
              ),
            );
        }
        return { result: 'DONE', dose: await view(reverted ?? dose) };
      });
    },

    /**
     * Doses of running courses whose deadline has passed with no answer become MISSED, as of the
     * deadline itself rather than of whenever this runs. System only; returns how many.
     */
    async sweepMissed(actor: Actor, now: Date): Promise<number> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system marks doses as missed');
      }
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ dose: scheduledDoses })
          .from(scheduledDoses)
          .innerJoin(treatmentCourses, eq(treatmentCourses.id, scheduledDoses.courseId))
          .where(
            and(
              lte(scheduledDoses.deadlineAt, now),
              inArray(scheduledDoses.status, [...UNRESOLVED]),
              eq(treatmentCourses.status, 'ACTIVE'),
            ),
          )
          .orderBy(asc(scheduledDoses.deadlineAt))
          .limit(SWEEP_BATCH)
          .for('update', { of: scheduledDoses, skipLocked: true });
        for (const { dose } of due) {
          await markMissed(tx, dose);
        }
        return due.length;
      });
    },
  };
}

export type AnswerRepository = ReturnType<typeof createAnswerRepository>;
