import { randomUUID } from 'node:crypto';
import {
  attemptTimes,
  deadlineAt,
  leadReminderAt,
  planRetire,
  type CourseTimeline,
  type MedicationInput,
  type Pause,
  type ReminderPolicy,
  type Slot,
} from '@medcourse/schedule';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { activeUser, usableClinician } from '../access/scopes';
import type { Executor } from '../orm';
import {
  careRelationships,
  coursePauses,
  doseEvents,
  notifications,
  reminderPolicies,
  scheduledDoses,
  users,
  type courseMedications,
} from '../schema';
import { noteNotTaken } from './alerts';
import type { Course } from './courses';

/** Rows per INSERT when doses are laid out: well inside the driver's parameter limit. */
const INSERT_CHUNK = 500;

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function policyOf(executor: Executor, courseId: string): Promise<ReminderPolicy> {
  const [row] = await executor
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
}

/** Every stretch the course has been on hold, oldest first; the last one may still be open. */
export async function pausesOf(executor: Executor, courseId: string): Promise<Pause[]> {
  const rows = await executor
    .select({ from: coursePauses.pausedAt, to: coursePauses.resumedAt })
    .from(coursePauses)
    .where(eq(coursePauses.courseId, courseId))
    .orderBy(asc(coursePauses.pausedAt));
  return rows;
}

/** Where a started course sits on the calendar, pauses included. Null before it has started. */
export function timelineOf(course: Course, pauses: readonly Pause[]): CourseTimeline | null {
  return course.effectiveStartDate === null
    ? null
    : {
        effectiveStartDate: course.effectiveStartDate,
        timezone: course.timezone,
        durationDays: course.durationDays,
        pauses,
      };
}

export function toMedicationInputs(
  medications: readonly {
    row: typeof courseMedications.$inferSelect;
    rules: MedicationInput['rules'];
  }[],
): MedicationInput[] {
  return medications.map(({ row, rules }) => ({
    id: row.id,
    lineId: row.lineId,
    prn: row.prn,
    maxDailyDoses: row.maxDailyDoses,
    minimumIntervalMinutes: row.minimumIntervalMinutes,
    activeFromDay: row.activeFromDay,
    activeToDay: row.activeToDay,
    rules,
  }));
}

/**
 * Turns slots into doses to take and reminders to send, each reminder with the moment it is due
 * already worked out (ARCHITECTURE §5.2). Used when a course starts, when it resumes and when
 * its plan is replaced; the caller has already decided which slots those are.
 */
export async function layOutDoses(
  tx: Executor,
  input: {
    courseId: string;
    revisionId: string;
    patientId: string;
    slots: readonly Slot[];
    now: Date;
  },
): Promise<void> {
  const { courseId, revisionId, now } = input;
  if (input.slots.length === 0) {
    return;
  }
  const policy = await policyOf(tx, courseId);
  const doses = input.slots.map((slot) => ({
    id: randomUUID(),
    courseId,
    revisionId,
    medicationId: slot.medicationId,
    medicationLineId: slot.medicationLineId,
    scheduleRuleId: slot.ruleId,
    scheduledAt: slot.scheduledAt,
    deadlineAt: deadlineAt(slot.scheduledAt, policy),
  }));
  for (const chunk of chunked(doses, INSERT_CHUNK)) {
    await tx.insert(scheduledDoses).values(chunk);
  }

  const reminders = doses.flatMap((dose) => {
    const lead = leadReminderAt(dose.scheduledAt, policy);
    return [
      ...(lead !== null && lead > now
        ? [{ kind: 'DOSE_LEAD' as const, attemptNo: 1, dueAt: lead }]
        : []),
      ...attemptTimes(dose.scheduledAt, policy).map((dueAt, index) => ({
        kind: 'DOSE_REMINDER' as const,
        attemptNo: index + 1,
        dueAt,
      })),
    ].map((reminder) => ({
      ...reminder,
      courseId,
      scheduledDoseId: dose.id,
      recipientUserId: input.patientId,
    }));
  });
  for (const chunk of chunked(reminders, INSERT_CHUNK)) {
    await tx.insert(notifications).values(chunk);
  }
}

/** Why the doses of a course stopped applying. Stored on the reminders it cancels. */
export type RetireReason = 'paused' | 'cancelled' | 'plan changed';

