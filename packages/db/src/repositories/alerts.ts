import {
  missAlertFor,
  momentOutcome,
  nextDigestAt,
  notTakenRun,
  prnCheck,
  type Moment,
} from '@medcourse/schedule';
import { and, asc, desc, eq, inArray, isNull, lt, lte, max, ne, or, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import {
  courseMedications,
  doctorAlerts,
  doseEvents,
  patientProfiles,
  scheduledDoses,
  treatmentCourses,
  users,
  type CourseStatus,
  type DoseStatus,
} from '../schema';
import type { SkipReason } from './answers';
import { noteIncident } from './incidents';
import type { ReminderOutcome } from './outbox';
import type { DoseUnit, FoodRule } from './plans';

export type DoctorAlertKind = (typeof doctorAlerts.$inferSelect)['kind'];

/** How many moments back a run is looked for when deciding: far more than the run that matters. */
const RUN_LOOKBACK = 12;
/** How far back a run is measured for the doctor to read. Longer runs are shown as this many. */
export const RUN_REPORT_LIMIT = 100;
const DAY_MS = 86_400_000;

type DoseRow = typeof scheduledDoses.$inferSelect;
type DatedMoment = Moment & { readonly scheduledAt: Date };

/** The moments of a course up to and including `until`, newest first, with what became of each. */
async function momentsUpTo(
  tx: Executor,
  courseId: string,
  until: Date,
  limit = RUN_LOOKBACK,
): Promise<DatedMoment[]> {
  const rows = await tx
    .select({
      scheduledAt: scheduledDoses.scheduledAt,
      statuses: sql<DoseStatus[]>`array_agg(${scheduledDoses.status})`,
    })
    .from(scheduledDoses)
    .where(
      and(
        eq(scheduledDoses.courseId, courseId),
        ne(scheduledDoses.status, 'SUPERSEDED'),
        lte(scheduledDoses.scheduledAt, until),
      ),
    )
    .groupBy(scheduledDoses.scheduledAt)
    .orderBy(desc(scheduledDoses.scheduledAt))
    .limit(limit);
  return rows;
}

/** The current run of not-taken moments and the moment it began at. */
function runOf(moments: readonly DatedMoment[]): { run: number; since: Date | null } {
  const run = notTakenRun(moments);
  let counted = 0;
  let since: Date | null = null;
  for (const moment of moments) {
    if (counted === run) {
      break;
    }
    if (momentOutcome(moment) === 'NOT_TAKEN') {
      counted += 1;
      since = moment.scheduledAt;
    }
  }
  return { run, since };
}

/**
 * A dose has just been missed or skipped: queue what the doctor is to be told, in the same
 * transaction as the fact itself. The first two moments in a row get a message each; the third
 * gets one escalation; beyond that there is only a summary, at most one per six hours (D-13).
 * Called again for another drug of the same moment, it adds nothing.
 */
export async function noteNotTaken(
  tx: Executor,
  input: {
    dose: Pick<DoseRow, 'id' | 'courseId' | 'scheduledAt'>;
    kind: 'MISSED' | 'SKIPPED';
    now: Date;
    /** Tells one skip of a dose from a later one (after the first was taken back). */
    key: string;
  },
): Promise<void> {
  const { dose, now } = input;
  const [course] = await tx
    .select({ clinicianId: treatmentCourses.clinicianId })
    .from(treatmentCourses)
    .where(eq(treatmentCourses.id, dose.courseId));
  if (course === undefined) {
    return;
  }
  const slot = dose.scheduledAt.toISOString();
  const alert = missAlertFor(notTakenRun(await momentsUpTo(tx, dose.courseId, dose.scheduledAt)));
  if (alert === null) {
    return;
  }
  const base = { courseId: dose.courseId, recipientUserId: course.clinicianId };

  let row: typeof doctorAlerts.$inferInsert;
  if (alert === 'INDIVIDUAL') {
    row =
      input.kind === 'SKIPPED'
        ? {
            ...base,
            kind: 'SKIPPED',
            scheduledDoseId: dose.id,
            dedupeKey: `skipped:${dose.id}:${input.key}`.slice(0, 200),
            dueAt: now,
          }
        : {
            ...base,
            kind: 'MISSED',
            slotAt: dose.scheduledAt,
            dedupeKey: `missed:${dose.courseId}:${slot}`,
            dueAt: now,
          };
  } else if (alert === 'SERIES') {
    row = {
      ...base,
      kind: 'SERIES',
      slotAt: dose.scheduledAt,
      dedupeKey: `series:${dose.courseId}:${slot}`,
      dueAt: now,
    };
  } else {
    const [waiting] = await tx
      .select({ id: doctorAlerts.id })
      .from(doctorAlerts)
      .where(
        and(
          eq(doctorAlerts.courseId, dose.courseId),
          eq(doctorAlerts.kind, 'DIGEST'),
          inArray(doctorAlerts.status, ['QUEUED', 'SENDING']),
        ),
      )
      .limit(1);
    if (waiting !== undefined) {
      // The summary already on its way will count this one too.
      return;
    }
    const [last] = await tx
      .select({ at: max(doctorAlerts.dueAt) })
      .from(doctorAlerts)
      .where(
        and(
          eq(doctorAlerts.courseId, dose.courseId),
          inArray(doctorAlerts.kind, ['SERIES', 'DIGEST']),
          ne(doctorAlerts.status, 'CANCELLED'),
        ),
      );
    const since = last?.at ?? null;
    const dueAt = nextDigestAt(now, since);
    row = {
      ...base,
      kind: 'DIGEST',
      // What it counts from: the escalation (or the summary) before it.
      slotAt: since ?? dose.scheduledAt,
      dedupeKey: `digest:${dose.courseId}:${dueAt.toISOString()}`,
      dueAt,
    };
  }
  await tx.insert(doctorAlerts).values(row).onConflictDoNothing({ target: doctorAlerts.dedupeKey });
  if (alert === 'SERIES') {
    // The same fact for the clinic's own staff: somebody may need to call the patient (D-18).
    await noteIncident(tx, {
      kind: 'OPERATIONAL',
      type: 'MISS_SERIES',
      courseId: dose.courseId,
      dedupeKey: `series:${dose.courseId}:${slot}`,
      now,
    });
  }
}

/** A reminder could not be delivered and never will be: the doctor is told once a day per course. */
export async function noteUndelivered(
  tx: Executor,
  input: { courseId: string; now: Date },
): Promise<void> {
  const [course] = await tx
    .select({ clinicianId: treatmentCourses.clinicianId })
    .from(treatmentCourses)
    .where(eq(treatmentCourses.id, input.courseId));
  if (course === undefined) {
    return;
  }
  await tx
    .insert(doctorAlerts)
    .values({
      courseId: input.courseId,
      recipientUserId: course.clinicianId,
      kind: 'UNDELIVERED',
      dedupeKey: `undelivered:${input.courseId}:${input.now.toISOString().slice(0, 10)}`,
      dueAt: input.now,
    })
    .onConflictDoNothing({ target: doctorAlerts.dedupeKey });
  await noteIncident(tx, {
    kind: 'OPERATIONAL',
    type: 'UNDELIVERED',
    courseId: input.courseId,
    dedupeKey: `undelivered:${input.courseId}:${input.now.toISOString().slice(0, 10)}`,
    now: input.now,
  });
}

/** An as-needed mark went beyond what the doctor allowed: the doctor is told of that mark. */
export async function notePrnOver(
  tx: Executor,
  input: { courseId: string; medicationLineId: string; eventId: string; now: Date },
): Promise<void> {
  const [course] = await tx
    .select({ clinicianId: treatmentCourses.clinicianId })
    .from(treatmentCourses)
    .where(eq(treatmentCourses.id, input.courseId));
  if (course === undefined) {
    return;
  }
  await tx
    .insert(doctorAlerts)
    .values({
      courseId: input.courseId,
      recipientUserId: course.clinicianId,
      kind: 'PRN_OVER',
      medicationLineId: input.medicationLineId,
      // The moment of the mark: what the count is taken up to when the message is sent.
      slotAt: input.now,
      dedupeKey: `prn:${input.eventId}`,
      dueAt: input.now,
    })
    .onConflictDoNothing({ target: doctorAlerts.dedupeKey });
}

export interface AlertDose {
  readonly scheduledAt: Date;
  readonly status: DoseStatus;
  readonly displayName: string;
  readonly doseValue: string;
  readonly doseDisplay: string | null;
  readonly doseUnit: DoseUnit;
  readonly foodRule: FoodRule;
  /** Why the patient skipped it, if they did. Never their own words: those stay in the history. */
  readonly skipReason: SkipReason | null;
}

/** An alert taken from the queue, with what is true about its subject right now. */
export interface DueAlert {
  readonly alertId: string;
  readonly kind: DoctorAlertKind;
  readonly tries: number;
  readonly dueAt: Date;
  readonly courseId: string;
  readonly courseStatus: CourseStatus;
  readonly timezone: string;
  readonly patient: { readonly firstName: string; readonly lastName: string };
  readonly recipient: {
    readonly telegramUserId: number;
    readonly locale: 'ru' | 'uz';
    /** Still this course's doctor in good standing, with an open account. */
    readonly entitled: boolean;
  };
  readonly slotAt: Date | null;
  /** MISSED: the doses of that moment still missed. SKIPPED: the dose, if still skipped. */
  readonly doses: readonly AlertDose[];
  /**
   * How many moments in a row were not taken: for SERIES up to the moment that made it three,
   * for DIGEST up to now. Zero for the other kinds.
   */
  readonly run: number;
  /** The first moment of that run. */
  readonly runSince: Date | null;
  /** PRN_OVER: the drug, the doctor's limits, and the marks standing in the day before the mark. */
  readonly prn: {
    readonly displayName: string;
    readonly maxDailyDoses: number;
    readonly minimumIntervalMinutes: number;
    readonly takenInDay: number;
    /** False once the mark has been taken back and what is left is within the limits. */
    readonly stillOver: boolean;
  } | null;
}

export type PauseRequestResult =
  | { readonly status: 'NOT_AVAILABLE' }
  /** Asked already today: the doctor is not written to again. */
  | { readonly status: 'ALREADY' }
  | { readonly status: 'REQUESTED' };

function requireSystem(actor: Actor): void {
  if (actor.kind !== 'SYSTEM') {
    throw new ForbiddenError('only the system works the alert queue');
  }
}

/**
 * What a doctor is told about their courses, as a queue the worker sends from (ARCHITECTURE §8).
 * Built like the reminder queue: rows are taken with `FOR UPDATE SKIP LOCKED` and a lock that
 * expires, so an alert is sent at least once and never silently lost.
 */
export function createAlertRepository(db: Executor) {
  const skipReasonOf = async (tx: Executor, doseId: string): Promise<SkipReason | null> => {
    const [event] = await tx
      .select({ reasonCode: doseEvents.reasonCode })
      .from(doseEvents)
      .where(and(eq(doseEvents.scheduledDoseId, doseId), eq(doseEvents.eventType, 'SKIPPED')))
      .orderBy(desc(doseEvents.recordedAt), desc(doseEvents.occurredAt))
      .limit(1);
    return event?.reasonCode ?? null;
  };

  const dosesOf = async (
    tx: Executor,
    alert: typeof doctorAlerts.$inferSelect,
  ): Promise<AlertDose[]> => {
    const which =
      alert.kind === 'SKIPPED' && alert.scheduledDoseId !== null
        ? and(eq(scheduledDoses.id, alert.scheduledDoseId), eq(scheduledDoses.status, 'SKIPPED'))
        : alert.kind === 'MISSED' && alert.slotAt !== null
          ? and(
              eq(scheduledDoses.courseId, alert.courseId),
              eq(scheduledDoses.scheduledAt, alert.slotAt),
              eq(scheduledDoses.status, 'MISSED'),
            )
          : null;
    if (which === null) {
      return [];
    }
    const rows = await tx
      .select({
        id: scheduledDoses.id,
        scheduledAt: scheduledDoses.scheduledAt,
        status: scheduledDoses.status,
        displayName: courseMedications.displayName,
        doseValue: courseMedications.doseValue,
        doseDisplay: courseMedications.doseDisplay,
        doseUnit: courseMedications.doseUnit,
        foodRule: courseMedications.foodRule,
      })
      .from(scheduledDoses)
      .innerJoin(courseMedications, eq(courseMedications.id, scheduledDoses.medicationId))
      .where(which)
      .orderBy(asc(courseMedications.displayName));
    const doses: AlertDose[] = [];
    for (const { id, ...dose } of rows) {
      doses.push({
        ...dose,
        skipReason: dose.status === 'SKIPPED' ? await skipReasonOf(tx, id) : null,
      });
    }
    return doses;
  };

  const prnOf = async (
    tx: Executor,
    alert: typeof doctorAlerts.$inferSelect,
  ): Promise<DueAlert['prn']> => {
    if (alert.kind !== 'PRN_OVER' || alert.medicationLineId === null || alert.slotAt === null) {
      return null;
    }
    const [medication] = await tx
      .select({
        displayName: courseMedications.displayName,
        maxDailyDoses: courseMedications.maxDailyDoses,
        minimumIntervalMinutes: courseMedications.minimumIntervalMinutes,
      })
      .from(courseMedications)
      .innerJoin(
        treatmentCourses,
        eq(treatmentCourses.currentRevisionId, courseMedications.revisionId),
      )
      .where(
        and(
          eq(treatmentCourses.id, alert.courseId),
          eq(courseMedications.lineId, alert.medicationLineId),
        ),
      );
    if (medication?.maxDailyDoses == null || medication.minimumIntervalMinutes === null) {
      return null;
    }
    const marks = await standingPrnMarks(tx, {
      courseId: alert.courseId,
      medicationLineId: alert.medicationLineId,
      from: new Date(alert.slotAt.getTime() - DAY_MS),
      to: alert.slotAt,
    });
    const last = marks.at(-1);
    const rule = {
      maxDailyDoses: medication.maxDailyDoses,
      minimumIntervalMinutes: medication.minimumIntervalMinutes,
    };
    return {
      displayName: medication.displayName,
      ...rule,
      takenInDay: marks.length,
      stillOver:
        last !== undefined &&
        prnCheck({ recent: marks.slice(0, -1).map((mark) => mark.at), ...rule }, last.at).excess !==
          null,
    };
  };

  return {
    /** Up to `limit` alerts that are due (or stuck), at most one per doctor per round. */
    async claimDue(
      actor: Actor,
      input: { now: Date; limit: number; lockMs: number },
    ): Promise<DueAlert[]> {
      requireSystem(actor);
      const { now } = input;
      return db.transaction(async (tx) => {
        const candidates = await tx
          .select({ id: doctorAlerts.id, recipientUserId: doctorAlerts.recipientUserId })
          .from(doctorAlerts)
          .where(
            or(
              and(eq(doctorAlerts.status, 'QUEUED'), lte(doctorAlerts.dueAt, now)),
              and(eq(doctorAlerts.status, 'SENDING'), lt(doctorAlerts.lockedUntil, now)),
            ),
          )
          .orderBy(asc(doctorAlerts.dueAt), asc(doctorAlerts.createdAt))
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
          .update(doctorAlerts)
          .set({ status: 'SENDING', lockedUntil: new Date(now.getTime() + input.lockMs) })
          .where(inArray(doctorAlerts.id, chosen));

        const rows = await tx
          .select({
            alert: doctorAlerts,
            courseStatus: treatmentCourses.status,
            timezone: treatmentCourses.timezone,
            firstName: patientProfiles.firstName,
            lastName: patientProfiles.lastName,
            telegramUserId: users.telegramUserId,
            locale: users.locale,
          })
          .from(doctorAlerts)
          .innerJoin(treatmentCourses, eq(treatmentCourses.id, doctorAlerts.courseId))
          .innerJoin(patientProfiles, eq(patientProfiles.userId, treatmentCourses.patientId))
          .innerJoin(users, eq(users.id, doctorAlerts.recipientUserId))
          .where(inArray(doctorAlerts.id, chosen))
          .orderBy(asc(doctorAlerts.dueAt), asc(doctorAlerts.createdAt));

        const due: DueAlert[] = [];
        for (const row of rows) {
          const { alert } = row;
          // Whoever was the doctor when the alert was written must still be one now.
          const [entitled] = await tx
            .select({ id: treatmentCourses.id })
            .from(treatmentCourses)
            .where(
              and(
                eq(treatmentCourses.id, alert.courseId),
                visibleCourses({ kind: 'CLINICIAN', userId: alert.recipientUserId }),
              ),
            );
          const { run, since } =
            alert.kind === 'SERIES' && alert.slotAt !== null
              ? runOf(await momentsUpTo(tx, alert.courseId, alert.slotAt, RUN_REPORT_LIMIT))
              : alert.kind === 'DIGEST'
                ? runOf(await momentsUpTo(tx, alert.courseId, now, RUN_REPORT_LIMIT))
                : { run: 0, since: null };
          due.push({
            alertId: alert.id,
            kind: alert.kind,
            tries: alert.tries,
            dueAt: alert.dueAt,
            courseId: alert.courseId,
            courseStatus: row.courseStatus,
            timezone: row.timezone,
            patient: { firstName: row.firstName, lastName: row.lastName },
            recipient: {
              telegramUserId: row.telegramUserId,
              locale: row.locale,
              entitled: entitled !== undefined,
            },
            slotAt: alert.slotAt,
            doses: await dosesOf(tx, alert),
            run,
            runSince: since,
            prn: await prnOf(tx, alert),
          });
        }
        return due;
      });
    },

    /** Records what happened to a claimed alert; only a row still SENDING is touched. */
    async finish(actor: Actor, alertId: string, outcome: ReminderOutcome): Promise<boolean> {
      requireSystem(actor);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(doctorAlerts)
          .where(and(eq(doctorAlerts.id, alertId), eq(doctorAlerts.status, 'SENDING')))
          .for('update');
        if (row === undefined) {
          return false;
        }
        const set =
          outcome.status === 'SENT'
            ? { status: 'SENT' as const, sentAt: outcome.at, lockedUntil: null, lastError: null }
            : outcome.status === 'CANCELLED'
              ? {
                  status: 'CANCELLED' as const,
                  lockedUntil: null,
                  lastError: outcome.reason.slice(0, 60),
                }
              : outcome.status === 'FAILED'
                ? {
                    status: 'FAILED' as const,
                    lockedUntil: null,
                    tries: row.tries + 1,
                    lastError: outcome.error.slice(0, 60),
                  }
                : {
                    status: 'QUEUED' as const,
                    lockedUntil: null,
                    dueAt: outcome.at,
                    tries: row.tries + 1,
                    lastError: outcome.error.slice(0, 60),
                  };
        await tx.update(doctorAlerts).set(set).where(eq(doctorAlerts.id, alertId));
        return true;
      });
    },

    /**
     * The patient asks their doctor to put a running course on hold (TZ §5.4). Nothing about the
     * course changes: only the doctor pauses it. One request per course per day reaches the doctor.
     */
    async requestPause(
      actor: Actor,
      input: { courseId: string; now: Date },
    ): Promise<PauseRequestResult> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only the patient asks for a pause of their own course');
      }
      return db.transaction(async (tx) => {
        const [course] = await tx
          .select({ clinicianId: treatmentCourses.clinicianId })
          .from(treatmentCourses)
          .where(
            and(
              eq(treatmentCourses.id, input.courseId),
              eq(treatmentCourses.patientId, actor.userId),
              eq(treatmentCourses.status, 'ACTIVE'),
              visibleCourses(actor),
            ),
          );
        if (course === undefined) {
          return { status: 'NOT_AVAILABLE' };
        }
        const inserted = await tx
          .insert(doctorAlerts)
          .values({
            courseId: input.courseId,
            recipientUserId: course.clinicianId,
            kind: 'PAUSE_REQUEST',
            dedupeKey: `pause:${input.courseId}:${input.now.toISOString().slice(0, 10)}`,
            dueAt: input.now,
          })
          .onConflictDoNothing({ target: doctorAlerts.dedupeKey })
          .returning({ id: doctorAlerts.id });
        return { status: inserted.length > 0 ? 'REQUESTED' : 'ALREADY' };
      });
    },
  };
}

