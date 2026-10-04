import type { DoseUnit } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import type { Button } from './types';

/**
 * A stored dose for showing: the doctor's wording if there is one, otherwise the number without
 * trailing zeros and with a decimal comma ("500", "0,5").
 */
export function formatDose(value: string, display: string | null): string {
  if (display !== null && display.length > 0) {
    return display;
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length === 0 ? whole : `${whole},${trimmed}`;
}

/** "08:00:00" as "08:00". */
export function shortTime(time: string): string {
  return time.slice(0, 5);
}

/** A dose with its unit: "500 мг", "1/2 табл.". */
export function doseText(
  locale: Locale,
  medication: {
    readonly doseValue: string;
    readonly doseDisplay: string | null;
    readonly doseUnit: DoseUnit;
  },
): string {
  return `${formatDose(medication.doseValue, medication.doseDisplay)} ${t(locale, `unit.${medication.doseUnit}`)}`;
}

/** "4 ч" or "30 мин": a whole number of hours when it is one. */
export function intervalText(locale: Locale, minutes: number): string {
  return minutes % 60 === 0
    ? t(locale, 'cw.hours', { n: minutes / 60 })
    : t(locale, 'cw.minutes', { n: minutes });
}

/** Buttons as Telegram wants them. No buttons at all means "leave the message without a keyboard". */
export function replyMarkup(
  buttons: readonly (readonly Button[])[] | undefined,
): { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } | undefined {
  if (buttons === undefined) {
    return undefined;
  }
  return {
    reply_markup: {
      inline_keyboard: buttons.map((row) =>
        row.map(({ text, data }) => ({ text, callback_data: data })),
      ),
    },
  };
}
