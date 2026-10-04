import {
  addDays,
  generateSlots,
  lastCourseDay,
  startOfLocalDay,
  type LocalDate,
} from '@medcourse/schedule';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import { coursePauses, courseTransitions, scheduledDoses, treatmentCourses } from '../schema';
import { closePendingChange } from './changes';
import type { RepositoryDeps } from './context';
import type { Course } from './courses';
import {
  layOutDoses,
  pausesOf,
  recipientOf,
  retireOpenDoses,
  timelineOf,
  toMedicationInputs,
  type Recipient,
} from './layout';
import { createPlanReader, type CoursePlan } from './plans';

/** `cancellation_reason_code` of a course the doctor took back before the patient started it. */
export const WITHDRAWN_BEFORE_START = 'WITHDRAWN_BEFORE_START';
/** `cancellation_reason_code` of a running (or paused) course the doctor stopped for good. */
export const CANCELLED_BY_DOCTOR = 'CANCELLED_BY_DOCTOR';

const COMPLETION_BATCH = 200;

type Refused =
  /** Not this doctor's course, or no such course. */
  | { readonly status: 'NOT_AVAILABLE' }
  /** The course is not in a state this can be done from; `plan` shows where it stands. */
  | { readonly status: 'WRONG_STATE'; readonly plan: CoursePlan };

export type PauseResult =
  | Refused
  | {
      readonly status: 'PAUSED';
      readonly plan: CoursePlan;
      readonly patient: Recipient | null;
      /** Doses taken out of the schedule: they are neither reminded nor counted. */
      readonly superseded: number;
    };

export type ResumeResult =
  | Refused
  | {
      readonly status: 'RESUMED';
      readonly plan: CoursePlan;
      readonly patient: Recipient | null;
      readonly firstSlotAt: Date | null;
      /** The final day of the course, moved out by every whole day it was on hold. */
      readonly lastDay: LocalDate | null;
    };

export type CancelResult =
  | Refused
  | {
      readonly status: 'CANCELLED';
      readonly plan: CoursePlan;
      readonly patient: Recipient | null;
      /** True if the patient had not started it yet: the course was taken back, not stopped. */
      readonly withdrawn: boolean;
    };

/** A course the sweeper has just closed, with what is needed to tell its patient. */
export interface CompletedCourse {
  readonly courseId: string;
  readonly lastDay: LocalDate;
  readonly patient: Recipient | null;
}

function requireClinician(actor: Actor): string {
  if (actor.kind !== 'CLINICIAN') {
    throw new ForbiddenError('only the doctor pauses, resumes or cancels a course');
  }
  return actor.userId;
}

/**
 * What happens to a course after it has been sent (ARCHITECTURE §5.5, §6.1): the doctor puts it
 * on hold and resumes it, takes it back or stops it for good, and the system closes it once its
 * last day is over. Each of these locks the course row first, so two of them arriving together
 * (or one arriving with the patient's start, or with a change of plan) are settled one after
 * the other. None of them rewrites the past: answers and misses stay as recorded.
 */
