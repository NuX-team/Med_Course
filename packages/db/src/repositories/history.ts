import {
  localDateOf,
  summarizeAdherence,
  type Adherence,
  type LocalDate,
} from '@medcourse/schedule';
import { and, asc, desc, eq, gt, isNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import { fieldAad } from '../field-cipher';
import type { Executor } from '../orm';
import {
  courseExports,
  courseMedications,
  courseRevisions,
  doseEvents,
  scheduledDoses,
  treatmentCourses,
  type DoseStatus,
} from '../schema';
import type { SkipReason } from './answers';
import type { RepositoryDeps } from './context';
import type { Course } from './courses';
import { createPlanReader, type CoursePlan, type DoseUnit } from './plans';

/** Courses shown in a patient's history at once. */
const HISTORY_LIMIT = 10;
/** Days of a course on one screen. */
export const HISTORY_PAGE_DAYS = 3;
/** The patient's own words for a skip shown to the doctor at once, newest first. */
const OTHER_REASONS_LIMIT = 10;
/** Files one person may ask for in an hour: plenty for a doctor's day, little for a scraper. */
export const MAX_EXPORTS_PER_HOUR = 10;
const EXPORT_WINDOW_MS = 3_600_000;

export type ExportFormat = (typeof courseExports.$inferSelect)['format'];

/** A course and how well its schedule was followed so far. */
export interface CourseSummary {
  readonly plan: CoursePlan;
  readonly adherence: Adherence;
}

export interface MedicationAdherence {
  readonly lineId: string;
  readonly displayName: string;
  readonly adherence: Adherence;
}

/**
 * The summary of one course (TZ §14.3): how many doses were due, taken, taken late, skipped and
 * missed, overall and per drug, why doses were skipped, and what was taken as needed. This is
 * how the schedule was followed, never how the treatment worked.
 */
export interface CourseReport extends CourseSummary {
  readonly byMedication: readonly MedicationAdherence[];
  /** As-needed drugs and how many times each was marked (marks taken back are not counted). */
  readonly prn: readonly { readonly displayName: string; readonly count: number }[];
  readonly skipReasons: Readonly<Record<SkipReason, number>>;
  /** What the patient wrote under "another reason", newest first. */
  readonly otherReasons: readonly {
    readonly at: Date;
    readonly displayName: string;
    readonly text: string;
  }[];
}

export interface HistoryEntry {
  /** A scheduled dose: when it was due. As-needed intake: when it was marked. */
  readonly at: Date;
  readonly displayName: string;
  readonly doseValue: string;
  readonly doseDisplay: string | null;
  readonly doseUnit: DoseUnit;
  /** Null for as-needed intake, which has no slot and no outcome. */
  readonly status: DoseStatus | null;
  readonly skipReason: SkipReason | null;
}

/** A line of a course's report as a file: a dose with everything known about its outcome. */
export interface ExportEntry extends HistoryEntry {
  /** The drug's line: the same drug through every change of plan. */
  readonly lineId: string;
  /** When the patient answered (taken, taken late, skipped); null for a miss and no answer yet. */
  readonly answeredAt: Date | null;
  /** What the patient wrote under "another reason", if anything. */
  readonly skipText: string | null;
}

/**
 * Everything a report file is built from. The figures in `report` follow from `entries` alone:
 * every dose with an outcome is listed, so the percentage can be recomputed by whoever reads it.
 */
export interface CourseExport {
  readonly exportId: string;
  readonly format: ExportFormat;
  readonly requestedAt: Date;
  readonly report: CourseReport;
  /** Oldest first: every dose that has an outcome or has come due, and every as-needed intake. */
  readonly entries: readonly ExportEntry[];
}

export type CourseExportResult =
  | { readonly status: 'READY'; readonly export: CourseExport }
  /** This person has asked for too many files in the last hour. */
  | { readonly status: 'TOO_MANY' };

export interface HistoryDay {
  readonly date: LocalDate;
  readonly entries: readonly HistoryEntry[];
}

export interface HistoryPage {
  readonly plan: CoursePlan;
  /** Newest day first. */
  readonly days: readonly HistoryDay[];
  /** 1-based; page 1 is the most recent days. */
  readonly page: number;
  readonly pages: number;
}

function requireReader(actor: Actor): 'PATIENT' | 'CLINICIAN' {
  if (actor.kind !== 'PATIENT' && actor.kind !== 'CLINICIAN') {
    throw new ForbiddenError('the history of a course is for its patient and its doctor');
  }
  return actor.kind;
}

/**
 * The readers of a course's history over one executor (the database, or a transaction). Not
 * exported: `exportEntries` takes no actor, so it must only ever be reached through
 * `exportCourse`, which has checked who is asking.
 */
function historyOver(db: Executor, deps: RepositoryDeps) {
  const { cipher } = deps;
  const { planOf } = createPlanReader(deps);

  /** A course that has something to show: sent at least, and visible to the reader. */
  const readable = async (actor: Actor, courseId: string): Promise<Course | null> => {
    const [course] = await db
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.id, courseId),
          ne(treatmentCourses.status, 'DRAFT'),
          visibleCourses(actor),
        ),
      );
    return course ?? null;
  };

  const dosesOf = (courseId: string, until?: Date) =>
    db
      .select({
        id: scheduledDoses.id,
        scheduledAt: scheduledDoses.scheduledAt,
        status: scheduledDoses.status,
        finalizedAt: scheduledDoses.finalizedAt,
        lateTakenAt: scheduledDoses.lateTakenAt,
        lineId: scheduledDoses.medicationLineId,
        displayName: courseMedications.displayName,
        doseValue: courseMedications.doseValue,
        doseDisplay: courseMedications.doseDisplay,
        doseUnit: courseMedications.doseUnit,
      })
      .from(scheduledDoses)
      .innerJoin(courseMedications, eq(courseMedications.id, scheduledDoses.medicationId))
      .where(
        and(
          eq(scheduledDoses.courseId, courseId),
          ne(scheduledDoses.status, 'SUPERSEDED'),
          until === undefined ? undefined : lte(scheduledDoses.scheduledAt, until),
        ),
      )
      .orderBy(asc(scheduledDoses.scheduledAt), asc(courseMedications.displayName));

  /** The reason given for each dose that stands as skipped: the newest SKIPPED event of each. */
  const skipsOf = async (
    courseId: string,
  ): Promise<Map<string, { id: string; reason: SkipReason; at: Date; textEnc: string | null }>> => {
    const events = await db
      .select({
        id: doseEvents.id,
        doseId: doseEvents.scheduledDoseId,
        reason: doseEvents.reasonCode,
        at: doseEvents.occurredAt,
        textEnc: doseEvents.reasonTextEnc,
      })
      .from(doseEvents)
      .where(and(eq(doseEvents.courseId, courseId), eq(doseEvents.eventType, 'SKIPPED')))
      .orderBy(asc(doseEvents.recordedAt), asc(doseEvents.occurredAt));
    const latest = new Map<
      string,
      { id: string; reason: SkipReason; at: Date; textEnc: string | null }
    >();
    for (const event of events) {
      if (event.doseId !== null && event.reason !== null) {
        latest.set(event.doseId, {
          id: event.id,
          reason: event.reason,
          at: event.at,
          textEnc: event.textEnc,
        });
      }
    }
    return latest;
  };

  /** As-needed marks of a course that still stand, with the drug each belongs to. */
  const prnOf = async (
    courseId: string,
  ): Promise<
    {
      at: Date;
      lineId: string;
      displayName: string;
      doseValue: string;
      doseDisplay: string | null;
      doseUnit: DoseUnit;
    }[]
  > => {
    const events = await db
      .select({
        id: doseEvents.id,
        eventType: doseEvents.eventType,
        lineId: doseEvents.medicationLineId,
        at: doseEvents.occurredAt,
        details: doseEvents.details,
      })
      .from(doseEvents)
      .where(and(eq(doseEvents.courseId, courseId), isNull(doseEvents.scheduledDoseId)))
      .orderBy(asc(doseEvents.occurredAt), asc(doseEvents.recordedAt));
    if (events.length === 0) {
      return [];
    }
    const cancelled = new Set(
      events
        .filter((event) => event.eventType === 'PRN_CANCELLED')
        .map((event) => (event.details as { cancels?: unknown } | null)?.cancels)
        .filter((id): id is string => typeof id === 'string'),
    );
    // A drug keeps its line through every revision; the newest wording of it is shown.
    const medications = await db
      .select({
        lineId: courseMedications.lineId,
        displayName: courseMedications.displayName,
        doseValue: courseMedications.doseValue,
        doseDisplay: courseMedications.doseDisplay,
        doseUnit: courseMedications.doseUnit,
      })
      .from(courseMedications)
      .innerJoin(courseRevisions, eq(courseRevisions.id, courseMedications.revisionId))
      .where(eq(courseRevisions.courseId, courseId))
      .orderBy(asc(courseRevisions.revNo));
    const byLine = new Map(medications.map((medication) => [medication.lineId, medication]));
    return events.flatMap((event) => {
      const medication = event.lineId === null ? undefined : byLine.get(event.lineId);
      return event.eventType === 'PRN_TAKEN' && !cancelled.has(event.id) && medication !== undefined
        ? [{ at: event.at, ...medication }]
        : [];
    });
  };

  return {
    /**
     * The patient's courses that have a past: everything sent to them that is no longer waiting
     * to be started, newest first, each with its figures.
     */
    async courses(actor: Actor): Promise<CourseSummary[]> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only a patient lists their own history');
      }
      const courses = await db
        .select()
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.patientId, actor.userId),
            notInArray(treatmentCourses.status, ['DRAFT', 'PENDING_PATIENT']),
            visibleCourses(actor),
          ),
        )
        .orderBy(desc(treatmentCourses.createdAt), desc(treatmentCourses.id))
        .limit(HISTORY_LIMIT);
      const summaries: CourseSummary[] = [];
      for (const course of courses) {
        const plan = await planOf(db, course, 'PATIENT');
        if (plan !== null) {
          summaries.push({ plan, adherence: summarizeAdherence(await dosesOf(course.id)) });
        }
      }
      return summaries;
    },

    /** The full summary of one course. Null if it is not this reader's, or is still a draft. */
    async report(actor: Actor, courseId: string): Promise<CourseReport | null> {
      const viewer = requireReader(actor);
      const course = await readable(actor, courseId);
      const plan = course === null ? null : await planOf(db, course, viewer);
      if (course === null || plan === null) {
        return null;
      }
      const doses = await dosesOf(courseId);
      const skips = await skipsOf(courseId);

      const lines = new Map<string, { displayName: string; doses: typeof doses }>();
      for (const dose of doses) {
        const line = lines.get(dose.lineId) ?? { displayName: dose.displayName, doses: [] };
        line.doses.push(dose);
        // The newest wording of a drug that was carried through a change of plan.
        line.displayName = dose.displayName;
        lines.set(dose.lineId, line);
      }

      const skipReasons: Record<SkipReason, number> = { FORGOT: 0, NO_MEDICATION: 0, OTHER: 0 };
      const otherReasons: { at: Date; displayName: string; text: string }[] = [];
      for (const dose of doses) {
        const skip = dose.status === 'SKIPPED' ? skips.get(dose.id) : undefined;
        if (skip === undefined) {
          continue;
        }
        skipReasons[skip.reason] += 1;
        if (skip.textEnc !== null) {
          otherReasons.push({
            at: skip.at,
            displayName: dose.displayName,
            text: cipher.decrypt(skip.textEnc, fieldAad('dose_events', 'reason_text_enc', skip.id)),
          });
        }
      }

      const prnCounts = new Map<string, { displayName: string; count: number }>();
      for (const mark of await prnOf(courseId)) {
        const entry = prnCounts.get(mark.lineId) ?? { displayName: mark.displayName, count: 0 };
        entry.count += 1;
        prnCounts.set(mark.lineId, entry);
      }

      return {
        plan,
        adherence: summarizeAdherence(doses),
        byMedication: [...lines].map(([lineId, line]) => ({
          lineId,
          displayName: line.displayName,
          adherence: summarizeAdherence(line.doses),
        })),
        prn: [...prnCounts.values()],
        skipReasons,
        otherReasons: otherReasons
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, OTHER_REASONS_LIMIT),
      };
    },

    /**
     * The course day by day, newest first: every dose that has come due by `now` with what
     * became of it, and every as-needed intake. Doses still ahead are not history yet.
     */
    async days(
      actor: Actor,
      input: { courseId: string; page: number; now: Date },
    ): Promise<HistoryPage | null> {
      const viewer = requireReader(actor);
      const course = await readable(actor, input.courseId);
      const plan = course === null ? null : await planOf(db, course, viewer);
      if (course === null || plan === null) {
        return null;
      }
      const skips = await skipsOf(course.id);
      const entries: HistoryEntry[] = [
        ...(await dosesOf(course.id, input.now)).map((dose) => ({
          at: dose.scheduledAt,
          displayName: dose.displayName,
          doseValue: dose.doseValue,
          doseDisplay: dose.doseDisplay,
          doseUnit: dose.doseUnit,
          status: dose.status,
          skipReason: dose.status === 'SKIPPED' ? (skips.get(dose.id)?.reason ?? null) : null,
        })),
        ...(await prnOf(course.id)).map(({ lineId: _line, ...mark }) => ({
          ...mark,
          status: null,
          skipReason: null,
        })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime());

      const byDate = new Map<LocalDate, HistoryEntry[]>();
      for (const entry of entries) {
        const date = localDateOf(entry.at, course.timezone);
        byDate.set(date, [...(byDate.get(date) ?? []), entry]);
      }
      const dates = [...byDate.keys()].sort().reverse();
      const pages = Math.max(1, Math.ceil(dates.length / HISTORY_PAGE_DAYS));
      const page = Math.min(Math.max(1, Math.trunc(input.page)), pages);
      return {
        plan,
        days: dates
          .slice((page - 1) * HISTORY_PAGE_DAYS, page * HISTORY_PAGE_DAYS)
          .map((date) => ({ date, entries: byDate.get(date) ?? [] })),
        page,
        pages,
      };
    },

    /**
     * Every line of a report file, oldest first. The caller has already checked who is asking. A dose is listed once it has an outcome or its time has come; one
     * taken ahead of its time has an outcome and is listed, because it counts in the figures.
     */
    async exportEntries(courseId: string, now: Date): Promise<ExportEntry[]> {
      const [course] = await db
        .select({ id: treatmentCourses.id })
        .from(treatmentCourses)
        .where(eq(treatmentCourses.id, courseId));
      if (course === undefined) {
        return [];
      }
      const skips = await skipsOf(courseId);
      const decided: readonly DoseStatus[] = ['TAKEN', 'TAKEN_LATE', 'SKIPPED', 'MISSED'];
      const scheduled = (await dosesOf(courseId))
        .filter((dose) => decided.includes(dose.status) || dose.scheduledAt <= now)
        .map((dose): ExportEntry => {
          const skip = dose.status === 'SKIPPED' ? skips.get(dose.id) : undefined;
          return {
            lineId: dose.lineId,
            at: dose.scheduledAt,
            displayName: dose.displayName,
            doseValue: dose.doseValue,
            doseDisplay: dose.doseDisplay,
            doseUnit: dose.doseUnit,
            status: dose.status,
            skipReason: skip?.reason ?? null,
            answeredAt:
              dose.status === 'TAKEN_LATE'
                ? dose.lateTakenAt
                : dose.status === 'TAKEN' || dose.status === 'SKIPPED'
                  ? dose.finalizedAt
                  : null,
            skipText:
              typeof skip?.textEnc === 'string'
                ? cipher.decrypt(skip.textEnc, fieldAad('dose_events', 'reason_text_enc', skip.id))
                : null,
          };
        });
      const asNeeded = (await prnOf(courseId)).map((mark): ExportEntry => ({
        ...mark,
        status: null,
        skipReason: null,
        answeredAt: mark.at,
        skipText: null,
      }));
      return [...scheduled, ...asNeeded].sort(
        (a, b) => a.at.getTime() - b.at.getTime() || a.displayName.localeCompare(b.displayName),
      );
    },
  };
}