/**
 * Takes everything still open out of a course, as of `now` (ARCHITECTURE §5.4, §5.5): an open
 * dose past its deadline is recorded as the miss it already was, every other open dose is
 * superseded, and every reminder still waiting is cancelled, the ones a worker has already
 * taken from the queue included. Doses with an outcome are not touched.
 *
 * The open doses are locked first, so an answer racing this is settled one way or the other:
 * either it got in and the dose keeps its outcome, or it finds the dose gone.
 */
export async function retireOpenDoses(
  tx: Executor,
  input: { courseId: string; now: Date; reason: RetireReason; actor: Actor; key: string },
): Promise<{ superseded: number; missed: number }> {
  const { courseId, now, actor } = input;
  const open = await tx
    .select()
    .from(scheduledDoses)
    .where(
      and(
        eq(scheduledDoses.courseId, courseId),
        inArray(scheduledDoses.status, ['SCHEDULED', 'NOTIFIED', 'SNOOZED']),
      ),
    )
    .orderBy(asc(scheduledDoses.scheduledAt), asc(scheduledDoses.id))
    .for('update');
  const plan = planRetire({ existing: open, now });
  const byId = new Map(open.map((dose) => [dose.id, dose]));

  for (const ids of chunked(plan.supersede, INSERT_CHUNK)) {
    await tx
      .update(scheduledDoses)
      .set({ status: 'SUPERSEDED' })
      .where(inArray(scheduledDoses.id, ids));
    await tx.insert(doseEvents).values(
      ids.map((id) => ({
        scheduledDoseId: id,
        courseId,
        eventType: 'SUPERSEDED' as const,
        actorKind: actor.kind,
        actorUserId: actorUserId(actor),
        source: actor.kind === 'SYSTEM' ? ('SYSTEM' as const) : ('TELEGRAM' as const),
        idempotencyKey: `superseded:${id}`,
        details: { reason: input.reason, from: byId.get(id)?.status ?? null, request: input.key },
        occurredAt: now,
      })),
    );
  }

  for (const id of plan.miss) {
    const dose = byId.get(id);
    if (dose === undefined) {
      continue;
    }
    // Dated at the deadline, exactly as the sweeper would have recorded it.
    await tx
      .update(scheduledDoses)
      .set({ status: 'MISSED', missedAt: dose.deadlineAt, finalizedAt: dose.deadlineAt })
      .where(eq(scheduledDoses.id, id));
    await tx
      .insert(doseEvents)
      .values({
        scheduledDoseId: id,
        courseId,
        eventType: 'MISSED',
        actorKind: 'SYSTEM',
        actorUserId: null,
        source: 'SYSTEM',
        idempotencyKey: `missed:${id}`,
        occurredAt: dose.deadlineAt,
      })
      .onConflictDoNothing({ target: doseEvents.idempotencyKey });
    await noteNotTaken(tx, { dose, kind: 'MISSED', now: dose.deadlineAt, key: 'deadline' });
  }

  // Nothing open is left, so no reminder of this course is wanted any more.
  await tx
    .update(notifications)
    .set({ status: 'CANCELLED', lockedUntil: null, lastError: input.reason })
    .where(
      and(
        eq(notifications.courseId, courseId),
        inArray(notifications.status, ['QUEUED', 'SENDING']),
      ),
    );

  return { superseded: plan.supersede.length, missed: plan.miss.length };
}

/**
 * A prescription is only as good as its author's standing on the day it takes effect: the
 * doctor is still verified, their practice is not suspended, and the relationship has not ended.
 */
export async function prescriberInStanding(executor: Executor, course: Course): Promise<boolean> {
  const standing = await executor.execute<{ ok: boolean }>(sql`
    select (
      ${activeUser(course.clinicianId)}
      and ${usableClinician(course.clinicianId)}
      and exists (
        select 1 from ${careRelationships}
        where ${careRelationships.id} = ${course.careRelationshipId}
          and ${careRelationships.status} = 'ACTIVE'
      )
    ) as ok`);
  return standing[0]?.ok === true;
}

/** Who a message about a course goes to. Null if the account is closed or blocked. */
export interface Recipient {
  readonly telegramUserId: number;
  readonly locale: 'ru' | 'uz';
}

export async function recipientOf(executor: Executor, userId: string): Promise<Recipient | null> {
  const [user] = await executor
    .select({ telegramUserId: users.telegramUserId, locale: users.locale })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'ACTIVE')));
  return user ?? null;
}