export function createLifecycleRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };
  const { medicationsOf, planOf } = createPlanReader(deps);

  const ownCourse = async (
    tx: Executor,
    actor: Actor,
    courseId: string,
  ): Promise<Course | null> => {
    const [course] = await tx
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.id, courseId),
          eq(treatmentCourses.clinicianId, requireClinician(actor)),
          visibleCourses(actor),
        ),
      )
      .for('update');
    return course ?? null;
  };

  const refuse = async (tx: Executor, course: Course): Promise<Refused> => {
    const plan = await planOf(tx, course, 'CLINICIAN');
    return plan === null ? { status: 'NOT_AVAILABLE' } : { status: 'WRONG_STATE', plan };
  };

  const record = async (
    tx: Executor,
    actor: Actor,
    input: {
      before: Course;
      after: Course;
      action: string;
      changes: string[];
      now: Date;
      reason?: string;
    },
  ): Promise<void> => {
    await tx.insert(courseTransitions).values({
      courseId: input.before.id,
      fromStatus: input.before.status,
      toStatus: input.after.status,
      actorKind: actor.kind,
      actorUserId: actorUserId(actor),
      reason: input.reason ?? null,
      requestId: requestId ?? null,
      at: input.now,
    });
    await audit.record(tx, {
      actor,
      entityType: 'treatment_courses',
      entityId: input.before.id,
      action: input.action,
      before: input.before,
      after: input.after,
      changes: input.changes,
      ...context,
    });
  };

  const requirePlan = async (tx: Executor, course: Course): Promise<CoursePlan> => {
    const plan = await planOf(tx, course, 'CLINICIAN');
    if (plan === null) {
      throw new Error('a course has no patient or doctor');
    }
    return plan;
  };

  return {
    /**
     * The doctor puts a running course on hold (ACTIVE to PAUSED). From this moment nothing is
     * asked of the patient: every dose still open is taken out of the schedule, the one being
     * reminded right now included, and every reminder still waiting is cancelled.
     */
    async pause(
      actor: Actor,
      input: { courseId: string; now: Date; key: string },
    ): Promise<PauseResult> {
      const clinicianId = requireClinician(actor);
      const { courseId, now } = input;
      return db.transaction(async (tx) => {
        const course = await ownCourse(tx, actor, courseId);
        if (course === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        if (course.status !== 'ACTIVE') {
          return refuse(tx, course);
        }
        const [paused] = await tx
          .update(treatmentCourses)
          .set({ status: 'PAUSED' })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        if (paused === undefined) {
          throw new Error('a course vanished while being paused');
        }
        await tx.insert(coursePauses).values({ courseId, pausedAt: now, pausedBy: clinicianId });
        const retired = await retireOpenDoses(tx, {
          courseId,
          now,
          reason: 'paused',
          actor,
          key: input.key,
        });
        await record(tx, actor, {
          before: course,
          after: paused,
          action: 'PAUSE',
          changes: ['status'],
          now,
        });
        return {
          status: 'PAUSED',
          plan: await requirePlan(tx, paused),
          patient: await recipientOf(tx, course.patientId),
          superseded: retired.superseded,
        };
      });
    },

    /**
     * The doctor resumes a course (PAUSED to ACTIVE). The hold is closed, and the plan in force
     * is laid out again strictly after `now`. Days that lay wholly inside the hold were not
     * counted, so the course ends later by that many days; doses that fell inside it are not
     * made up (D-20).
     */
    async resume(
      actor: Actor,
      input: { courseId: string; now: Date; key: string },
    ): Promise<ResumeResult> {
      const clinicianId = requireClinician(actor);
      const { courseId, now } = input;
      return db.transaction(async (tx) => {
        const course = await ownCourse(tx, actor, courseId);
        if (course === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        if (course.status !== 'PAUSED' || course.currentRevisionId === null) {
          return refuse(tx, course);
        }
        const [hold] = await tx
          .select()
          .from(coursePauses)
          .where(and(eq(coursePauses.courseId, courseId), isNull(coursePauses.resumedAt)))
          .for('update');
        if (hold === undefined) {
          throw new Error('a paused course has no open pause');
        }
        // A hold has a length, however short: its end is strictly after its start.
        const resumedAt = now > hold.pausedAt ? now : new Date(hold.pausedAt.getTime() + 1);
        await tx
          .update(coursePauses)
          .set({ resumedAt, resumedBy: clinicianId })
          .where(eq(coursePauses.id, hold.id));

        const [resumed] = await tx
          .update(treatmentCourses)
          .set({ status: 'ACTIVE' })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        if (resumed === undefined) {
          throw new Error('a course vanished while being resumed');
        }
        // Nothing should be open in a course on hold; if anything is, it does not come back.
        await retireOpenDoses(tx, { courseId, now, reason: 'paused', actor, key: input.key });

        const timeline = timelineOf(resumed, await pausesOf(tx, courseId));
        if (timeline === null) {
          throw new Error('a paused course has no start date');
        }
        const slots = generateSlots({
          medications: toMedicationInputs(await medicationsOf(tx, course.currentRevisionId)),
          timeline,
          after: resumedAt,
        });
        await layOutDoses(tx, {
          courseId,
          revisionId: course.currentRevisionId,
          patientId: course.patientId,
          slots,
          now,
        });
        await record(tx, actor, {
          before: course,
          after: resumed,
          action: 'RESUME',
          changes: ['status'],
          now,
        });
        return {
          status: 'RESUMED',
          plan: await requirePlan(tx, resumed),
          patient: await recipientOf(tx, course.patientId),
          firstSlotAt: slots[0]?.scheduledAt ?? null,
          lastDay: lastCourseDay(timeline),
        };
      });
    },

    /**
     * The doctor ends a course for good. One not yet started is taken back; a running or paused
     * one is stopped, and its reminders stop in the same instant (D-11): everything still open
     * is taken out of the schedule, and a change of plan still in the making goes with it.
     */
    async cancel(
      actor: Actor,
      input: { courseId: string; now: Date; key: string },
    ): Promise<CancelResult> {
      requireClinician(actor);
      const { courseId, now } = input;
      return db.transaction(async (tx) => {
        const course = await ownCourse(tx, actor, courseId);
        if (course === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        if (!['PENDING_PATIENT', 'ACTIVE', 'PAUSED'].includes(course.status)) {
          return refuse(tx, course);
        }
        const withdrawn = course.status === 'PENDING_PATIENT';
        const reason = withdrawn ? WITHDRAWN_BEFORE_START : CANCELLED_BY_DOCTOR;
        const [cancelled] = await tx
          .update(treatmentCourses)
          .set({ status: 'CANCELLED', endedAt: now, cancellationReasonCode: reason })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        if (cancelled === undefined) {
          throw new Error('a course vanished while being cancelled');
        }
        if (!withdrawn) {
          await retireOpenDoses(tx, { courseId, now, reason: 'cancelled', actor, key: input.key });
          await closePendingChange(tx, deps, actor, course);
        }
        await record(tx, actor, {
          before: course,
          after: cancelled,
          action: withdrawn ? 'WITHDRAW' : 'CANCEL',
          changes: ['status', 'ended_at', 'cancellation_reason_code'],
          now,
          reason,
        });
        return {
          status: 'CANCELLED',
          plan: await requirePlan(tx, cancelled),
          patient: await recipientOf(tx, course.patientId),
          withdrawn,
        };
      });
    },

    /**
     * Closes running courses whose last day is over (ACTIVE to COMPLETED). The last day is
     * counted with the holds, so a course that was paused ends later. A course is not closed
     * while a dose is still waiting for an answer or for the sweeper that records misses: it is
     * picked up on a later round. System only; safe to run as often as you like.
     */
    async completeDue(actor: Actor, now: Date): Promise<CompletedCourse[]> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system completes courses');
      }
      return db.transaction(async (tx) => {
        // The cheap filter: the course could have ended only if its days have run out even
        // without a single hold. The exact check, with the holds, is made per course below.
        const candidates = await tx
          .select()
          .from(treatmentCourses)
          .where(
            and(
              eq(treatmentCourses.status, 'ACTIVE'),
              sql`${treatmentCourses.effectiveStartDate} + ${treatmentCourses.durationDays}
                <= (${now.toISOString()}::timestamptz at time zone ${treatmentCourses.timezone})::date`,
            ),
          )
          .orderBy(asc(treatmentCourses.effectiveStartDate), asc(treatmentCourses.id))
          .limit(COMPLETION_BATCH)
          .for('update', { skipLocked: true });

        const completed: CompletedCourse[] = [];
        for (const course of candidates) {
          const timeline = timelineOf(course, await pausesOf(tx, course.id));
          const lastDay = timeline === null ? null : lastCourseDay(timeline);
          if (lastDay === null || now < startOfLocalDay(addDays(lastDay, 1), course.timezone)) {
            continue;
          }
          const [open] = await tx
            .select({ open: count() })
            .from(scheduledDoses)
            .where(
              and(
                eq(scheduledDoses.courseId, course.id),
                inArray(scheduledDoses.status, ['SCHEDULED', 'NOTIFIED', 'SNOOZED']),
              ),
            );
          if ((open?.open ?? 0) > 0) {
            continue;
          }

          const [done] = await tx
            .update(treatmentCourses)
            .set({ status: 'COMPLETED', endedAt: now })
            .where(eq(treatmentCourses.id, course.id))
            .returning();
          if (done === undefined) {
            continue;
          }
          await closePendingChange(tx, deps, actor, course);
          await record(tx, actor, {
            before: course,
            after: done,
            action: 'COMPLETE',
            changes: ['status', 'ended_at'],
            now,
            reason: 'last day over',
          });
          completed.push({
            courseId: course.id,
            lastDay,
            patient: await recipientOf(tx, course.patientId),
          });
        }
        return completed;
      });
    },
  };
}

export type LifecycleRepository = ReturnType<typeof createLifecycleRepository>;
