import { ScheduleError } from './errors';
import { isoWeekday, zonedInstant, type LocalDate } from './local-time';
import { courseDays, isPaused, normalizePauses, type CourseTimeline } from './timeline';
import { MAX_SLOTS, type MedicationInput } from './types';

/** One planned moment to take one drug. The plan, laid out on the calendar. */
export interface Slot {
  readonly medicationId: string;
  readonly medicationLineId: string;
  readonly ruleId: string;
  readonly scheduledAt: Date;
  /** The course day this slot belongs to (1-based). */
  readonly courseDay: number;
  readonly localDate: LocalDate;
}

export interface GenerateSlotsInput {
  readonly medications: readonly MedicationInput[];
  readonly timeline: CourseTimeline;
  /**
   * Only slots strictly after this instant are produced. At course start this is the moment of
   * the tap, so a slot already in the past on day 1 is never created and never counted (D-8);
   * when a plan is replaced it is "now", so history is left alone.
   */
  readonly after?: Date;
  readonly maxSlots?: number;
}

/**
 * Lays a plan out on the calendar: every counted day of the course, every rule that applies on
 * it, converted to an instant through the patient's time zone. As-needed (PRN) drugs have no
 * slots. Slots inside a pause are not produced.
 *
 * Deterministic: sorted by time, then medication, then rule. Throws `DUPLICATE_SLOT` if the
 * same drug would be due twice at one instant (the database refuses that too) and
 * `TOO_MANY_SLOTS` past the safety limit.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { medications, timeline, after } = input;
  const limit = input.maxSlots ?? MAX_SLOTS;
  const pauses = normalizePauses(timeline.pauses);

  const slots: Slot[] = [];
  const taken = new Set<string>();

  for (const { day, date } of courseDays(timeline)) {
    const weekday = isoWeekday(date);

    for (const medication of medications) {
      if (medication.prn || day < medication.activeFromDay || day > medication.activeToDay) {
        continue;
      }

      for (const rule of medication.rules) {
        const ruleFrom = rule.dayFrom ?? medication.activeFromDay;
        const ruleTo = rule.dayTo ?? medication.activeToDay;
        if (day < ruleFrom || day > ruleTo) {
          continue;
        }
        if (
          rule.daysOfWeek !== null &&
          rule.daysOfWeek !== undefined &&
          !rule.daysOfWeek.includes(weekday)
        ) {
          continue;
        }

        const scheduledAt = zonedInstant(date, rule.localTime, timeline.timezone);
        if ((after !== undefined && scheduledAt <= after) || isPaused(scheduledAt, pauses)) {
          continue;
        }

        const key = `${medication.lineId}|${String(scheduledAt.getTime())}`;
        if (taken.has(key)) {
          throw new ScheduleError(
            'DUPLICATE_SLOT',
            'a drug would be due twice at the same moment',
            {
              medicationId: medication.id,
              ruleId: rule.id,
            },
          );
        }
        taken.add(key);

        if (slots.length >= limit) {
          throw new ScheduleError('TOO_MANY_SLOTS', 'the plan produces more slots than allowed');
        }
        slots.push({
          medicationId: medication.id,
          medicationLineId: medication.lineId,
          ruleId: rule.id,
          scheduledAt,
          courseDay: day,
          localDate: date,
        });
      }
    }
  }

  return slots.sort(
    (a, b) =>
      a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
      (a.medicationId < b.medicationId ? -1 : a.medicationId > b.medicationId ? 1 : 0) ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );
}
