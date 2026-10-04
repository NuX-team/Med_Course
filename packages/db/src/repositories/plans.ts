import { randomUUID } from 'node:crypto';
import {
  isValidLocalTime,
  validatePlan,
  type Pause,
  type PlanProblemCode,
} from '@medcourse/schedule';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeUser, usableClinician, visibleCourses } from '../access/scopes';
import { fieldAad } from '../field-cipher';
import type { Executor } from '../orm';
import {
  careRelationships,
  clinicianProfiles,
  courseMedications,
  courseRevisions,
  courseTransitions,
  patientProfiles,
  scheduleRules,
  treatmentCourses,
  users,
  type CourseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';
import { createCourseRepository, type Course } from './courses';
import { pausesOf, toMedicationInputs } from './layout';

type MedicationRow = typeof courseMedications.$inferSelect;
export type DoseUnit = MedicationRow['doseUnit'];
export type FoodRule = MedicationRow['foodRule'];

/** Enough for any real prescription, and few enough to read in a chat. */
export const MAX_MEDICATIONS = 15;
export const MAX_TIMES_PER_DAY = 12;
export const MAX_MEDICATION_NAME_LENGTH = 120;
export const MAX_INSTRUCTIONS_LENGTH = 300;
export const MAX_DOSE_DISPLAY_LENGTH = 60;
/** numeric(10, 3). */
export const MAX_DOSE_VALUE = 9_999_999;
/** How many days a patient may be given to start a course once it is sent. */
export const START_WINDOW_DAYS = [1, 3, 7, 14] as const;
/** `cancellation_reason_code` of a draft the doctor threw away before anyone saw it. */
export const DRAFT_DISCARDED = 'DRAFT_DISCARDED';

const TABLE = 'course_medications';
const INSTRUCTIONS = 'instructions_enc';
const DAY_MS = 86_400_000;
const LIST_LIMIT = 30;
const PATIENT_LIST_LIMIT = 5;

/** When a medication is taken: at fixed times of day, or as needed within limits (TZ §7.6). */
export type MedicationSchedule =
  | { readonly kind: 'TIMES'; readonly times: readonly string[] }
  | {
      readonly kind: 'PRN';
      readonly maxDailyDoses: number;
      readonly minimumIntervalMinutes: number;
    };

export interface NewMedication {
  readonly displayName: string;
  readonly doseValue: number;
  /** The doctor's own wording of the amount, e.g. "1/2". */
  readonly doseDisplay?: string | null;
  readonly doseUnit: DoseUnit;
  readonly foodRule: FoodRule;
  readonly instructions?: string | null;
  readonly activeFromDay: number;
  readonly activeToDay: number;
  readonly schedule: MedicationSchedule;
}

export interface PlanRule {
  readonly id: string;
  /** "HH:MM:SS", in the course's time zone. */
  readonly localTime: string;
  readonly daysOfWeek: readonly number[] | null;
  readonly dayFrom: number | null;
  readonly dayTo: number | null;
}

export interface PlanMedication {
  readonly id: string;
  readonly lineId: string;
  readonly displayName: string;
  /** As stored: a decimal string such as "500.000". */
  readonly doseValue: string;
  readonly doseDisplay: string | null;
  readonly doseUnit: DoseUnit;
  readonly foodRule: FoodRule;
  readonly instructions: string | null;
  readonly prn: boolean;
  readonly maxDailyDoses: number | null;
  readonly minimumIntervalMinutes: number | null;
  readonly activeFromDay: number;
  readonly activeToDay: number;
  readonly rules: readonly PlanRule[];
}

/** A change of plan that is not in force yet: still being written, or waiting for the patient. */
export interface PendingChange {
  readonly revisionId: string;
  readonly status: 'DRAFT' | 'CONFIRMED';
}

/** A course with everything needed to show it to its doctor or its patient. */
export interface CoursePlan {
  readonly course: Course;
  readonly patient: { readonly firstName: string; readonly lastName: string };
  readonly clinician: { readonly firstName: string; readonly lastName: string };
  readonly medications: readonly PlanMedication[];
  /** When the course was on hold; the last one is open while it still is. */
  readonly pauses: readonly Pause[];
  /** The patient is told of a change only once the doctor has signed it off. */
  readonly change: PendingChange | null;
}

/** Whose eyes a plan is read for: a doctor also sees their own unfinished change. */
export type PlanViewer = 'CLINICIAN' | 'PATIENT';

export interface PlanProblemView {
  readonly code: PlanProblemCode;
  /** The medication it concerns, by the name the doctor gave it. */
  readonly medicationName?: string;
}

export type AddMedicationResult =
  | { readonly status: 'ADDED'; readonly medicationId: string }
  /** Not this doctor's draft, or no longer a draft. */
  | { readonly status: 'NOT_EDITABLE' }
  | { readonly status: 'LIMIT' };

export type SetDurationResult =
  | { readonly status: 'OK' }
  | { readonly status: 'NOT_EDITABLE' }
  /** A medication is prescribed for days the shorter course would not have. */
  | { readonly status: 'CONFLICT'; readonly medicationName: string };

export type SendResult =
  | {
      readonly status: 'SENT';
      readonly plan: CoursePlan;
      readonly patient: { readonly telegramUserId: number; readonly locale: 'ru' | 'uz' };
    }
  | { readonly status: 'INVALID'; readonly problems: readonly PlanProblemView[] }
  | { readonly status: 'NOT_EDITABLE' };

export interface ClinicianCourse {
  readonly courseId: string;
  readonly status: CourseStatus;
  readonly durationDays: number;
  readonly createdAt: Date;
  readonly patient: { readonly firstName: string; readonly lastName: string };
}

function requireClinician(actor: Actor): string {
  if (actor.kind !== 'CLINICIAN') {
    throw new ForbiddenError('only a doctor writes a course');
  }
  return actor.userId;
}

function assertDuration(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RangeError('a course lasts 1-365 days');
  }
}

