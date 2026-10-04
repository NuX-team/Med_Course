import { localSecondsOfDay, secondsOfDay, type LocalTime } from './local-time';

/** A patient's "do not disturb" window, in their own time zone. It may run past midnight. */
export interface QuietHours {
  readonly from: LocalTime;
  readonly to: LocalTime;
}

/**
 * Is `instant` inside the window? The start is inside and the end is outside. A window whose
 * start equals its end is empty, not a full day: a patient cannot silence everything by
 * accident of equal fields.
 */
export function isInQuietHours(instant: Date, quiet: QuietHours, zone: string): boolean {
  const from = secondsOfDay(quiet.from);
  const to = secondsOfDay(quiet.to);
  if (from === to) {
    return false;
  }
  const now = localSecondsOfDay(instant, zone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * The slots that a patient's quiet hours would swallow. A night dose the doctor prescribed is
 * never silently suppressed (TZ §7.10): the conflict is returned so both sides are told.
 */
export function quietHoursConflicts<T extends { readonly scheduledAt: Date }>(
  slots: readonly T[],
  quiet: QuietHours,
  zone: string,
): T[] {
  return slots.filter((slot) => isInQuietHours(slot.scheduledAt, quiet, zone));
}
