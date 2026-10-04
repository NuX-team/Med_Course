export type ScheduleErrorCode =
  | 'INVALID_TIME_ZONE'
  | 'INVALID_DATE'
  | 'INVALID_TIME'
  | 'INVALID_PAUSE'
  | 'INVALID_POLICY'
  | 'TIMELINE_TOO_LONG'
  | 'DUPLICATE_SLOT'
  | 'TOO_MANY_SLOTS'
  | 'SNOOZE_NOT_ALLOWED';

/**
 * Thrown for input that no caller should ever pass (a bad zone, an impossible date) and for
 * plans that cannot be materialised. User-facing mistakes in a plan are reported as data by
 * `validatePlan`, not thrown. `code` is stable; `message` is for logs, not for users.
 */
export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  /** Identifiers only (medication, rule), never free text. */
  readonly details: Readonly<Record<string, string>>;

  constructor(code: ScheduleErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    this.details = details;
  }
}