/**
 * The as-needed marks of one drug that still stand (were not taken back) in `(from, to]`,
 * oldest first.
 */
export async function standingPrnMarks(
  tx: Executor,
  input: { courseId: string; medicationLineId: string; from: Date; to: Date },
): Promise<{ id: string; at: Date }[]> {
  const rows = await tx
    .select({
      id: doseEvents.id,
      eventType: doseEvents.eventType,
      at: doseEvents.occurredAt,
      details: doseEvents.details,
    })
    .from(doseEvents)
    .where(
      and(
        eq(doseEvents.courseId, input.courseId),
        eq(doseEvents.medicationLineId, input.medicationLineId),
        isNull(doseEvents.scheduledDoseId),
      ),
    )
    .orderBy(asc(doseEvents.occurredAt), asc(doseEvents.recordedAt));
  const cancelled = new Set(
    rows
      .filter((row) => row.eventType === 'PRN_CANCELLED')
      .map((row) => (row.details as { cancels?: unknown } | null)?.cancels)
      .filter((id): id is string => typeof id === 'string'),
  );
  return rows
    .filter(
      (row) =>
        row.eventType === 'PRN_TAKEN' &&
        !cancelled.has(row.id) &&
        row.at > input.from &&
        row.at <= input.to,
    )
    .map((row) => ({ id: row.id, at: row.at }));
}

export type AlertRepository = ReturnType<typeof createAlertRepository>;
