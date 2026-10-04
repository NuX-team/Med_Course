import { localDateOf, type LocalDate } from './local-time';
import { generateSlots } from './slots';
import { lastCourseDay } from './timeline';
import type { MedicationInput } from './types';

export type StartWindowState = 'NO_WINDOW' | 'BEFORE' | 'WITHIN' | 'AFTER';

/**
 * Whether a start tap at `now` falls inside the doctor's window. Both ends are inclusive,
 * matching the `BETWEEN` in the start statement (ARCHITECTURE §5.2). Outside the window the
 * course is not started and the patient is pointed to the doctor (D-5).
 */
export function startWindowState(
  now: Date,
  window: { readonly from: Date; readonly to: Date } | null,
): StartWindowState {
  if (window === null) {
    return 'NO_WINDOW';
  }
  if (now < window.from) {
    return 'BEFORE';
  }
  return now <= window.to ? 'WITHIN' : 'AFTER';
}

export interface StartPreview {
  /** Day 1: the local date of the tap. */
  readonly effectiveStartDate: LocalDate;
  readonly lastDay: LocalDate;
  /** Doses still to come today. Zero at 23:59 means day 1 passes without a single reminder. */
  readonly slotsToday: number;
  readonly slotsTotal: number;
  readonly firstSlotAt: Date | null;
}

/**
 * What starting right now would do, for the second step of the two-step start ("N doses left
 * today, start now?", D-7). Uses the same slot generation as the real start, so the preview
 * cannot disagree with what then happens.
 */
export function previewStart(input: {
  readonly now: Date;
  readonly timezone: string;
  readonly durationDays: number;
  readonly medications: readonly MedicationInput[];
}): StartPreview {
  const effectiveStartDate = localDateOf(input.now, input.timezone);
  const timeline = {
    effectiveStartDate,
    timezone: input.timezone,
    durationDays: input.durationDays,
  };
  const slots = generateSlots({ medications: input.medications, timeline, after: input.now });
  const lastDay = lastCourseDay(timeline);

  return {
    effectiveStartDate,
    // Without pauses the end of a course is always known.
    lastDay: lastDay ?? effectiveStartDate,
    slotsToday: slots.filter((slot) => slot.localDate === effectiveStartDate).length,
    slotsTotal: slots.length,
    firstSlotAt: slots[0]?.scheduledAt ?? null,
  };
}