/** "08:00" and "08:00:00" are the same time: stored and compared in the long form. */
function normalizeTime(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

/**
 * Refuses anything the wizard should never have let through. The bot checks the same things
 * first and explains them to the doctor; this is the backstop, so a mistake there cannot put a
 * malformed medication into a prescription.
 */
function assertMedication(input: NewMedication, durationDays: number): void {
  const name = input.displayName.trim();
  if (name.length === 0 || Array.from(name).length > MAX_MEDICATION_NAME_LENGTH) {
    throw new RangeError('the medication name must be 1-120 characters');
  }
  const scaled = input.doseValue * 1000;
  if (
    !Number.isFinite(input.doseValue) ||
    input.doseValue <= 0 ||
    input.doseValue > MAX_DOSE_VALUE ||
    Math.abs(scaled - Math.round(scaled)) > 1e-6
  ) {
    throw new RangeError('the dose must be a positive number with at most three decimals');
  }
  const display = input.doseDisplay?.trim() ?? '';
  if (Array.from(display).length > MAX_DOSE_DISPLAY_LENGTH) {
    throw new RangeError('the dose wording is too long');
  }
  if (input.doseUnit === 'OTHER' && display.length === 0) {
    throw new RangeError('a dose in another unit needs its wording');
  }
  if (Array.from(input.instructions?.trim() ?? '').length > MAX_INSTRUCTIONS_LENGTH) {
    throw new RangeError('the instructions are too long');
  }
  if (
    !Number.isInteger(input.activeFromDay) ||
    !Number.isInteger(input.activeToDay) ||
    input.activeFromDay < 1 ||
    input.activeToDay < input.activeFromDay ||
    input.activeToDay > durationDays
  ) {
    throw new RangeError('the medication days must lie inside the course');
  }

  if (input.schedule.kind === 'PRN') {
    const { maxDailyDoses, minimumIntervalMinutes } = input.schedule;
    if (!Number.isInteger(maxDailyDoses) || maxDailyDoses < 1 || maxDailyDoses > 24) {
      throw new RangeError('an as-needed medication may be taken 1-24 times a day');
    }
    if (
      !Number.isInteger(minimumIntervalMinutes) ||
      minimumIntervalMinutes < 1 ||
      minimumIntervalMinutes > 1440
    ) {
      throw new RangeError('the minimum interval must be 1-1440 minutes');
    }
    return;
  }
  const times = input.schedule.times.map(normalizeTime);
  if (
    times.length === 0 ||
    times.length > MAX_TIMES_PER_DAY ||
    times.some((time) => !isValidLocalTime(time)) ||
    new Set(times).size !== times.length
  ) {
    throw new RangeError('a medication needs 1-12 different times of day');
  }
}

/**
 * Reading a course's plan out of the database: its medications, their schedule rules and the
 * instructions decrypted. Shared by drafting (the doctor) and starting (the patient). It applies
 * no access rule of its own: the caller has already decided that this course may be read.
 */
export function createPlanReader(deps: RepositoryDeps) {
  const { cipher } = deps;

  const decryptInstructions = (row: MedicationRow): string | null =>
    row.instructionsEnc === null
      ? null
      : cipher.decrypt(row.instructionsEnc, fieldAad(TABLE, INSTRUCTIONS, row.id));

  const medicationsOf = async (
    executor: Executor,
    revisionId: string | null,
  ): Promise<{ row: MedicationRow; rules: PlanRule[] }[]> => {
    if (revisionId === null) {
      return [];
    }
    const rows = await executor
      .select()
      .from(courseMedications)
      .where(eq(courseMedications.revisionId, revisionId))
      .orderBy(asc(courseMedications.createdAt), asc(courseMedications.id));
    if (rows.length === 0) {
      return [];
    }
    const rules = await executor
      .select()
      .from(scheduleRules)
      .where(
        inArray(
          scheduleRules.medicationId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(scheduleRules.localTime), asc(scheduleRules.id));
    return rows.map((row) => ({
      row,
      rules: rules
        .filter((rule) => rule.medicationId === row.id)
        .map((rule) => ({
          id: rule.id,
          localTime: rule.localTime,
          daysOfWeek: rule.daysOfWeek,
          dayFrom: rule.dayFrom,
          dayTo: rule.dayTo,
        })),
    }));
  };

  const planOf = async (
    executor: Executor,
    course: Course,
    viewer: PlanViewer,
    revisionId: string | null = course.currentRevisionId,
  ): Promise<CoursePlan | null> => {
    const [patient] = await executor
      .select({ firstName: patientProfiles.firstName, lastName: patientProfiles.lastName })
      .from(patientProfiles)
      .where(eq(patientProfiles.userId, course.patientId));
    const [clinician] = await executor
      .select({ firstName: clinicianProfiles.firstName, lastName: clinicianProfiles.lastName })
      .from(clinicianProfiles)
      .where(eq(clinicianProfiles.userId, course.clinicianId));
    if (patient === undefined || clinician === undefined) {
      return null;
    }
    const medications = await medicationsOf(executor, revisionId);
    const pending =
      course.status === 'ACTIVE' || course.status === 'PAUSED'
        ? await executor
            .select({ revisionId: courseRevisions.id, status: courseRevisions.status })
            .from(courseRevisions)
            .where(
              and(
                eq(courseRevisions.courseId, course.id),
                inArray(courseRevisions.status, ['DRAFT', 'CONFIRMED']),
              ),
            )
        : [];
    const [change] = pending.flatMap((row) =>
      row.status === 'CONFIRMED' || (row.status === 'DRAFT' && viewer === 'CLINICIAN')
        ? [{ revisionId: row.revisionId, status: row.status }]
        : [],
    );
    return {
      course,
      patient,
      clinician,
      pauses: course.startAt === null ? [] : await pausesOf(executor, course.id),
      change: change ?? null,
      medications: medications.map(({ row, rules }) => ({
        id: row.id,
        lineId: row.lineId,
        displayName: row.displayName,
        doseValue: row.doseValue,
        doseDisplay: row.doseDisplay,
        doseUnit: row.doseUnit,
        foodRule: row.foodRule,
        instructions: decryptInstructions(row),
        prn: row.prn,
        maxDailyDoses: row.maxDailyDoses,
        minimumIntervalMinutes: row.minimumIntervalMinutes,
        activeFromDay: row.activeFromDay,
        activeToDay: row.activeToDay,
        rules,
      })),
    };
  };

  return { decryptInstructions, medicationsOf, planOf };
}

/**
 * Checks a plan by the same rules that will later lay it out as doses, and names each problem by
 * the medication it concerns. Empty when the plan can be sent.
 */
export function planProblems(
  course: Pick<Course, 'durationDays' | 'timezone'>,
  medications: readonly { row: MedicationRow; rules: PlanRule[] }[],
): PlanProblemView[] {
  const problems = validatePlan({
    durationDays: course.durationDays,
    timezone: course.timezone,
    medications: toMedicationInputs(medications),
  });
  const nameOf = new Map(medications.map(({ row }) => [row.id, row.displayName]));
  return problems.map((problem) => {
    const name = problem.medicationId === undefined ? undefined : nameOf.get(problem.medicationId);
    return name === undefined
      ? { code: problem.code }
      : { code: problem.code, medicationName: name };
  });
}

/**
 * Copies every medication of one revision into another (which must still be a draft), with its
 * schedule and its instructions. `keepLines` says whether the copies are the same lines of the
 * same course (a change of plan: what is not touched stays the same drug) or lines of their own
 * (a new course written from an old one).
 */
export async function copyMedications(
  deps: RepositoryDeps,
  tx: Executor,
  actor: Actor,
  input: { fromRevisionId: string | null; toRevisionId: string; keepLines: boolean },
): Promise<number> {
  const { audit, cipher, requestId } = deps;
  const { decryptInstructions, medicationsOf } = createPlanReader(deps);
  // Kept in the order the doctor wrote them: rows are listed by creation time.
  const startedAt = Date.now();
  const copies = await medicationsOf(tx, input.fromRevisionId);
  for (const [index, { row, rules }] of copies.entries()) {
    const id = randomUUID();
    const instructions = decryptInstructions(row);
    const [copied] = await tx
      .insert(courseMedications)
      .values({
        ...row,
        id,
        revisionId: input.toRevisionId,
        lineId: input.keepLines ? row.lineId : randomUUID(),
        // Bound to the row it is stored in, so it cannot simply be copied across.
        instructionsEnc:
          instructions === null
            ? null
            : cipher.encrypt(instructions, fieldAad(TABLE, INSTRUCTIONS, id)),
        createdAt: new Date(startedAt + index),
      })
      .returning();
    if (rules.length > 0) {
      await tx.insert(scheduleRules).values(
        rules.map((rule) => ({
          medicationId: id,
          localTime: rule.localTime,
          daysOfWeek: rule.daysOfWeek === null ? null : [...rule.daysOfWeek],
          dayFrom: rule.dayFrom,
          dayTo: rule.dayTo,
        })),
      );
    }
    await audit.record(tx, {
      actor,
      entityType: TABLE,
      entityId: id,
      action: 'CREATE',
      after: copied ?? null,
      changes: ['display_name', 'dose_value', 'dose_unit', 'food_rule', 'schedule'],
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  return copies.length;
}

/** Drafting and sending a course: the doctor's side of a prescription (TZ §5.1, §6.5). */
export function createPlanRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, cipher, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };
  const { medicationsOf, planOf } = createPlanReader(deps);

  const encryptInstructions = (text: string | null | undefined, rowId: string): string | null => {
    const trimmed = text?.trim() ?? '';
    return trimmed.length === 0
      ? null
      : cipher.encrypt(trimmed, fieldAad(TABLE, INSTRUCTIONS, rowId));
  };

  /** This doctor's own draft, if they are still allowed to work on it. */
  const ownDraft = async (
    executor: Executor,
    actor: Actor,
    courseId: string,
    lock: boolean,
  ): Promise<Course | null> => {
    const query = executor
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.id, courseId),
          eq(treatmentCourses.clinicianId, requireClinician(actor)),
          eq(treatmentCourses.status, 'DRAFT'),
          visibleCourses(actor),
        ),
      );
    const [course] = await (lock ? query.for('update') : query);
    return course ?? null;
  };

  /**
   * The plan this doctor may still write in: the only revision of their own draft, or the
   * unsent change of a course that is already running. Null for anything else.
   */
  const editable = async (
    executor: Executor,
    actor: Actor,
    courseId: string,
    lock: boolean,
  ): Promise<{ course: Course; revisionId: string } | null> => {
    const query = executor
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.id, courseId),
          eq(treatmentCourses.clinicianId, requireClinician(actor)),
          inArray(treatmentCourses.status, ['DRAFT', 'ACTIVE', 'PAUSED']),
          visibleCourses(actor),
        ),
      );
    const [course] = await (lock ? query.for('update') : query);
    if (course === undefined) {
      return null;
    }
    if (course.status === 'DRAFT') {
      return course.currentRevisionId === null
        ? null
        : { course, revisionId: course.currentRevisionId };
    }
    const [draft] = await executor
      .select({ id: courseRevisions.id })
      .from(courseRevisions)
      .where(and(eq(courseRevisions.courseId, courseId), eq(courseRevisions.status, 'DRAFT')));
    return draft === undefined ? null : { course, revisionId: draft.id };
  };

  const insertMedication = async (
    tx: Executor,
    actor: Actor,
    revisionId: string,
    input: NewMedication,
  ): Promise<string> => {
    const id = randomUUID();
    const prn = input.schedule.kind === 'PRN';
    const display = input.doseDisplay?.trim() ?? '';
    const [row] = await tx
      .insert(courseMedications)
      .values({
        id,
        revisionId,
        lineId: randomUUID(),
        displayName: input.displayName.trim(),
        doseValue: input.doseValue.toFixed(3),
        doseDisplay: display.length === 0 ? null : display,
        doseUnit: input.doseUnit,
        foodRule: input.foodRule,
        instructionsEnc: encryptInstructions(input.instructions, id),
        prn,
        maxDailyDoses: input.schedule.kind === 'PRN' ? input.schedule.maxDailyDoses : null,
        minimumIntervalMinutes:
          input.schedule.kind === 'PRN' ? input.schedule.minimumIntervalMinutes : null,
        activeFromDay: input.activeFromDay,
        activeToDay: input.activeToDay,
      })
      .returning();
    if (input.schedule.kind === 'TIMES') {
      await tx.insert(scheduleRules).values(
        input.schedule.times.map((time) => ({
          medicationId: id,
          localTime: normalizeTime(time),
        })),
      );
    }
    await audit.record(tx, {
      actor,
      entityType: TABLE,
      entityId: id,
      action: 'CREATE',
      after: row ?? null,
      changes: ['display_name', 'dose_value', 'dose_unit', 'food_rule', 'schedule'],
      ...context,
    });
    return id;
  };

  return {
    /** The doctor's unfinished course for this patient, if there is one. */
    async draftFor(actor: Actor, relationshipId: string): Promise<Course | null> {
      const clinicianId = requireClinician(actor);
      const [course] = await db
        .select()
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.careRelationshipId, relationshipId),
            eq(treatmentCourses.clinicianId, clinicianId),
            eq(treatmentCourses.status, 'DRAFT'),
            visibleCourses(actor),
          ),
        );
      return course ?? null;
    },

    /** The most recent course this doctor actually sent to this patient: something to copy. */
    async lastSent(
      actor: Actor,
      relationshipId: string,
    ): Promise<{ courseId: string; createdAt: Date } | null> {
      const clinicianId = requireClinician(actor);
      const [course] = await db
        .select({ courseId: treatmentCourses.id, createdAt: treatmentCourses.createdAt })
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.careRelationshipId, relationshipId),
            eq(treatmentCourses.clinicianId, clinicianId),
            ne(treatmentCourses.status, 'DRAFT'),
            or(
              isNull(treatmentCourses.cancellationReasonCode),
              ne(treatmentCourses.cancellationReasonCode, DRAFT_DISCARDED),
            ),
            visibleCourses(actor),
          ),
        )
        .orderBy(desc(treatmentCourses.createdAt), desc(treatmentCourses.id))
        .limit(1);
      return course ?? null;
    },

    /**
     * Starts (or continues) the draft for one of the doctor's confirmed patients. There is one
     * draft per patient: asking again returns the same one, untouched, with `created: false`.
     * The schedule is written in the patient's own time zone. With `copyFrom`, the new draft
     * takes its length and medications from a course this doctor sent this patient before.
     * Null if the patient is not this doctor's, or the course to copy is not theirs to copy.
     */
    async openDraft(
      actor: Actor,
      input: { relationshipId: string; durationDays: number; copyFrom?: string },
    ): Promise<{ course: Course; created: boolean } | null> {
      const clinicianId = requireClinician(actor);
      assertDuration(input.durationDays);

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`draft:${input.relationshipId}`}))`,
        );
        const [link] = await tx
          .select({ patientId: careRelationships.patientId, timezone: users.timezone })
          .from(careRelationships)
          .innerJoin(users, eq(users.id, careRelationships.patientId))
          .where(
            and(
              eq(careRelationships.id, input.relationshipId),
              eq(careRelationships.clinicianId, clinicianId),
              eq(careRelationships.status, 'ACTIVE'),
              eq(users.status, 'ACTIVE'),
              activeUser(clinicianId),
              usableClinician(clinicianId),
            ),
          );
        if (link === undefined) {
          return null;
        }
        const [existing] = await tx
          .select()
          .from(treatmentCourses)
          .where(
            and(
              eq(treatmentCourses.careRelationshipId, input.relationshipId),
              eq(treatmentCourses.status, 'DRAFT'),
            ),
          );
        if (existing !== undefined) {
          return { course: existing, created: false };
        }

        let source: Course | undefined;
        if (input.copyFrom !== undefined) {
          [source] = await tx
            .select()
            .from(treatmentCourses)
            .where(
              and(
                eq(treatmentCourses.id, input.copyFrom),
                eq(treatmentCourses.careRelationshipId, input.relationshipId),
                eq(treatmentCourses.clinicianId, clinicianId),
                ne(treatmentCourses.status, 'DRAFT'),
                or(
                  isNull(treatmentCourses.cancellationReasonCode),
                  ne(treatmentCourses.cancellationReasonCode, DRAFT_DISCARDED),
                ),
              ),
            );
          if (source === undefined) {
            return null;
          }
        }

        const course = await createCourseRepository(tx, deps).createDraft(actor, {
          patientId: link.patientId,
          durationDays: source?.durationDays ?? input.durationDays,
          timezone: link.timezone,
        });
        if (source !== undefined && course.currentRevisionId !== null) {
          await copyMedications(deps, tx, actor, {
            fromRevisionId: source.currentRevisionId,
            toRevisionId: course.currentRevisionId,
            // A new course is a new prescription: its lines are its own.
            keepLines: false,
          });
        }
        return { course, created: true };
      });
    },

    /**
     * A course with its medications, for whoever may see it: its doctor (while the relationship
     * lasts), and its patient once it has been sent. Null otherwise.
     */
    async getPlan(actor: Actor, courseId: string): Promise<CoursePlan | null> {
      const [course] = await db
        .select()
        .from(treatmentCourses)
        .where(and(eq(treatmentCourses.id, courseId), visibleCourses(actor)));
      return course === undefined
        ? null
        : planOf(db, course, actor.kind === 'CLINICIAN' ? 'CLINICIAN' : 'PATIENT');
    },

    /**
     * The plan the doctor is writing, as far as it has got: their draft, or the unsent change
     * of a running course (the course itself is unchanged, the medications are the new ones).
     * Null when there is nothing of theirs to write in.
     */
    async getEditable(actor: Actor, courseId: string): Promise<CoursePlan | null> {
      const target = await editable(db, actor, courseId, false);
      return target === null ? null : planOf(db, target.course, 'CLINICIAN', target.revisionId);
    },

    async addMedication(
      actor: Actor,
      courseId: string,
      input: NewMedication,
    ): Promise<AddMedicationResult> {
      requireClinician(actor);
      return db.transaction(async (tx) => {
        const target = await editable(tx, actor, courseId, true);
        if (target === null) {
          return { status: 'NOT_EDITABLE' };
        }
        const { course, revisionId } = target;
        assertMedication(input, course.durationDays);
        const existing = await tx
          .select({ id: courseMedications.id })
          .from(courseMedications)
          .where(eq(courseMedications.revisionId, revisionId));
        if (existing.length >= MAX_MEDICATIONS) {
          return { status: 'LIMIT' };
        }
        return {
          status: 'ADDED',
          medicationId: await insertMedication(tx, actor, revisionId, input),
        };
      });
    },

    /**
     * Takes a medication out of the plan the doctor is writing (a draft, or the unsent change of
     * a running course) and says which course it was in. Null if it is not theirs to remove
     * (someone else's, or the plan is already sent).
     */
    async removeMedication(actor: Actor, medicationId: string): Promise<string | null> {
      requireClinician(actor);
      return db.transaction(async (tx) => {
        const [found] = await tx
          .select({ medication: courseMedications, courseId: courseRevisions.courseId })
          .from(courseMedications)
          .innerJoin(courseRevisions, eq(courseRevisions.id, courseMedications.revisionId))
          .where(eq(courseMedications.id, medicationId));
        const target = found === undefined ? null : await editable(tx, actor, found.courseId, true);
        // Only out of the plan still being written: a medication of the plan in force stays.
        if (found === undefined || target?.revisionId !== found.medication.revisionId) {
          return null;
        }
        await tx.delete(scheduleRules).where(eq(scheduleRules.medicationId, medicationId));
        await tx.delete(courseMedications).where(eq(courseMedications.id, medicationId));
        await audit.record(tx, {
          actor,
          entityType: TABLE,
          entityId: medicationId,
          action: 'DELETE',
          before: found.medication,
          changes: [],
          ...context,
        });
        return found.courseId;
      });
    },

    /**
     * Changes how long the draft lasts. Medications prescribed "for the whole course" follow
     * the new length; one prescribed for particular days that the shorter course would not
     * have is a conflict, and nothing changes.
     */
    async setDuration(
      actor: Actor,
      courseId: string,
      durationDays: number,
    ): Promise<SetDurationResult> {
      requireClinician(actor);
      assertDuration(durationDays);
      return db.transaction(async (tx) => {
        const course = await ownDraft(tx, actor, courseId, true);
        if (course === null) {
          return { status: 'NOT_EDITABLE' };
        }
        const medications = await medicationsOf(tx, course.currentRevisionId);
        for (const { row, rules } of medications) {
          const wholeCourse = row.activeFromDay === 1 && row.activeToDay === course.durationDays;
          const ruleBeyond = rules.some((rule) => rule.dayTo !== null && rule.dayTo > durationDays);
          if (ruleBeyond || (!wholeCourse && row.activeToDay > durationDays)) {
            return { status: 'CONFLICT', medicationName: row.displayName };
          }
        }
        for (const { row } of medications) {
          if (row.activeFromDay === 1 && row.activeToDay === course.durationDays) {
            await tx
              .update(courseMedications)
              .set({ activeToDay: durationDays })
              .where(eq(courseMedications.id, row.id));
          }
        }
        const [after] = await tx
          .update(treatmentCourses)
          .set({ durationDays })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: courseId,
          action: 'UPDATE',
          before: course,
          after: after ?? null,
          changes: ['duration_days'],
          ...context,
        });
        return { status: 'OK' };
      });
    },

    /**
     * Throws a draft away. Nothing is deleted (the history of a course is append-only): the
     * draft is closed as cancelled with its own reason, and since its plan was never confirmed
     * the patient never sees that it existed.
     */
    async discard(actor: Actor, courseId: string, now: Date): Promise<boolean> {
      requireClinician(actor);
      return db.transaction(async (tx) => {
        const course = await ownDraft(tx, actor, courseId, true);
        if (course === null) {
          return false;
        }
        const [after] = await tx
          .update(treatmentCourses)
          .set({ status: 'CANCELLED', endedAt: now, cancellationReasonCode: DRAFT_DISCARDED })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        await tx.insert(courseTransitions).values({
          courseId,
          fromStatus: 'DRAFT',
          toStatus: 'CANCELLED',
          actorKind: actor.kind,
          actorUserId: actorUserId(actor),
          reason: DRAFT_DISCARDED,
          requestId: requestId ?? null,
          at: now,
        });
        await audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: courseId,
          action: 'DISCARD',
          before: course,
          after: after ?? null,
          changes: ['status', 'ended_at', 'cancellation_reason_code'],
          ...context,
        });
        return true;
      });
    },

    /**
     * The doctor signs the plan off and it goes to the patient (DRAFT to PENDING_PATIENT). The
     * plan is checked by the same rules that will later lay it out as doses: an incomplete or
     * self-contradictory plan is never sent. The revision becomes CONFIRMED and so immutable,
     * and the patient gets `windowDays` days to start. No reminders exist until they do.
     */
    async send(
      actor: Actor,
      courseId: string,
      input: { windowDays: number; now: Date },
    ): Promise<SendResult> {
      requireClinician(actor);
      if (!(START_WINDOW_DAYS as readonly number[]).includes(input.windowDays)) {
        throw new RangeError(
          `the start window must be one of ${START_WINDOW_DAYS.join(', ')} days`,
        );
      }
      return db.transaction(async (tx) => {
        const course = await ownDraft(tx, actor, courseId, true);
        const revisionId = course?.currentRevisionId ?? null;
        if (course === null || revisionId === null) {
          return { status: 'NOT_EDITABLE' };
        }
        const [patient] = await tx
          .select({ telegramUserId: users.telegramUserId, locale: users.locale })
          .from(users)
          .where(and(eq(users.id, course.patientId), eq(users.status, 'ACTIVE')));
        if (patient === undefined) {
          return { status: 'NOT_EDITABLE' };
        }

        const medications = await medicationsOf(tx, revisionId);
        const problems = planProblems(course, medications);
        if (problems.length > 0) {
          return { status: 'INVALID', problems };
        }

        await tx
          .update(courseRevisions)
          .set({ status: 'CONFIRMED', confirmedByClinicianAt: input.now })
          .where(eq(courseRevisions.id, revisionId));
        const [sent] = await tx
          .update(treatmentCourses)
          .set({
            status: 'PENDING_PATIENT',
            startWindowFrom: input.now,
            startWindowTo: new Date(input.now.getTime() + input.windowDays * DAY_MS),
          })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        if (sent === undefined) {
          throw new Error('course vanished while being sent');
        }
        await tx.insert(courseTransitions).values({
          courseId,
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_PATIENT',
          actorKind: actor.kind,
          actorUserId: actorUserId(actor),
          requestId: requestId ?? null,
          at: input.now,
        });
        await audit.record(tx, {
          actor,
          entityType: 'course_revisions',
          entityId: revisionId,
          action: 'CONFIRM',
          changes: ['status', 'confirmed_by_clinician_at'],
          ...context,
        });
        await audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: courseId,
          action: 'SEND',
          before: course,
          after: sent,
          changes: ['status', 'start_window_from', 'start_window_to'],
          ...context,
        });

        const plan = await planOf(tx, sent, 'CLINICIAN');
        if (plan === null) {
          throw new Error('a sent course has no patient or doctor');
        }
        return { status: 'SENT', plan, patient };
      });
    },

    /** The doctor's own courses, newest first, with who they are for. Thrown-away drafts are gone. */
    async listForClinician(actor: Actor): Promise<ClinicianCourse[]> {
      const clinicianId = requireClinician(actor);
      const rows = await db
        .select({
          courseId: treatmentCourses.id,
          status: treatmentCourses.status,
          durationDays: treatmentCourses.durationDays,
          createdAt: treatmentCourses.createdAt,
          firstName: patientProfiles.firstName,
          lastName: patientProfiles.lastName,
        })
        .from(treatmentCourses)
        .innerJoin(patientProfiles, eq(patientProfiles.userId, treatmentCourses.patientId))
        .where(
          and(
            eq(treatmentCourses.clinicianId, clinicianId),
            visibleCourses(actor),
            or(
              isNull(treatmentCourses.cancellationReasonCode),
              ne(treatmentCourses.cancellationReasonCode, DRAFT_DISCARDED),
            ),
          ),
        )
        .orderBy(desc(treatmentCourses.createdAt), desc(treatmentCourses.id))
        .limit(LIST_LIMIT);
      return rows.map(({ firstName, lastName, ...course }) => ({
        ...course,
        patient: { firstName, lastName },
      }));
    },

    /** The patient's own courses in the given states, newest first, each with its plan. */
    async listForPatient(
      actor: Actor,
      statuses: readonly CourseStatus[] = ['PENDING_PATIENT', 'ACTIVE', 'PAUSED'],
    ): Promise<CoursePlan[]> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only a patient lists their own courses');
      }
      const courses = await db
        .select()
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.patientId, actor.userId),
            inArray(treatmentCourses.status, [...statuses]),
            visibleCourses(actor),
          ),
        )
        .orderBy(desc(treatmentCourses.createdAt), desc(treatmentCourses.id))
        .limit(PATIENT_LIST_LIMIT);
      const plans: CoursePlan[] = [];
      for (const course of courses) {
        const plan = await planOf(db, course, 'PATIENT');
        if (plan !== null) {
          plans.push(plan);
        }
      }
      return plans;
    },
  };
}

export type PlanRepository = ReturnType<typeof createPlanRepository>;
