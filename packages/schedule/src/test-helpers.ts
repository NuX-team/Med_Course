import { ScheduleError, type ScheduleErrorCode } from './errors';

/** Used by tests only; nothing in the package's public surface imports this. */

export const at = (iso: string): Date => new Date(iso);

/** The code of the ScheduleError an action throws, or 'no error'. Rethrows anything else. */
export function errorCode(action: () => unknown): ScheduleErrorCode | 'no error' {
  try {
    action();
  } catch (error) {
    if (error instanceof ScheduleError) {
      return error.code;
    }
    throw error;
  }
  return 'no error';
}

/** A small seeded generator (mulberry32), so a failing randomised test can be replayed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
