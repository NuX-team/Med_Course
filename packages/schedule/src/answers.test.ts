import { describe, expect, it } from 'vitest';
import { EARLY_MARK_WINDOW_MINUTES, classifyAnswer, isOverdue } from './answers';
import { at } from './test-helpers';

const scheduledAt = at('2026-10-02T03:00:00.000Z');
const deadlineAt = at('2026-10-02T03:30:00.000Z');
const classify = (now: string, early?: number) =>
  classifyAnswer({ now: at(now), scheduledAt, deadlineAt }, early);

describe('classifyAnswer', () => {
  it('lets a dose be marked up to an hour early by default', () => {
    expect(EARLY_MARK_WINDOW_MINUTES).toBe(60);
    expect(classify('2026-10-02T01:59:59.999Z')).toBe('TOO_EARLY');
    expect(classify('2026-10-02T02:00:00.000Z')).toBe('ON_TIME');
  });

  it('is on time from the slot until just before the deadline', () => {
    expect(classify('2026-10-02T03:00:00.000Z')).toBe('ON_TIME');
    expect(classify('2026-10-02T03:15:00.000Z')).toBe('ON_TIME');
    expect(classify('2026-10-02T03:29:59.999Z')).toBe('ON_TIME');
  });

  it('is late from the deadline itself (a dose is MISSED from that instant)', () => {
    expect(classify('2026-10-02T03:30:00.000Z')).toBe('LATE');
    expect(classify('2026-10-02T09:00:00.000Z')).toBe('LATE');
  });

  it('honours a different early window', () => {
    expect(classify('2026-10-02T02:44:59.999Z', 15)).toBe('TOO_EARLY');
    expect(classify('2026-10-02T02:45:00.000Z', 15)).toBe('ON_TIME');
    expect(classify('2026-10-02T02:59:59.999Z', 0)).toBe('TOO_EARLY');
    expect(classify('2026-10-02T03:00:00.000Z', 0)).toBe('ON_TIME');
  });
});

describe('isOverdue', () => {
  it('is false before the deadline and true from it', () => {
    expect(isOverdue(deadlineAt, at('2026-10-02T03:29:59.999Z'))).toBe(false);
    expect(isOverdue(deadlineAt, at('2026-10-02T03:30:00.000Z'))).toBe(true);
    expect(isOverdue(deadlineAt, at('2026-10-03T03:30:00.000Z'))).toBe(true);
  });

  it('agrees with classifyAnswer on every minute around the deadline', () => {
    for (let offset = -5; offset <= 5; offset += 1) {
      const now = new Date(deadlineAt.getTime() + offset * 30_000);
      expect(isOverdue(deadlineAt, now)).toBe(
        classifyAnswer({ now, scheduledAt, deadlineAt }) === 'LATE',
      );
    }
  });
});
