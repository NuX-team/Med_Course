import {
  MAX_DOSE_VALUE,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_MEDICATION_NAME_LENGTH,
  MAX_TIMES_PER_DAY,
} from '@medcourse/db';
import { cleanText } from './names';

/**
 * Reading what a doctor types into the course wizard. Each function returns the value or null;
 * null means "ask again", never "guess". Nothing here decides anything medical: a number is a
 * number, and what was understood is always shown back to the doctor before it is used.
 */

/** "7", "7 дней", "10 kun": a whole number of days, 1-365. */
export function parseDuration(text: string): number | null {
  const match = /^\s*(\d{1,3})\s*(?:\p{L}+\.?)?\s*$/u.exec(text);
  if (match === null) {
    return null;
  }
  const days = Number(match[1]);
  return days >= 1 && days <= 365 ? days : null;
}

export interface ParsedDose {
  readonly value: number;
  /** The doctor's own wording when it is not a plain decimal, e.g. "1/2". */
  readonly display: string | null;
}

/**
 * A single dose as a number: "500", "0,5", "0.5", "1/2" or "1 1/2". The unit is asked
 * separately. A fraction is kept in the doctor's wording and stored rounded to three decimals.
 */
export function parseDose(text: string): ParsedDose | null {
  const input = text.trim();
  let value: number;
  let display: string | null = null;

  const decimal = /^([0-9]{1,7})(?:[.,]([0-9]{1,3}))?$/.exec(input);
  const fraction = /^(?:([0-9]{1,3})\s+)?([0-9]{1,2})\s*\/\s*([0-9]{1,2})$/.exec(input);
  if (decimal !== null) {
    value = Number(`${decimal[1] ?? ''}.${decimal[2] ?? '0'}`);
  } else if (fraction !== null) {
    const whole = Number(fraction[1] ?? 0);
    const numerator = Number(fraction[2]);
    const denominator = Number(fraction[3]);
    if (denominator === 0 || numerator === 0 || numerator >= denominator) {
      return null;
    }
    value = Math.round((whole + numerator / denominator) * 1000) / 1000;
    display =
      fraction[1] === undefined
        ? `${String(numerator)}/${String(denominator)}`
        : `${String(whole)} ${String(numerator)}/${String(denominator)}`;
  } else {
    return null;
  }
  return value > 0 && value <= MAX_DOSE_VALUE ? { value, display } : null;
}

/**
 * Times of day separated by spaces, commas or semicolons: "8 14:30 22.00" gives
 * 08:00, 14:30, 22:00. Sorted, 1-12 of them, no repeats.
 */
export function parseTimes(text: string): string[] | null {
  const tokens = text
    .trim()
    .split(/[\s,;]+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_TIMES_PER_DAY) {
    return null;
  }
  const times: string[] = [];
  for (const token of tokens) {
    const match = /^([0-9]{1,2})(?:[:.]([0-9]{2}))?$/.exec(token);
    const hour = Number(match?.[1]);
    const minute = Number(match?.[2] ?? 0);
    if (match === null || hour > 23 || minute > 59) {
      return null;
    }
    times.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  if (new Set(times).size !== times.length) {
    return null;
  }
  return times.sort();
}

/** Days of the course: "1-5", "с 1 по 5" or a single day "3". Inside the course, in order. */
export function parseDayRange(
  text: string,
  durationDays: number,
): { from: number; to: number } | null {
  const match = /^[^0-9]*([0-9]{1,3})(?:[^0-9.,]+([0-9]{1,3}))?[^0-9]*$/u.exec(text);
  if (match === null) {
    return null;
  }
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  return from >= 1 && to >= from && to <= durationDays ? { from, to } : null;
}

/** How many times a day an as-needed medication may be taken at most: 1-24. */
export function parseDailyLimit(text: string): number | null {
  const match = /^\s*([0-9]{1,2})\s*$/.exec(text);
  const count = Number(match?.[1]);
  return match !== null && count >= 1 && count <= 24 ? count : null;
}

export function cleanMedicationName(text: string): string | null {
  return cleanText(text, MAX_MEDICATION_NAME_LENGTH);
}

export function cleanInstructions(text: string): string | null {
  return cleanText(text, MAX_INSTRUCTIONS_LENGTH);
}

export { formatDose, shortTime } from '@medcourse/telegram';
