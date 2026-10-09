import type {
  CoursePlan,
  CourseReport,
  CourseSummary,
  DoseView,
  HistoryPage,
  PlanMedication,
  PrnItem,
  StartOutlook,
} from '@medcourse/db';
import type { ChangeView } from '@medcourse/db';
import type { Adherence } from '@medcourse/schedule';

/**
 * What the app is sent. Plain JSON: dates as ISO-8601 UTC strings (JSON.stringify does that for
 * a Date), times of day as "HH:MM" in the course's own zone. Nothing here is formatted for a
 * reader: the app renders in the person's language. Field names are the contract of
 * docs/MOBILE_API.md and of the Swift models in apps/ios.
 */

export function medicationJson(medication: PlanMedication) {
  return {
    id: medication.id,
    lineId: medication.lineId,
    displayName: medication.displayName,
    doseValue: Number(medication.doseValue),
    doseDisplay: medication.doseDisplay,
    doseUnit: medication.doseUnit,
    foodRule: medication.foodRule,
    instructions: medication.instructions,
    asNeeded: medication.prn,
    maxDailyDoses: medication.maxDailyDoses,
    minimumIntervalMinutes: medication.minimumIntervalMinutes,
    activeFromDay: medication.activeFromDay,
    activeToDay: medication.activeToDay,
    times: [...new Set(medication.rules.map((rule) => rule.localTime.slice(0, 5)))].sort(),
  };
}

export function adherenceJson(adherence: Adherence) {
  return {
    taken: adherence.taken,
    takenLate: adherence.takenLate,
    skipped: adherence.skipped,
    missed: adherence.missed,
    occurred: adherence.occurred,
    percent: adherence.percent,
  };
}

export function courseJson(plan: CoursePlan, adherence: Adherence | null = null) {
  const { course } = plan;
  return {
    id: course.id,
    status: course.status,
    timezone: course.timezone,
    durationDays: course.durationDays,
    startWindowFrom: course.startWindowFrom,
    startWindowTo: course.startWindowTo,
    startedAt: course.startAt,
    firstDay: course.effectiveStartDate,
    endedAt: course.endedAt,
    sentAt: course.createdAt,
    doctor: { firstName: plan.clinician.firstName, lastName: plan.clinician.lastName },
    medications: plan.medications.map(medicationJson),
    pauses: plan.pauses.map((pause) => ({ from: pause.from, to: pause.to })),
    changePending: plan.change?.status === 'CONFIRMED',
    adherence: adherence === null ? null : adherenceJson(adherence),
  };
}

export function summaryJson(summary: CourseSummary) {
  return courseJson(summary.plan, summary.adherence);
}

export function reportJson(report: CourseReport) {
  return {
    byMedication: report.byMedication.map((line) => ({
      lineId: line.lineId,
      displayName: line.displayName,
      adherence: adherenceJson(line.adherence),
    })),
    skipReasons: report.skipReasons,
    asNeeded: report.prn,
  };
}

export function changeJson(change: ChangeView) {
  return {
    medications: change.proposed.medications.map(medicationJson),
    added: change.added.map(medicationJson),
    removed: change.removed.map(medicationJson),
  };
}

export function outlookJson(outlook: StartOutlook) {
  return {
    firstDay: outlook.effectiveStartDate,
    lastDay: outlook.lastDay,
    dosesToday: outlook.slotsToday,
    plannedPerDay: outlook.plannedToday,
    dosesTotal: outlook.slotsTotal,
    firstDoseAt: outlook.firstSlotAt,
  };
}

const OPEN = new Set(['SCHEDULED', 'NOTIFIED', 'SNOOZED']);

export function doseJson(dose: DoseView) {
  return {
    id: dose.doseId,
    courseId: dose.courseId,
    timezone: dose.timezone,
    scheduledAt: dose.scheduledAt,
    deadlineAt: dose.deadlineAt,
    status: dose.status,
    answeredAt: dose.answeredAt,
    correctableUntil: dose.correctableUntil,
    skipReason: dose.skipReason,
    snoozedUntil: dose.snoozedUntil,
    snoozeOptions: dose.snoozeOptions,
    /** Waiting for an answer, or missed and so still open to "taken late". */
    canAnswer: OPEN.has(dose.status) || dose.status === 'MISSED',
    medication: {
      displayName: dose.medication.displayName,
      doseValue: Number(dose.medication.doseValue),
      doseDisplay: dose.medication.doseDisplay,
      doseUnit: dose.medication.doseUnit,
      foodRule: dose.medication.foodRule,
    },
  };
}

export function daysJson(page: HistoryPage) {
  return {
    page: page.page,
    pages: page.pages,
    days: page.days.map((day) => ({
      date: day.date,
      entries: day.entries.map((entry) => ({
        at: entry.at,
        displayName: entry.displayName,
        doseValue: Number(entry.doseValue),
        doseDisplay: entry.doseDisplay,
        doseUnit: entry.doseUnit,
        status: entry.status,
        skipReason: entry.skipReason,
      })),
    })),
  };
}

export function prnJson(item: PrnItem) {
  return {
    medicationId: item.medicationId,
    courseId: item.courseId,
    timezone: item.timezone,
    displayName: item.displayName,
    doseValue: Number(item.doseValue),
    doseDisplay: item.doseDisplay,
    doseUnit: item.doseUnit,
    foodRule: item.foodRule,
    maxDailyDoses: item.maxDailyDoses,
    minimumIntervalMinutes: item.minimumIntervalMinutes,
    takenInDay: item.takenInDay,
    lastTakenAt: item.lastTakenAt,
    undoable: item.undoable,
    overLimit: item.excess !== null,
    withinLimitsFrom: item.withinLimitsFrom,
  };
}
