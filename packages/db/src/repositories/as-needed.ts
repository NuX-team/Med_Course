import { randomUUID } from 'node:crypto';
import { correctionWindowEnd, courseDayAt, prnCheck, type PrnExcess } from '@medcourse/schedule';
import { and, eq, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import { courseMedications, doseEvents, treatmentCourses } from '../schema';
import { notePrnOver, standingPrnMarks } from './alerts';
import type { Course } from './courses';
import { pausesOf, policyOf, timelineOf } from './layout';
import type { DoseUnit, FoodRule } from './plans';

const DAY_MS = 86_400_000;
/** Two marks of one drug this close together are one tap made twice. */
export const PRN_DOUBLE_TAP_MS = 60_000;

/** An as-needed drug of a running course, with the doctor's limits and what has been marked. */
export interface PrnItem {
  /** The medication row of the plan in force: what a button names. */
  readonly medicationId: string;
  readonly courseId: string;
  readonly timezone: string;
  readonly displayName: string;
  readonly doseValue: string;
  readonly doseDisplay: string | null;
  readonly doseUnit: DoseUnit;
  readonly foodRule: FoodRule;
  readonly maxDailyDoses: number;
  readonly minimumIntervalMinutes: number;
  /** Marks standing in the last 24 hours. */
  readonly takenInDay: number;
  readonly lastTakenAt: Date | null;
  /** The newest mark, while the patient may still take it back. */
  readonly undoable: { readonly eventId: string; readonly until: Date } | null;
  /** Whether one more intake now would go beyond the doctor's limits, and which one. */
  readonly excess: PrnExcess | null;
  /** From when one more intake is within the limits again. Equals "now" when it already is. */
  readonly withinLimitsFrom: Date;
}

export type PrnTakeResult =
  /** Not this patient's drug, not as-needed, or the course is not running today. */
  | { readonly status: 'NOT_AVAILABLE' }
  /** Recorded. `over` says it went beyond the doctor's limits: the doctor is told. */
  | { readonly status: 'RECORDED'; readonly item: PrnItem; readonly over: PrnExcess | null }
  /** The same tap arriving twice: nothing more is recorded. */
  | { readonly status: 'ALREADY'; readonly item: PrnItem };

export type PrnUndoResult =
  | { readonly status: 'NOT_AVAILABLE' }
  | { readonly status: 'ALREADY'; readonly item: PrnItem }
  | { readonly status: 'NOT_CORRECTABLE'; readonly item: PrnItem }
  | { readonly status: 'UNDONE'; readonly item: PrnItem };

function requirePatient(actor: Actor): string {
  if (actor.kind !== 'PATIENT') {
    throw new ForbiddenError('only the patient marks their own as-needed intake');
  }
  return actor.userId;
}

type MedicationRow = typeof courseMedications.$inferSelect;

/**
 * As-needed (PRN) intake (TZ §7.6, D-12). There is no slot and no reminder: the patient says
 * "I took it" and the fact is recorded, always, because it is a fact. What the doctor allowed
 * (so many a day, no closer together than so long) is shown before the mark and checked at it:
 * a mark beyond the limits is still recorded, and the doctor is told. The bot never says when
 * to take anything.
 */
export function createPrnRepository(db: Executor) {
  /** Whether the drug is prescribed for the day of the course that `now` falls on. */
  const activeToday = async (
    tx: Executor,
    course: Course,
    medication: MedicationRow,
    now: Date,
  ): Promise<boolean> => {
    const timeline = timelineOf(course, await pausesOf(tx, course.id));
    const today = timeline === null ? null : courseDayAt(timeline, now);
    return (
      today?.state === 'IN_PROGRESS' &&
      today.day >= medication.activeFromDay &&
      today.day <= medication.activeToDay
    );
  };

  const itemOf = async (
    tx: Executor,
    course: Course,
    medication: MedicationRow,
    now: Date,
  ): Promise<PrnItem | null> => {
    if (medication.maxDailyDoses === null || medication.minimumIntervalMinutes === null) {
      return null;
    }
    const marks = await standingPrnMarks(tx, {
      courseId: course.id,
      medicationLineId: medication.lineId,
      from: new Date(now.getTime() - DAY_MS),
      to: now,
    });
    const last = marks.at(-1);
    const rule = {
      maxDailyDoses: medication.maxDailyDoses,
      minimumIntervalMinutes: medication.minimumIntervalMinutes,
    };
    const check = prnCheck({ recent: marks.map((mark) => mark.at), ...rule }, now);
    const until =
      last === undefined ? null : correctionWindowEnd(last.at, await policyOf(tx, course.id));
    return {
      medicationId: medication.id,
      courseId: course.id,
      timezone: course.timezone,
      displayName: medication.displayName,
      doseValue: medication.doseValue,
      doseDisplay: medication.doseDisplay,
      doseUnit: medication.doseUnit,
      foodRule: medication.foodRule,
      ...rule,
      takenInDay: marks.length,
      lastTakenAt: last?.at ?? null,
      undoable:
        last !== undefined && until !== null && now <= until ? { eventId: last.id, until } : null,
      excess: check.excess,
      withinLimitsFrom: check.withinLimitsFrom,
    };
  };

  /**
   * The patient's own as-needed drug in the plan in force of a running course. With `lock`,
   * the course is held still (as for any answer) and marks of this drug are made one at a time.
   */
  const find = async (
    tx: Executor,
    actor: Actor,
    medicationId: string,
    lock: boolean,
  ): Promise<{ course: Course; medication: MedicationRow } | null> => {
    const patientId = requirePatient(actor);
    const query = tx
      .select({ course: treatmentCourses, medication: courseMedications })
      .from(courseMedications)
      .innerJoin(
        treatmentCourses,
        eq(treatmentCourses.currentRevisionId, courseMedications.revisionId),
      )
      .where(
        and(
          eq(courseMedications.id, medicationId),
          eq(courseMedications.prn, true),
          eq(treatmentCourses.patientId, patientId),
          eq(treatmentCourses.status, 'ACTIVE'),
          visibleCourses(actor),
        ),
      );
    const [found] = await (lock ? query.for('share', { of: treatmentCourses }) : query);
    if (found === undefined) {
      return null;
    }
    if (lock) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`prn:${found.course.id}:${found.medication.lineId}`}))`,
      );
    }
    return found;
  };

  return {
    /** Every as-needed drug the patient may mark right now, across their running courses. */
    async available(actor: Actor, now: Date): Promise<PrnItem[]> {
      const patientId = requirePatient(actor);
      const rows = await db
        .select({ course: treatmentCourses, medication: courseMedications })
        .from(courseMedications)
        .innerJoin(
          treatmentCourses,
          eq(treatmentCourses.currentRevisionId, courseMedications.revisionId),
        )
        .where(
          and(
            eq(courseMedications.prn, true),
            eq(treatmentCourses.patientId, patientId),
            eq(treatmentCourses.status, 'ACTIVE'),
            visibleCourses(actor),
          ),
        )
        .orderBy(treatmentCourses.startAt, courseMedications.createdAt, courseMedications.id);
      const items: PrnItem[] = [];
      for (const { course, medication } of rows) {
        const item = (await activeToday(db, course, medication, now))
          ? await itemOf(db, course, medication, now)
          : null;
        if (item !== null) {
          items.push(item);
        }
      }
      return items;
    },

    /** One as-needed drug as it stands, for the screen that asks "mark it?". */
    async get(actor: Actor, medicationId: string, now: Date): Promise<PrnItem | null> {
      const found = await find(db, actor, medicationId, false);
      if (found === null || !(await activeToday(db, found.course, found.medication, now))) {
        return null;
      }
      return itemOf(db, found.course, found.medication, now);
    },

    /**
     * "I took it". Always recorded; beyond the doctor's limits it is recorded as such and the
     * doctor is told. `key` identifies the tap, so a redelivered tap records nothing twice, and
     * a second tap within a minute of the last mark is taken for the same one.
     */
    async take(
      actor: Actor,
      input: { medicationId: string; now: Date; key: string },
    ): Promise<PrnTakeResult> {
      const patientId = requirePatient(actor);
      const { now } = input;
      return db.transaction(async (tx) => {
        const found = await find(tx, actor, input.medicationId, true);
        if (found === null || !(await activeToday(tx, found.course, found.medication, now))) {
          return { status: 'NOT_AVAILABLE' };
        }
        const { course, medication } = found;
        const before = await itemOf(tx, course, medication, now);
        if (before === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        if (
          before.lastTakenAt !== null &&
          now.getTime() - before.lastTakenAt.getTime() < PRN_DOUBLE_TAP_MS
        ) {
          return { status: 'ALREADY', item: before };
        }

        const id = randomUUID();
        const inserted = await tx
          .insert(doseEvents)
          .values({
            id,
            scheduledDoseId: null,
            courseId: course.id,
            medicationLineId: medication.lineId,
            eventType: 'PRN_TAKEN',
            actorKind: 'PATIENT',
            actorUserId: patientId,
            source: 'TELEGRAM',
            idempotencyKey: `prn:${input.key}`,
            details: before.excess === null ? null : { over: before.excess },
            occurredAt: now,
          })
          .onConflictDoNothing({ target: doseEvents.idempotencyKey })
          .returning({ id: doseEvents.id });
        const item = await itemOf(tx, course, medication, now);
        if (item === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        if (inserted.length === 0) {
          return { status: 'ALREADY', item };
        }
        if (before.excess !== null) {
          await notePrnOver(tx, {
            courseId: course.id,
            medicationLineId: medication.lineId,
            eventId: id,
            now,
          });
        }
        return { status: 'RECORDED', item, over: before.excess };
      });
    },

    /**
     * The patient takes back one particular mark, within the correction window. The mark stays
     * in the log; a PRN_CANCELLED event that names it is added, and it stops counting. The
     * button names the mark, so a second tap finds it already taken back and touches no other.
     */
    async undo(actor: Actor, input: { eventId: string; now: Date }): Promise<PrnUndoResult> {
      const patientId = requirePatient(actor);
      const { now } = input;
      return db.transaction(async (tx) => {
        const [mark] = await tx
          .select()
          .from(doseEvents)
          .where(
            and(
              eq(doseEvents.id, input.eventId),
              eq(doseEvents.eventType, 'PRN_TAKEN'),
              eq(doseEvents.actorUserId, patientId),
            ),
          );
        if (mark?.medicationLineId == null) {
          return { status: 'NOT_AVAILABLE' };
        }
        const [current] = await tx
          .select({ id: courseMedications.id })
          .from(courseMedications)
          .innerJoin(
            treatmentCourses,
            eq(treatmentCourses.currentRevisionId, courseMedications.revisionId),
          )
          .where(
            and(
              eq(treatmentCourses.id, mark.courseId),
              eq(courseMedications.lineId, mark.medicationLineId),
            ),
          );
        const found = current === undefined ? null : await find(tx, actor, current.id, true);
        const before =
          found === null ? null : await itemOf(tx, found.course, found.medication, now);
        if (found === null || before === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        const standing = await standingPrnMarks(tx, {
          courseId: mark.courseId,
          medicationLineId: mark.medicationLineId,
          from: new Date(mark.occurredAt.getTime() - 1),
          to: mark.occurredAt,
        });
        if (!standing.some((candidate) => candidate.id === mark.id)) {
          return { status: 'ALREADY', item: before };
        }
        if (now > correctionWindowEnd(mark.occurredAt, await policyOf(tx, mark.courseId))) {
          return { status: 'NOT_CORRECTABLE', item: before };
        }
        await tx
          .insert(doseEvents)
          .values({
            scheduledDoseId: null,
            courseId: mark.courseId,
            medicationLineId: mark.medicationLineId,
            eventType: 'PRN_CANCELLED',
            actorKind: 'PATIENT',
            actorUserId: patientId,
            source: 'TELEGRAM',
            idempotencyKey: `prn-undo:${mark.id}`,
            details: { cancels: mark.id },
            occurredAt: now,
          })
          .onConflictDoNothing({ target: doseEvents.idempotencyKey });
        const item = await itemOf(tx, found.course, found.medication, now);
        return item === null ? { status: 'NOT_AVAILABLE' } : { status: 'UNDONE', item };
      });
    },
  };
}

export type PrnRepository = ReturnType<typeof createPrnRepository>;
