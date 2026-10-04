import type { DoseUnit, FoodRule } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import { formatLocalTime } from '@medcourse/schedule';
import { encodeCallback } from './callbacks';
import { doseText } from './dose-text';
import type { Button } from './types';

/** What a reminder is about. Carries no diagnosis: only what to take, how much and when. */
export interface ReminderContent {
  readonly kind: 'DOSE_REMINDER' | 'DOSE_LEAD';
  /** 1 for the first reminder of a dose; higher numbers are repeats. */
  readonly attemptNo: number;
  readonly doseId: string;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date;
  readonly timezone: string;
  readonly medication: {
    readonly displayName: string;
    readonly doseValue: string;
    readonly doseDisplay: string | null;
    readonly doseUnit: DoseUnit;
    readonly foodRule: FoodRule;
    readonly instructions: string | null;
  };
  /** The "later" choices on offer right now, in minutes. */
  readonly snoozeOptions: readonly number[];
}

/** "Amoxicillin — 500 мг, после еды": what to take, as it appears everywhere. */
export function doseLine(
  locale: Locale,
  medication: Pick<
    ReminderContent['medication'],
    'displayName' | 'doseValue' | 'doseDisplay' | 'doseUnit' | 'foodRule'
  >,
): string {
  return `${medication.displayName} — ${doseText(locale, medication)}, ${t(locale, `food.${medication.foodRule}`)}`;
}

/** The three answers under a reminder: took it, later (only the choices that still fit), skip. */
export function doseButtons(
  locale: Locale,
  doseId: string,
  snoozeOptions: readonly number[],
): Button[][] {
  const rows: Button[][] = [
    [
      {
        text: t(locale, 'dose.take'),
        data: encodeCallback({ kind: 'dose', action: 'take', doseId }),
      },
    ],
  ];
  if (snoozeOptions.length > 0) {
    rows.push(
      snoozeOptions.map((minutes) => ({
        text: t(locale, 'dose.later', { n: minutes }),
        data: encodeCallback({ kind: 'doseSnooze', doseId, minutes }),
      })),
    );
  }
  rows.push([
    {
      text: t(locale, 'dose.skip'),
      data: encodeCallback({ kind: 'dose', action: 'skipAsk', doseId }),
    },
  ]);
  return rows;
}

/**
 * A reminder as the patient reads it, in their language and on their clock: what, how much, at
 * what time, the doctor's instruction if there is one, and until when it counts as on time.
 * Plain text. A heads-up before the dose has no buttons: there is nothing to answer yet.
 */
export function reminderMessage(
  locale: Locale,
  reminder: ReminderContent,
): { text: string; buttons: Button[][] | undefined } {
  const time = formatLocalTime(reminder.scheduledAt, reminder.timezone);
  const lines = [
    reminder.kind === 'DOSE_LEAD'
      ? t(locale, 'reminder.lead')
      : t(locale, reminder.attemptNo === 1 ? 'reminder.title' : 'reminder.again'),
    doseLine(locale, reminder.medication),
    t(locale, 'reminder.time', { time }),
  ];
  if (reminder.medication.instructions !== null) {
    lines.push(t(locale, 'card.note', { text: reminder.medication.instructions }));
  }
  if (reminder.kind === 'DOSE_LEAD') {
    return { text: lines.join('\n'), buttons: undefined };
  }
  lines.push(
    '',
    t(locale, 'reminder.until', { time: formatLocalTime(reminder.deadlineAt, reminder.timezone) }),
  );
  return {
    text: lines.join('\n'),
    buttons: doseButtons(locale, reminder.doseId, reminder.snoozeOptions),
  };
}
