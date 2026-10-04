import type { CourseExport, ExportEntry } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  lastCourseDay,
  localDateOf,
  type Adherence,
} from '@medcourse/schedule';
import { doseText } from '@medcourse/telegram';

/** Who asked for the file. Both read the same figures; the file says who it was made for. */
export type ReportAudience = 'patient' | 'doctor';

export interface ReportTable {
  readonly title: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** How the page width is shared between the columns, for a layout that needs to know. */
  readonly widths: readonly number[];
  /** Said instead of the table when it has no rows. */
  readonly empty?: string;
}

/**
 * A course's report as words and tables, in the reader's language, before it becomes a file
 * (TZ §14.3). Both formats are written from this and nothing else, so a CSV and a PDF of the
 * same course at the same moment say the same things.
 */
export interface ReportDocument {
  readonly locale: Locale;
  readonly title: string;
  readonly createdAt: Date;
  /** Who, what course, when. */
  readonly facts: readonly (readonly [label: string, value: string])[];
  readonly figuresTitle: string;
  /** How many doses came due and what became of them, and the percentage. */
  readonly figures: readonly (readonly [label: string, value: string])[];
  /** How the percentage is computed and what it does not mean. Printed with it, always. */
  readonly formula: string;
  readonly medications: ReportTable;
  readonly asNeeded: ReportTable | null;
  readonly reasons: ReportTable | null;
  readonly pauses: ReportTable | null;
  /** Every dose that has an outcome or has come due, oldest first. */
  readonly log: ReportTable;
  readonly notes: readonly string[];
}

/** A percentage as people here write it: "66,7". */
function percentText(percent: number): string {
  return String(percent).replace('.', ',');
}

function adherenceCells(adherence: Adherence, none: string): string[] {
  return [
    String(adherence.occurred),
    String(adherence.taken),
    String(adherence.takenLate),
    String(adherence.skipped),
    String(adherence.missed),
    adherence.percent === null ? none : percentText(adherence.percent),
  ];
}

function outcomeText(locale: Locale, entry: ExportEntry): string {
  switch (entry.status) {
    case null:
      return t(locale, 'rp.outcome.PRN');
    case 'TAKEN':
    case 'TAKEN_LATE':
    case 'SKIPPED':
    case 'MISSED':
      return t(locale, `rp.outcome.${entry.status}`);
    default:
      return t(locale, 'rp.outcome.OPEN');
  }
}

/** When the patient answered: the time alone if it was the day the dose was due. */
function answeredText(entry: ExportEntry, zone: string): string {
  if (entry.status === null || entry.answeredAt === null) {
    return '';
  }
  return localDateOf(entry.answeredAt, zone) === localDateOf(entry.at, zone)
    ? formatLocalTime(entry.answeredAt, zone)
    : formatLocalDateTime(entry.answeredAt, zone);
}

