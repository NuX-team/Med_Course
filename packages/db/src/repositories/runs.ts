import {
  addDays,
  generateSlots,
  lastCourseDay,
  localDateOf,
  startOfLocalDay,
  startWindowState,
  type LocalDate,
  type Slot,
} from '@medcourse/schedule';
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import {
  courseMedications,
  courseRevisions,
  courseTransitions,
  scheduledDoses,
  treatmentCourses,
  users,
  type DoseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';
import type { Course } from './courses';
import { layOutDoses, prescriberInStanding, toMedicationInputs } from './layout';
import { createPlanReader, type CoursePlan, type DoseUnit, type FoodRule } from './plans';

const EXPIRY_BATCH = 200;

/** What starting right now would mean, so the patient can decide before it happens (D-7). */
export interface StartOutlook {
  /** Day 1: today on the patient's own calendar. */
  readonly effectiveStartDate: LocalDate;
  readonly lastDay: LocalDate;
  /** Doses still ahead today. */
  readonly slotsToday: number;
  /** Doses the plan has for a full first day; more than `slotsToday` when starting late. */
  readonly plannedToday: number;
  readonly slotsTotal: number;
  readonly firstSlotAt: Date | null;
}

/** Why a course cannot be started. Each carries the plan when the patient may know it. */
export type StartRefusal =
  /** Not this patient's course, or not something that can be started (and never was). */
  | { readonly status: 'NOT_AVAILABLE' }
  | { readonly status: 'ALREADY_STARTED'; readonly plan: CoursePlan }
  /** The doctor took the course back (or cancelled it) before it was started. */
  | { readonly status: 'WITHDRAWN'; readonly plan: CoursePlan }
  | {
      readonly status: 'OUTSIDE_WINDOW';
      readonly when: 'BEFORE' | 'AFTER';
      readonly plan: CoursePlan;
    }
  /** The doctor who wrote it has lost standing, or the relationship has ended. */
  | { readonly status: 'DOCTOR_UNAVAILABLE'; readonly plan: CoursePlan }
  /** Every dose of the plan would already be in the past: starting now would start nothing. */
  | { readonly status: 'NOTHING_LEFT'; readonly plan: CoursePlan };

export type StartPreview =
  | StartRefusal
  | { readonly status: 'READY'; readonly plan: CoursePlan; readonly outlook: StartOutlook };

export type StartResult =
  | StartRefusal
  | {
      readonly status: 'STARTED';
      readonly plan: CoursePlan;
      readonly outlook: StartOutlook;
      /** To tell the doctor. */
      readonly doctor: { readonly telegramUserId: number; readonly locale: 'ru' | 'uz' };
    };

export interface TodayDose {
  readonly doseId: string;
  readonly scheduledAt: Date;
  readonly status: DoseStatus;
  readonly displayName: string;
  readonly doseValue: string;
  readonly doseDisplay: string | null;
  readonly doseUnit: DoseUnit;
  readonly foodRule: FoodRule;
}

/** One running course and what it asks of the patient today. */
export interface TodayCourse {
  readonly courseId: string;
  readonly timezone: string;
  readonly doses: readonly TodayDose[];
}

function requirePatient(actor: Actor): string {
  if (actor.kind !== 'PATIENT') {
    throw new ForbiddenError('only the patient starts their own course');
  }
  return actor.userId;
}

/**
 * A course coming to life: the patient starts it, and the plan the doctor confirmed is laid out
 * as the doses to take and the reminders to send (ARCHITECTURE §5.2). Nothing is scheduled
 * before this moment, and after it the start can never happen again.
 */
export function createRunRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };
  const { medicationsOf, planOf } = createPlanReader(deps);

  /**
   * Everything that decides whether this patient may start this course at `now`, and what the
   * start would produce. Used both to show the patient what will happen and, again inside the
   * starting transaction, to do it: the two cannot disagree.
   */
  const assess = async (
    executor: Executor,
    actor: Actor,
    courseId: string,
    now: Date,
  ): Promise<
    | StartRefusal
    | {
        status: 'READY';
        course: Course;
        plan: CoursePlan;
        outlook: StartOutlook;
        slots: Slot[];
      }
  > => {
    const patientId = requirePatient(actor);
    const [course] = await executor
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.id, courseId),
          eq(treatmentCourses.patientId, patientId),
          visibleCourses(actor),
        ),
      );
    const plan = course === undefined ? null : await planOf(executor, course, 'PATIENT');
    if (course === undefined || plan === null) {
      return { status: 'NOT_AVAILABLE' };
    }
    if (course.status === 'ACTIVE' || course.status === 'PAUSED' || course.status === 'COMPLETED') {
      return { status: 'ALREADY_STARTED', plan };
    }
    if (course.status === 'EXPIRED_NOT_STARTED') {
      return { status: 'OUTSIDE_WINDOW', when: 'AFTER', plan };
    }
    if (course.status === 'CANCELLED') {
      return course.startAt === null
        ? { status: 'WITHDRAWN', plan }
        : { status: 'ALREADY_STARTED', plan };
    }
    if (course.status !== 'PENDING_PATIENT') {
      return { status: 'NOT_AVAILABLE' };
    }

    const window =
      course.startWindowFrom === null || course.startWindowTo === null
        ? null
        : { from: course.startWindowFrom, to: course.startWindowTo };
    const state = startWindowState(now, window);
    if (state === 'BEFORE' || state === 'AFTER') {
      return { status: 'OUTSIDE_WINDOW', when: state, plan };
    }

    // A prescription is only as good as its author's standing on the day it is started.
    if (!(await prescriberInStanding(executor, course))) {
      return { status: 'DOCTOR_UNAVAILABLE', plan };
    }

    const medications = toMedicationInputs(await medicationsOf(executor, course.currentRevisionId));
    const effectiveStartDate = localDateOf(now, course.timezone);
    const timeline = {
      effectiveStartDate,
      timezone: course.timezone,
      durationDays: course.durationDays,
    };
    const planned = generateSlots({ medications, timeline });
    // Strictly after the tap: a dose whose time has passed today is never created (D-8).
    const slots = planned.filter((slot) => slot.scheduledAt > now);
    if (slots.length === 0 && medications.some((medication) => !medication.prn)) {
      return { status: 'NOTHING_LEFT', plan };
    }

    return {
      status: 'READY',
      course,
      plan,
      slots,
      outlook: {
        effectiveStartDate,
        lastDay: lastCourseDay(timeline) ?? effectiveStartDate,
        slotsToday: slots.filter((slot) => slot.localDate === effectiveStartDate).length,
        plannedToday: planned.filter((slot) => slot.localDate === effectiveStartDate).length,
        slotsTotal: slots.length,
        firstSlotAt: slots[0]?.scheduledAt ?? null,
      },
    };
  };

  return {
    /** What starting now would do, without doing it. For the "start now?" question (D-7). */
    async previewStart(actor: Actor, courseId: string, now: Date): Promise<StartPreview> {
      const assessed = await assess(db, actor, courseId, now);
      return assessed.status === 'READY'
        ? { status: 'READY', plan: assessed.plan, outlook: assessed.outlook }
        : assessed;
    },

    /**
     * The patient starts the course. One transaction: the course becomes ACTIVE with its start
     * moment and day 1 fixed, the confirmed revision becomes the applied one, and every dose
     * still ahead is created with its reminders. The step that makes it happen is a single
     * conditional UPDATE, so of any number of simultaneous taps exactly one starts the course
     * and the rest are told it has already started; a later tap can never move the start.
     */
    async start(actor: Actor, courseId: string, now: Date): Promise<StartResult> {
      requirePatient(actor);
      return db.transaction(async (tx) => {
        const assessed = await assess(tx, actor, courseId, now);
        if (assessed.status !== 'READY') {
          return assessed;
        }
        const { course, slots, outlook } = assessed;
        const revisionId = course.currentRevisionId;
        if (revisionId === null) {
          return { status: 'NOT_AVAILABLE' };
        }

        const [started] = await tx
          .update(treatmentCourses)
          .set({ status: 'ACTIVE', startAt: now, effectiveStartDate: outlook.effectiveStartDate })
          .where(
            and(
              eq(treatmentCourses.id, courseId),
              eq(treatmentCourses.status, 'PENDING_PATIENT'),
              // The window is checked again here, in the statement that starts the course.
              or(
                isNull(treatmentCourses.startWindowFrom),
                and(
                  lte(treatmentCourses.startWindowFrom, now),
                  gte(treatmentCourses.startWindowTo, now),
                ),
              ),
            ),
          )
          .returning();
        if (started === undefined) {
          // Someone else's tap got there first (or the window closed in between): say what is.
          const again = await assess(tx, actor, courseId, now);
          return again.status === 'READY' ? { status: 'NOT_AVAILABLE' } : again;
        }

        await tx
          .update(courseRevisions)
          .set({ status: 'APPLIED', appliedAt: now, confirmedByPatientAt: now })
          .where(eq(courseRevisions.id, revisionId));

        await layOutDoses(tx, {
          courseId,
          revisionId,
          patientId: course.patientId,
          slots,
          now,
        });

        await tx.insert(courseTransitions).values({
          courseId,
          fromStatus: 'PENDING_PATIENT',
          toStatus: 'ACTIVE',
          actorKind: actor.kind,
          actorUserId: actorUserId(actor),
          requestId: requestId ?? null,
          at: now,
        });
        await audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: courseId,
          action: 'START',
          before: course,
          after: started,
          changes: ['status', 'start_at', 'effective_start_date'],
          ...context,
        });

        const [doctor] = await tx
          .select({ telegramUserId: users.telegramUserId, locale: users.locale })
          .from(users)
          .where(eq(users.id, course.clinicianId));
        const plan = await planOf(tx, started, 'PATIENT');
        if (doctor === undefined || plan === null) {
          throw new Error('a started course has no doctor or patient');
        }
        return { status: 'STARTED', plan, outlook, doctor };
      });
    },

    /**
     * Closes courses nobody started before their window ran out (PENDING_PATIENT to
     * EXPIRED_NOT_STARTED). System only; safe to run as often as you like. Returns how many.
     */
    async expireUnstarted(actor: Actor, now: Date): Promise<number> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system expires courses');
      }
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: treatmentCourses.id })
          .from(treatmentCourses)
          .where(
            and(
              eq(treatmentCourses.status, 'PENDING_PATIENT'),
              lt(treatmentCourses.startWindowTo, now),
            ),
          )
          .orderBy(asc(treatmentCourses.startWindowTo))
          .limit(EXPIRY_BATCH)
          .for('update', { skipLocked: true });
        if (due.length === 0) {
          return 0;
        }
        const ids = due.map((row) => row.id);
        await tx
          .update(treatmentCourses)
          .set({ status: 'EXPIRED_NOT_STARTED', endedAt: now })
          .where(inArray(treatmentCourses.id, ids));
        await tx.insert(courseTransitions).values(
          ids.map((courseId) => ({
            courseId,
            fromStatus: 'PENDING_PATIENT' as const,
            toStatus: 'EXPIRED_NOT_STARTED' as const,
            actorKind: actor.kind,
            actorUserId: null,
            reason: 'start window ended',
            at: now,
          })),
        );
        for (const courseId of ids) {
          await audit.record(tx, {
            actor,
            entityType: 'treatment_courses',
            entityId: courseId,
            action: 'EXPIRE',
            changes: ['status', 'ended_at'],
            ...context,
          });
        }
        return ids.length;
      });
    },

    /**
     * What the patient's running courses ask of them today (their own calendar day, in each
     * course's time zone), in the order the doses fall due.
     */
    async today(actor: Actor, now: Date): Promise<TodayCourse[]> {
      const patientId = requirePatient(actor);
      const courses = await db
        .select({ id: treatmentCourses.id, timezone: treatmentCourses.timezone })
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.patientId, patientId),
            eq(treatmentCourses.status, 'ACTIVE'),
            visibleCourses(actor),
          ),
        )
        .orderBy(asc(treatmentCourses.startAt), asc(treatmentCourses.id));

      const result: TodayCourse[] = [];
      for (const course of courses) {
        const today = localDateOf(now, course.timezone);
        const doses = await db
          .select({
            doseId: scheduledDoses.id,
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
          .where(
            and(
              eq(scheduledDoses.courseId, course.id),
              gte(scheduledDoses.scheduledAt, startOfLocalDay(today, course.timezone)),
              lt(scheduledDoses.scheduledAt, startOfLocalDay(addDays(today, 1), course.timezone)),
              ne(scheduledDoses.status, 'SUPERSEDED'),
            ),
          )
          .orderBy(asc(scheduledDoses.scheduledAt), asc(courseMedications.displayName));
        result.push({ courseId: course.id, timezone: course.timezone, doses });
      }
      return result;
    },
  };
}

export type RunRepository = ReturnType<typeof createRunRepository>;
