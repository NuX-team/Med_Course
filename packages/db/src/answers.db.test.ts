import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { afterFirstDose, startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor } from './access/actor';
import { ForbiddenError } from './access/errors';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

/**
 * What a patient does with a dose. The first dose of the course is at `afterFirstDose(0)`
 * (08:00 in Tashkent) and its deadline is half an hour later; reminders are queued for
 * +0, +10 and +20 minutes.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('answer test');
const DEADLINE = afterFirstDose(30);
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(
    testDatabase.db.orm,
    createRepositoryDeps([{ id: 't', key: randomBytes(32) }]),
  );
});

afterAll(async () => {
  await testDatabase.drop();
});

const running = (): Promise<RunningCourse> => startRunningCourse(sql(), repos);

async function doseRow(doseId: string) {
  const [row] = await sql()<
    {
      status: string;
      finalized_at: Date | null;
      missed_at: Date | null;
      late_taken_at: Date | null;
    }[]
  >`select status, finalized_at, missed_at, late_taken_at from scheduled_doses where id = ${doseId}`;
  return row;
}

async function eventsOf(doseId: string) {
  return sql()<
    {
      event_type: string;
      actor_kind: string;
      source: string;
      reason_code: string | null;
      reason_text_enc: string | null;
      occurred_at: Date;
      details: Record<string, unknown> | null;
    }[]
  >`select event_type, actor_kind, source, reason_code, reason_text_enc, occurred_at, details
    from dose_events where scheduled_dose_id = ${doseId} order by recorded_at, occurred_at`;
}

async function remindersOf(doseId: string) {
  return sql()<{ attempt_no: number; status: string; due_at: Date }[]>`
    select attempt_no, status, due_at from notifications
    where scheduled_dose_id = ${doseId} order by attempt_no`;
}

const take = (c: RunningCourse, now: Date, doseId = c.firstDoseId) =>
  repos.answers.take(c.patient, { doseId, now, key: key() });
const skip = (
  c: RunningCourse,
  now: Date,
  reason: 'FORGOT' | 'NO_MEDICATION' | 'OTHER' = 'FORGOT',
) => repos.answers.skip(c.patient, { doseId: c.firstDoseId, now, key: key(), reason });
const snooze = (c: RunningCourse, now: Date, minutes: number) =>
  repos.answers.snooze(c.patient, { doseId: c.firstDoseId, now, key: key(), minutes });
const undo = (c: RunningCourse, now: Date) =>
  repos.answers.undo(c.patient, { doseId: c.firstDoseId, now, key: key() });

describe('"took it"', () => {
  it('before the deadline: the dose is taken, the answer is logged, the other reminders stop', async () => {
    const c = await running();
    const now = afterFirstDose(5);

    const outcome = await take(c, now);

    expect(outcome).toMatchObject({
      result: 'DONE',
      dose: {
        status: 'TAKEN',
        answeredAt: now,
        correctableUntil: afterFirstDose(65),
        medication: { displayName: 'Testamol', doseUnit: 'MG' },
      },
    });
    expect(await doseRow(c.firstDoseId)).toEqual({
      status: 'TAKEN',
      finalized_at: now,
      missed_at: null,
      late_taken_at: null,
    });
    expect(await eventsOf(c.firstDoseId)).toMatchObject([
      { event_type: 'TAKEN', actor_kind: 'PATIENT', source: 'TELEGRAM', occurred_at: now },
    ]);
    expect((await remindersOf(c.firstDoseId)).map((r) => r.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
  });

  it('leaves the reminders of every other dose alone', async () => {
    const c = await running();
    await take(c, afterFirstDose(5));
    const [others] = await sql()<{ queued: number; cancelled: number }[]>`
      select count(*) filter (where status = 'QUEUED')::int as queued,
             count(*) filter (where status = 'CANCELLED')::int as cancelled
      from notifications where course_id = ${c.courseId} and scheduled_dose_id <> ${c.firstDoseId}`;
    expect(others).toEqual({ queued: 39, cancelled: 0 });
  });

  it('twice is once: the second tap changes nothing and logs nothing', async () => {
    const c = await running();
    await take(c, afterFirstDose(5));

    const again = await take(c, afterFirstDose(6));

    expect(again).toMatchObject({ result: 'ALREADY', dose: { status: 'TAKEN' } });
    expect(await eventsOf(c.firstDoseId)).toHaveLength(1);
    expect((await doseRow(c.firstDoseId))?.finalized_at).toEqual(afterFirstDose(5));
  });

  it('many taps at once are one answer', async () => {
    const c = await running();
    const results = await Promise.all(Array.from({ length: 6 }, () => take(c, afterFirstDose(5))));
    expect(results.filter((outcome) => outcome.result === 'DONE')).toHaveLength(1);
    expect(results.filter((outcome) => outcome.result === 'ALREADY')).toHaveLength(5);
    expect(await eventsOf(c.firstDoseId)).toHaveLength(1);
  });

  it('is accepted from an hour before the dose, and refused earlier as a mistap', async () => {
    const early = await running();
    expect(await take(early, afterFirstDose(-61))).toMatchObject({
      result: 'TOO_EARLY',
      dose: { status: 'SCHEDULED' },
    });
    expect(await eventsOf(early.firstDoseId)).toEqual([]);

    expect((await take(early, afterFirstDose(-60))).result).toBe('DONE');
  });

  it('at the deadline itself is already late: the miss stands and "taken late" is added to it', async () => {
    const c = await running();

    const outcome = await take(c, DEADLINE);

    expect(outcome).toMatchObject({
      result: 'DONE',
      dose: { status: 'TAKEN_LATE', answeredAt: DEADLINE },
    });
    expect(await doseRow(c.firstDoseId)).toEqual({
      status: 'TAKEN_LATE',
      finalized_at: DEADLINE,
      missed_at: DEADLINE,
      late_taken_at: DEADLINE,
    });
    expect((await eventsOf(c.firstDoseId)).map((e) => [e.event_type, e.actor_kind])).toEqual([
      ['MISSED', 'SYSTEM'],
      ['LATE_TAKEN', 'PATIENT'],
    ]);
  });

  it('a millisecond before the deadline is still on time', async () => {
    const c = await running();
    expect(await take(c, new Date(DEADLINE.getTime() - 1))).toMatchObject({
      result: 'DONE',
      dose: { status: 'TAKEN' },
    });
  });

  it('after the sweeper has recorded the miss, keeps the moment of the miss', async () => {
    const c = await running();
    await repos.answers.sweepMissed(system, afterFirstDose(45));

    const outcome = await take(c, afterFirstDose(90));

    expect(outcome).toMatchObject({ result: 'DONE', dose: { status: 'TAKEN_LATE' } });
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      missed_at: DEADLINE,
      late_taken_at: afterFirstDose(90),
    });
    expect((await eventsOf(c.firstDoseId)).map((e) => e.event_type)).toEqual([
      'MISSED',
      'LATE_TAKEN',
    ]);
  });

  it('is only for the patient’s own dose in a running course', async () => {
    const c = await running();
    const other = await running();
    const now = afterFirstDose(5);

    expect(await take(other, now, c.firstDoseId)).toEqual({ result: 'NOT_AVAILABLE' });
    expect(await take(c, now, '00000000-0000-4000-8000-000000000000')).toEqual({
      result: 'NOT_AVAILABLE',
    });
    for (const actor of [c.doctor, system]) {
      await expect(
        repos.answers.take(actor, { doseId: c.firstDoseId, now, key: key() }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await doseRow(c.firstDoseId))?.status).toBe('SCHEDULED');
  });

  it('is refused for a course that is not running and for a dose taken off the schedule', async () => {
    const paused = await running();
    await sql()`update treatment_courses set status = 'PAUSED' where id = ${paused.courseId}`;
    const replaced = await running();
    await sql()`update scheduled_doses set status = 'SUPERSEDED' where id = ${replaced.firstDoseId}`;

    expect(await take(paused, afterFirstDose(5))).toEqual({ result: 'NOT_AVAILABLE' });
    expect(await take(replaced, afterFirstDose(5))).toEqual({ result: 'NOT_AVAILABLE' });
    expect(await eventsOf(paused.firstDoseId)).toEqual([]);
  });
});

describe('"skip"', () => {
  it('records the dose as skipped with the reason, and stops its reminders', async () => {
    const c = await running();
    const now = afterFirstDose(3);

    const outcome = await skip(c, now, 'NO_MEDICATION');

    expect(outcome).toMatchObject({
      result: 'DONE',
      dose: { status: 'SKIPPED', skipReason: 'NO_MEDICATION', answeredAt: now },
    });
    expect(await eventsOf(c.firstDoseId)).toMatchObject([
      { event_type: 'SKIPPED', reason_code: 'NO_MEDICATION', reason_text_enc: null },
    ]);
    expect(new Set((await remindersOf(c.firstDoseId)).map((r) => r.status))).toEqual(
      new Set(['CANCELLED']),
    );
  });

  it('keeps the patient’s own words encrypted, readable by the patient and the doctor', async () => {
    const c = await running();
    await repos.answers.skip(c.patient, {
      doseId: c.firstDoseId,
      now: afterFirstDose(3),
      key: key(),
      reason: 'OTHER',
      text: '  Felt sick after the last one  ',
    });

    const [event] = await eventsOf(c.firstDoseId);
    expect(event?.reason_text_enc).not.toBeNull();
    expect(event?.reason_text_enc).not.toContain('sick');
    for (const actor of [c.patient, c.doctor]) {
      const [seen] = await repos.doses.listEvents(actor, c.firstDoseId);
      expect(seen?.reasonText).toBe('Felt sick after the last one');
    }
  });

  it('takes words only with "other", and not too many of them', async () => {
    const c = await running();
    const base = { doseId: c.firstDoseId, now: afterFirstDose(3), key: key() };
    await expect(
      repos.answers.skip(c.patient, { ...base, reason: 'FORGOT', text: 'because' }),
    ).rejects.toThrow(RangeError);
    await expect(
      repos.answers.skip(c.patient, { ...base, reason: 'OTHER', text: 'x'.repeat(301) }),
    ).rejects.toThrow(RangeError);
    expect((await doseRow(c.firstDoseId))?.status).toBe('SCHEDULED');
  });

  it('is too late after the deadline: the dose is a miss, not a skip', async () => {
    const c = await running();
    expect(await skip(c, DEADLINE)).toMatchObject({
      result: 'TOO_LATE',
      dose: { status: 'MISSED' },
    });
    expect((await eventsOf(c.firstDoseId)).map((e) => e.event_type)).toEqual(['MISSED']);
  });

  it('does not replace an answer already given', async () => {
    const c = await running();
    await take(c, afterFirstDose(2));
    expect(await skip(c, afterFirstDose(3))).toMatchObject({
      result: 'ALREADY',
      dose: { status: 'TAKEN' },
    });
  });
});

describe('"later"', () => {
  it('brings the reminder back at the chosen moment and leaves the planned time alone', async () => {
    const c = await running();
    const now = afterFirstDose(5);

    const outcome = await snooze(c, now, 10);

    expect(outcome).toMatchObject({
      result: 'DONE',
      dose: { status: 'SNOOZED', snoozedUntil: afterFirstDose(15), scheduledAt: afterFirstDose(0) },
    });
    // The reminders due up to that moment give way to one at that moment; the later one stays.
    expect(await remindersOf(c.firstDoseId)).toEqual([
      { attempt_no: 1, status: 'CANCELLED', due_at: afterFirstDose(0) },
      { attempt_no: 2, status: 'CANCELLED', due_at: afterFirstDose(10) },
      { attempt_no: 3, status: 'QUEUED', due_at: afterFirstDose(20) },
      { attempt_no: 4, status: 'QUEUED', due_at: afterFirstDose(15) },
    ]);
    expect(await eventsOf(c.firstDoseId)).toMatchObject([
      { event_type: 'SNOOZED', details: { minutes: 10 } },
    ]);
  });

  it('refuses a "later" that would run past the deadline, instead of shortening it', async () => {
    const c = await running();
    // At +20 minutes, 15 more would be +35: past the deadline at +30.
    expect(await snooze(c, afterFirstDose(20), 15)).toMatchObject({
      result: 'SNOOZE_NOT_ALLOWED',
      dose: { status: 'SCHEDULED' },
    });
    // 10 would land exactly on the deadline: a reminder then could not be answered in time.
    expect((await snooze(c, afterFirstDose(20), 10)).result).toBe('SNOOZE_NOT_ALLOWED');
    expect((await snooze(c, afterFirstDose(20), 5)).result).toBe('DONE');
  });

  it('refuses a length that is not on offer', async () => {
    const c = await running();
    for (const minutes of [7, 1, 0, -5, 240]) {
      expect((await snooze(c, afterFirstDose(2), minutes)).result, String(minutes)).toBe(
        'SNOOZE_NOT_ALLOWED',
      );
    }
    expect(await eventsOf(c.firstDoseId)).toEqual([]);
  });

  it('is counted: after three, no more', async () => {
    const c = await running();
    await sql()`update reminder_policies set miss_after_minutes = 120 where course_id = ${c.courseId}`;
    await sql()`update scheduled_doses set deadline_at = ${afterFirstDose(120)} where id = ${c.firstDoseId}`;
    for (const minute of [1, 10, 20]) {
      expect((await snooze(c, afterFirstDose(minute), 5)).result).toBe('DONE');
      // The reminder comes back: the worker announces the dose again.
      await sql()`update scheduled_doses set status = 'NOTIFIED' where id = ${c.firstDoseId}`;
    }
    expect((await snooze(c, afterFirstDose(30), 5)).result).toBe('SNOOZE_NOT_ALLOWED');
    expect((await eventsOf(c.firstDoseId)).filter((e) => e.event_type === 'SNOOZED')).toHaveLength(
      3,
    );
  });

  it('tapped twice is one "later"', async () => {
    const c = await running();
    await snooze(c, afterFirstDose(5), 10);
    expect(await snooze(c, afterFirstDose(6), 5)).toMatchObject({
      result: 'ALREADY',
      dose: { status: 'SNOOZED', snoozedUntil: afterFirstDose(15) },
    });
    expect(await remindersOf(c.firstDoseId)).toHaveLength(4);
  });

  it('is too late after the deadline, and pointless after an answer', async () => {
    const late = await running();
    expect(await snooze(late, DEADLINE, 5)).toMatchObject({
      result: 'TOO_LATE',
      dose: { status: 'MISSED' },
    });
    const answered = await running();
    await take(answered, afterFirstDose(2));
    expect((await snooze(answered, afterFirstDose(3), 5)).result).toBe('ALREADY');
  });
});

describe('taking an answer back', () => {
  it('returns the dose to waiting, restores the reminders still ahead, and keeps the history', async () => {
    const c = await running();
    await take(c, afterFirstDose(5));

    const outcome = await undo(c, afterFirstDose(8));

    expect(outcome).toMatchObject({
      result: 'DONE',
      dose: { status: 'NOTIFIED', answeredAt: null },
    });
    expect(await doseRow(c.firstDoseId)).toMatchObject({ status: 'NOTIFIED', finalized_at: null });
    expect((await remindersOf(c.firstDoseId)).map((r) => [r.attempt_no, r.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'QUEUED'],
      [3, 'QUEUED'],
    ]);
    expect((await eventsOf(c.firstDoseId)).map((e) => e.event_type)).toEqual([
      'TAKEN',
      'CORRECTION',
    ]);
    expect((await eventsOf(c.firstDoseId))[1]).toMatchObject({
      actor_kind: 'PATIENT',
      details: { from: 'TAKEN', to: 'NOTIFIED' },
    });
  });

  it('lets the patient answer again, differently', async () => {
    const c = await running();
    await take(c, afterFirstDose(5));
    await undo(c, afterFirstDose(8));

    expect(await skip(c, afterFirstDose(9), 'FORGOT')).toMatchObject({
      result: 'DONE',
      dose: { status: 'SKIPPED' },
    });
    expect((await eventsOf(c.firstDoseId)).map((e) => e.event_type)).toEqual([
      'TAKEN',
      'CORRECTION',
      'SKIPPED',
    ]);
  });

  it('after the deadline turns the dose into the miss it would have been', async () => {
    const c = await running();
    await take(c, afterFirstDose(25));

    const outcome = await undo(c, afterFirstDose(40));

    expect(outcome).toMatchObject({ result: 'DONE', dose: { status: 'MISSED' } });
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      status: 'MISSED',
      missed_at: DEADLINE,
      finalized_at: DEADLINE,
    });
    // The miss is dated at the deadline, so in the history it comes before the correction.
    expect((await eventsOf(c.firstDoseId)).map((e) => e.event_type)).toEqual([
      'TAKEN',
      'MISSED',
      'CORRECTION',
    ]);
    expect(await take(c, afterFirstDose(41))).toMatchObject({ dose: { status: 'TAKEN_LATE' } });
  });

  it('returns a late "took it" to the miss it was', async () => {
    const c = await running();
    await take(c, afterFirstDose(45));

    expect(await undo(c, afterFirstDose(50))).toMatchObject({
      result: 'DONE',
      dose: { status: 'MISSED' },
    });
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      missed_at: DEADLINE,
      late_taken_at: null,
    });
  });

  it('is possible for an hour after the answer, to the minute, and not after', async () => {
    const onTime = await running();
    await take(onTime, afterFirstDose(5));
    expect((await undo(onTime, afterFirstDose(65))).result).toBe('DONE');

    const late = await running();
    await take(late, afterFirstDose(5));
    expect(await undo(late, new Date(afterFirstDose(65).getTime() + 1))).toMatchObject({
      result: 'NOT_CORRECTABLE',
      dose: { status: 'TAKEN' },
    });
    expect((await eventsOf(late.firstDoseId)).map((e) => e.event_type)).toEqual(['TAKEN']);
  });

  it('does nothing when there is no answer to take back', async () => {
    const c = await running();
    expect(await undo(c, afterFirstDose(5))).toMatchObject({
      result: 'ALREADY',
      dose: { status: 'SCHEDULED' },
    });
    expect(await eventsOf(c.firstDoseId)).toEqual([]);
  });

  it('is the patient’s own to do', async () => {
    const c = await running();
    const other = await running();
    await take(c, afterFirstDose(5));
    expect(
      await repos.answers.undo(other.patient, {
        doseId: c.firstDoseId,
        now: afterFirstDose(6),
        key: key(),
      }),
    ).toEqual({ result: 'NOT_AVAILABLE' });
    await expect(
      repos.answers.undo(c.doctor, { doseId: c.firstDoseId, now: afterFirstDose(6), key: key() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await doseRow(c.firstDoseId))?.status).toBe('TAKEN');
  });
});

describe('the sweeper of missed doses', () => {
  it('turns an unanswered dose into a miss as of its deadline, not of when it ran', async () => {
    const c = await running();
    const sweptAt = afterFirstDose(47);

    const swept = await repos.answers.sweepMissed(system, sweptAt);

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await doseRow(c.firstDoseId)).toEqual({
      status: 'MISSED',
      finalized_at: DEADLINE,
      missed_at: DEADLINE,
      late_taken_at: null,
    });
    expect(await eventsOf(c.firstDoseId)).toMatchObject([
      { event_type: 'MISSED', actor_kind: 'SYSTEM', source: 'SYSTEM', occurred_at: DEADLINE },
    ]);
    expect(new Set((await remindersOf(c.firstDoseId)).map((r) => r.status))).toEqual(
      new Set(['CANCELLED']),
    );
  });

  it('acts at the deadline itself and not a moment before', async () => {
    const c = await running();
    await repos.answers.sweepMissed(system, new Date(DEADLINE.getTime() - 1));
    expect((await doseRow(c.firstDoseId))?.status).toBe('SCHEDULED');
    await repos.answers.sweepMissed(system, DEADLINE);
    expect((await doseRow(c.firstDoseId))?.status).toBe('MISSED');
  });

  it('leaves answered doses, future doses and courses that are not running alone, and repeats safely', async () => {
    const answered = await running();
    await take(answered, afterFirstDose(5));
    const paused = await running();
    await sql()`update treatment_courses set status = 'PAUSED' where id = ${paused.courseId}`;
    const plain = await running();
    const at = afterFirstDose(60);

    await repos.answers.sweepMissed(system, at);
    await repos.answers.sweepMissed(system, at);

    expect((await doseRow(answered.firstDoseId))?.status).toBe('TAKEN');
    expect((await doseRow(paused.firstDoseId))?.status).toBe('SCHEDULED');
    expect((await eventsOf(plain.firstDoseId)).map((e) => e.event_type)).toEqual(['MISSED']);
    const [future] = await sql()<{ n: number }[]>`
      select count(*)::int as n from scheduled_doses
      where course_id = ${plain.courseId} and status = 'SCHEDULED'`;
    expect(future?.n).toBe(13);
  });

  it('is the system’s alone to run', async () => {
    const c = await running();
    for (const actor of [c.patient, c.doctor]) {
      await expect(repos.answers.sweepMissed(actor, DEADLINE)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });
});

describe('looking at a dose', () => {
  it('shows the patient their own dose, and nobody else’s', async () => {
    const c = await running();
    const other = await running();
    expect(await repos.answers.get(c.patient, c.firstDoseId, afterFirstDose(20))).toMatchObject({
      status: 'SCHEDULED',
      // Twenty minutes in, only the shortest "later" still fits before the deadline.
      snoozeOptions: [5],
      timezone: 'Asia/Tashkent',
      scheduledAt: afterFirstDose(0),
      deadlineAt: DEADLINE,
      answeredAt: null,
      correctableUntil: null,
    });
    expect(await repos.answers.get(other.patient, c.firstDoseId, afterFirstDose(0))).toBeNull();
    expect(
      (await repos.answers.get(c.patient, c.firstDoseId, afterFirstDose(0)))?.snoozeOptions,
    ).toEqual([5, 10, 15]);
  });
});