export function buildReport(input: {
  readonly export: CourseExport;
  readonly locale: Locale;
  readonly audience: ReportAudience;
}): ReportDocument {
  const { locale, audience } = input;
  const { report, entries, requestedAt } = input.export;
  const { plan, adherence } = report;
  const { course } = plan;
  const zone = course.timezone;
  const say = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]): string =>
    t(locale, key, params);

  const lastDay =
    course.effectiveStartDate === null
      ? null
      : lastCourseDay({
          effectiveStartDate: course.effectiveStartDate,
          timezone: zone,
          durationDays: course.durationDays,
          pauses: plan.pauses,
        });
  const facts: [string, string][] = [
    [say('rp.fact.patient'), `${plan.patient.firstName} ${plan.patient.lastName}`],
    [say('rp.fact.doctor'), `${plan.clinician.firstName} ${plan.clinician.lastName}`],
    [say('rp.fact.status'), say(`status.${course.status}`)],
    [say('rp.fact.duration'), String(course.durationDays)],
    [
      say('rp.fact.started'),
      course.effectiveStartDate === null
        ? say('rp.fact.notStarted')
        : formatLocalDate(course.effectiveStartDate),
    ],
    ...(course.effectiveStartDate === null
      ? []
      : [
          [
            say('rp.fact.lastDay'),
            lastDay === null ? say('rp.fact.lastDayOpen') : formatLocalDate(lastDay),
          ] satisfies [string, string],
        ]),
    [say('rp.fact.timezone'), zone],
    [say('rp.fact.generated'), formatLocalDateTime(requestedAt, zone)],
    [say('rp.fact.by'), say(`rp.by.${audience}`)],
  ];

  const none = say('rp.fig.noPercent');
  const [occurred = '', taken = '', takenLate = '', skipped = '', missed = '', percent = ''] =
    adherenceCells(adherence, none);
  const figures: [string, string][] = [
    [say('rp.fig.occurred'), occurred],
    [say('rp.fig.taken'), taken],
    [say('rp.fig.takenLate'), takenLate],
    [say('rp.fig.skipped'), skipped],
    [say('rp.fig.missed'), missed],
    [say('rp.fig.percent'), percent],
  ];

  // The dose of a drug as it was last prescribed: a drug taken off the plan since then is no
  // longer in the plan, but its doses are still in the report.
  const doseOfLine = new Map<string, string>();
  for (const entry of entries) {
    doseOfLine.set(entry.lineId, doseText(locale, entry));
  }
  for (const medication of plan.medications) {
    doseOfLine.set(medication.lineId, doseText(locale, medication));
  }

  const medications: ReportTable = {
    title: say('rp.section.medications'),
    headers: [
      say('rp.col.medication'),
      say('rp.col.dose'),
      say('rp.col.occurred'),
      say('rp.col.taken'),
      say('rp.col.takenLate'),
      say('rp.col.skipped'),
      say('rp.col.missed'),
      say('rp.col.percent'),
    ],
    rows: report.byMedication.map((line) => [
      line.displayName,
      doseOfLine.get(line.lineId) ?? '',
      ...adherenceCells(line.adherence, none),
    ]),
    widths: [24, 13, 11, 10, 12, 11, 10, 9],
    empty: say('rp.logEmpty'),
  };

  const asNeeded: ReportTable | null =
    report.prn.length === 0
      ? null
      : {
          title: say('rp.section.asNeeded'),
          headers: [say('rp.col.medication'), say('rp.col.count')],
          rows: report.prn.map((drug) => [drug.displayName, String(drug.count)]),
          widths: [70, 30],
        };

  const reasons: ReportTable | null =
    adherence.skipped === 0
      ? null
      : {
          title: say('rp.section.reasons'),
          headers: [say('rp.col.reason'), say('rp.col.times')],
          rows: (['FORGOT', 'NO_MEDICATION', 'OTHER'] as const).map((reason) => [
            say(`dose.reason.${reason}`),
            String(report.skipReasons[reason]),
          ]),
          widths: [70, 30],
        };

  const pauses: ReportTable | null =
    plan.pauses.length === 0
      ? null
      : {
          title: say('rp.section.pauses'),
          headers: [say('rp.col.from'), say('rp.col.to')],
          rows: plan.pauses.map((pause) => [
            formatLocalDateTime(pause.from, zone),
            pause.to === null ? say('rp.pauseOpen') : formatLocalDateTime(pause.to, zone),
          ]),
          widths: [50, 50],
        };

  const log: ReportTable = {
    title: say('rp.section.log'),
    headers: [
      say('rp.col.date'),
      say('rp.col.time'),
      say('rp.col.medication'),
      say('rp.col.dose'),
      say('rp.col.outcome'),
      say('rp.col.answered'),
      say('rp.col.reason'),
      say('rp.col.comment'),
    ],
    rows: entries.map((entry) => [
      formatLocalDate(localDateOf(entry.at, zone)),
      formatLocalTime(entry.at, zone),
      entry.displayName,
      doseText(locale, entry),
      outcomeText(locale, entry),
      answeredText(entry, zone),
      entry.skipReason === null ? '' : say(`dose.reason.${entry.skipReason}`),
      entry.skipText ?? '',
    ]),
    widths: [11, 7, 20, 11, 15, 12, 11, 13],
    empty: say('rp.logEmpty'),
  };

  return {
    locale,
    title: say('rp.title'),
    createdAt: requestedAt,
    facts,
    figuresTitle: say('rp.section.figures'),
    figures,
    formula: say('report.formula'),
    medications,
    asNeeded,
    reasons,
    pauses,
    log,
    notes: [say('rp.note.times', { zone }), say('rp.note.source')],
  };
}
