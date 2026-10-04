import type { LocalTime } from './local-time';

/** How many fixed times a day the wizard can propose. Anything else the doctor types in. */
export const SUGGESTED_FREQUENCIES = [1, 2, 3, 4] as const;
export type SuggestedFrequency = (typeof SUGGESTED_FREQUENCIES)[number];

const PROPOSALS: Readonly<Record<SuggestedFrequency, readonly LocalTime[]>> = {
  1: ['09:00'],
  2: ['09:00', '21:00'],
  3: ['08:00', '14:00', '20:00'],
  4: ['08:00', '12:00', '16:00', '20:00'],
};

/**
 * Times of day to propose for "N times a day": evenly spread across waking hours. This is a
 * convenience, not medical advice (TZ §5.1, §7.4): the doctor must confirm or replace them, and
 * the system never decides an interval between doses on its own.
 */
export function suggestDailyTimes(timesPerDay: SuggestedFrequency): LocalTime[] {
  return [...PROPOSALS[timesPerDay]];
}