/**
 * What has happened in a course, for the two people entitled to read it: the patient and the
 * doctor treating them (TZ §4.1, §6.1). Doses taken off the schedule by a pause, a cancellation
 * or a change of plan are not history: they were never asked of the patient.
 */
export function createHistoryRepository(db: Executor, deps: RepositoryDeps) {
  const history = historyOver(db, deps);
  return {
    courses: (actor: Actor) => history.courses(actor),
    report: (actor: Actor, courseId: string) => history.report(actor, courseId),
    days: (actor: Actor, input: { courseId: string; page: number; now: Date }) =>
      history.days(actor, input),

    /**
     * The data of a course's report as a file (TZ §14.3), for the same two readers as the
     * summary: the patient and the doctor treating them. Asking is recorded (a row in
     * `course_exports` and the audit trail) in the same transaction that reads the data, and is
     * limited per person per hour. Null if the course is not this reader's.
     */
    async exportCourse(
      actor: Actor,
      input: { courseId: string; format: ExportFormat; now: Date },
    ): Promise<CourseExportResult | null> {
      const viewer = requireReader(actor);
      const requester = actor.kind === 'PATIENT' || actor.kind === 'CLINICIAN' ? actor.userId : '';
      return db.transaction(async (tx) => {
        const inside = historyOver(tx, deps);
        const report = await inside.report(actor, input.courseId);
        if (report === null) {
          return null;
        }
        // One at a time per person, so two taps cannot both slip under the limit.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`export:${requester}`}))`);
        const [recent] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(courseExports)
          .where(
            and(
              eq(courseExports.requestedBy, requester),
              gt(courseExports.createdAt, new Date(input.now.getTime() - EXPORT_WINDOW_MS)),
            ),
          );
        if ((recent?.n ?? 0) >= MAX_EXPORTS_PER_HOUR) {
          return { status: 'TOO_MANY' };
        }

        const entries = await inside.exportEntries(input.courseId, input.now);
        const [row] = await tx
          .insert(courseExports)
          .values({
            courseId: input.courseId,
            requestedBy: requester,
            actorKind: viewer,
            format: input.format,
            createdAt: input.now,
          })
          .returning({ id: courseExports.id });
        if (row === undefined) {
          throw new Error('export insert returned no row');
        }
        await deps.audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: input.courseId,
          action: 'EXPORT',
          changes: [],
          reason: input.format,
          ...(deps.requestId === undefined ? {} : { requestId: deps.requestId }),
        });
        return {
          status: 'READY',
          export: {
            exportId: row.id,
            format: input.format,
            requestedAt: input.now,
            report,
            entries,
          },
        };
      });
    },
  };
}

export type HistoryRepository = ReturnType<typeof createHistoryRepository>;
