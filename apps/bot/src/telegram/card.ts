import type { ChangeView, CoursePlan, PlanMedication } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import {
  courseDayAt,
  formatLocalDate,
  formatLocalDateTime,
  lastCourseDay,
} from '@medcourse/schedule';
import { doseText, intervalText, shortTime } from '@medcourse/telegram';
import { fullName } from './session';

export { doseText, intervalText } from '@medcourse/telegram';

/** Telegram cuts a message at 4096 characters; a card longer than this is sent in parts. */
export const MAX_CARD_CHUNK = 3500;

export type CardAudience = 'DOCTOR' | 'PATIENT';

/** The times of day a medication is taken, as the patient's clock shows them: "08:00, 20:00". */
export function timesText(medication: Pick<PlanMedication, 'rules'>): string {
  // The wizard writes one rule per time of day, every day. Rules limited to weekdays or to
  // part of the course cannot be created yet; when they can, this line must say so.
  return [...new Set(medication.rules.map((rule) => shortTime(rule.localTime)))].sort().join(', ');
}

/** One medication as the lines of a prescription. */
export function medicationBlock(
  locale: Locale,
  medication: PlanMedication,
  position: number,
  durationDays: number,
): string {
  const lines = [
    `${String(position)}. ${medication.displayName} — ${doseText(locale, medication)}, ${t(locale, `food.${medication.foodRule}`)}`,
    medication.prn
      ? `   ${t(locale, 'card.prn', {
          max: medication.maxDailyDoses ?? 0,
          interval: intervalText(locale, medication.minimumIntervalMinutes ?? 0),
        })}`
      : `   ${t(locale, 'card.everyDay', { times: timesText(medication) })}`,
  ];
  if (medication.activeFromDay !== 1 || medication.activeToDay !== durationDays) {
    lines.push(
      `   ${t(locale, 'card.days', { from: medication.activeFromDay, to: medication.activeToDay })}`,
    );
  }
  if (medication.instructions !== null) {
    lines.push(`   ${t(locale, 'card.note', { text: medication.instructions })}`);
  }
  return lines.join('\n');
}

/** Until when the patient may start, on the patient's own clock. Null if no window is open. */
export function startDeadline(plan: CoursePlan): string | null {
  const until = plan.course.startWindowTo;
  return until === null ? null : formatLocalDateTime(until, plan.course.timezone);
}

/**
 * A course as text, for its doctor or its patient, in parts that each fit one message. What
 * the two see differs only in the heading: the prescription itself is the same words for both,
 * so the doctor checks exactly what the patient will read.
 */
export function courseCard(
  locale: Locale,
  plan: CoursePlan,
  audience: CardAudience,
  options: {
    /** For a running course: which day it is. */
    readonly now?: Date;
    /** When a patient has several courses on screen: which one this is. */
    readonly ordinal?: number;
    /** A first line of its own, for a plan that is not the one in force. */
    readonly title?: string;
  } = {},
): string[] {
  const { course } = plan;
  const heading: string[] = options.title === undefined ? [] : [options.title];
  if (audience === 'PATIENT') {
    heading.push(
      options.ordinal === undefined
        ? t(locale, 'course.title')
        : t(locale, 'course.titleN', { n: options.ordinal }),
      t(locale, 'card.doctor', { name: fullName(plan.clinician) }),
    );
  } else {
    if (course.status === 'DRAFT') {
      heading.push(t(locale, 'cw.draftTitle'));
    }
    heading.push(t(locale, 'card.patient', { name: fullName(plan.patient) }));
  }
  if (course.status !== 'DRAFT') {
    heading.push(t(locale, 'card.status', { status: t(locale, `status.${course.status}`) }));
  }
  heading.push(t(locale, 'card.duration', { days: course.durationDays }));
  const deadline = startDeadline(plan);
  if (course.status === 'PENDING_PATIENT' && deadline !== null) {
    heading.push(t(locale, 'card.window', { until: deadline }));
  }
  heading.push(...runLines(locale, plan, options.now));

  const blocks = [heading.join('\n')];
  if (plan.medications.length === 0) {
    blocks.push(t(locale, 'card.noMeds'));
  } else {
    plan.medications.forEach((medication, index) => {
      blocks.push(medicationBlock(locale, medication, index + 1, course.durationDays));
    });
    if (plan.medications.some((medication) => !medication.prn)) {
      blocks.push(t(locale, 'card.timezone', { zone: course.timezone }));
    }
  }
  return joinBlocks(blocks);
}

/**
 * For a course that has started: when, until when, and which day today is. The end is counted
 * with the holds, so it moves out by every whole day the course stood still; while a hold is
 * open the end is not known, and the card says so instead of showing a date that will change.
 */
function runLines(locale: Locale, plan: CoursePlan, now: Date | undefined): string[] {
  const { course } = plan;
  if (course.effectiveStartDate === null) {
    return [];
  }
  const timeline = {
    effectiveStartDate: course.effectiveStartDate,
    timezone: course.timezone,
    durationDays: course.durationDays,
    pauses: plan.pauses,
  };
  const started = formatLocalDate(course.effectiveStartDate);
  const lastDay = lastCourseDay(timeline);
  if (lastDay === null) {
    const hold = plan.pauses.find((pause) => pause.to === null);
    return [
      t(locale, 'card.startedOpen', { date: started }),
      ...(course.status === 'PAUSED' && hold !== undefined
        ? [
            t(locale, 'card.pausedSince', {
              since: formatLocalDateTime(hold.from, course.timezone),
            }),
          ]
        : []),
    ];
  }
  const lines = [t(locale, 'card.started', { date: started, last: formatLocalDate(lastDay) })];
  const today = now === undefined ? null : courseDayAt(timeline, now);
  if (course.status === 'ACTIVE' && today?.state === 'IN_PROGRESS') {
    lines.push(t(locale, 'card.day', { day: today.day, days: course.durationDays }));
  }
  return lines;
}

/** What a change of plan adds and takes away, by name. Empty when it changes nothing. */
export function changeLines(locale: Locale, change: ChangeView): string[] {
  const names = (medications: readonly PlanMedication[]): string =>
    medications.map((medication) => medication.displayName).join(', ');
  return [
    ...(change.added.length > 0
      ? [t(locale, 'cw.changeAdded', { names: names(change.added) })]
      : []),
    ...(change.removed.length > 0
      ? [t(locale, 'cw.changeRemoved', { names: names(change.removed) })]
      : []),
  ];
}

/**
 * A proposed plan as the patient is asked about it: who changed it, what is added and removed,
 * the whole new prescription, and the reminder that the old plan runs until they accept.
 */
export function changeProposal(locale: Locale, change: ChangeView, now: Date): string[] {
  const { proposed } = change;
  return joinBlocks([
    [
      t(locale, 'course.changeProposed', { doctor: fullName(proposed.clinician) }),
      ...changeLines(locale, change),
    ].join('\n'),
    ...courseCard(locale, proposed, 'PATIENT', { now, title: t(locale, 'course.changeNewPlan') }),
    t(locale, 'course.changeAsk'),
  ]);
}

/** Packs blocks into as few messages as possible without splitting a block. */
export function joinBlocks(blocks: readonly string[], limit = MAX_CARD_CHUNK): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (candidate.length > limit && current.length > 0) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
