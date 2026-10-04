import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertPatient } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { holdLock, waitForBlocked } from '../test/locks';
import { startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
} from './repositories';

/**
 * As-needed (PRN) intake. The course starts at 05:00 on 3 October 2026 in Tashkent and has, next
 * to its scheduled drug, "Painaway": as needed, at most three times in 24 hours, at least four
 * hours apart.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('prn test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

const PAINAWAY: Partial<NewMedication> = {
  displayName: 'Painaway',
  doseValue: 1,
  doseUnit: 'TABLET',
  foodRule: 'ANY',
  schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 },
};

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

interface Scene extends RunningCourse {
  /** The medication row of Painaway in the plan in force. */
  readonly prnId: string;
}

async function running(prn: Partial<NewMedication> = {}): Promise<Scene> {
  const c = await startRunningCourse(sql(), repos, { medications: [{}, { ...PAINAWAY, ...prn }] });
  const [row] = await sql()<{ id: string }[]>`
    select m.id from course_medications m join treatment_courses c on c.current_revision_id = m.revision_id
    where c.id = ${c.courseId} and m.prn`;
  return { ...c, prnId: row?.id ?? '' };
}

const take = (c: Scene, now: Date, actor: Actor = c.patient) =>
  repos.prn.take(actor, { medicationId: c.prnId, now, key: key() });

async function eventsOf(courseId: string) {
  return sql()<
    {
      id: string;
      event_type: string;
      actor_kind: string;
      scheduled_dose_id: string | null;
      details: Record<string, unknown> | null;
      occurred_at: Date;
    }[]
  >`select id, event_type, actor_kind, scheduled_dose_id, details, occurred_at
    from dose_events where course_id = ${courseId} and scheduled_dose_id is null
    order by recorded_at, occurred_at`;
}

async function alertKinds(courseId: string): Promise<string[]> {
  const rows = await sql()<{ kind: string }[]>`
    select kind from doctor_alerts where course_id = ${courseId} order by created_at`;
  return rows.map((row) => row.kind);
}

describe('what the patient is shown', () => {
  it('lists the as-needed drugs of running courses with the doctor’s limits', async () => {
    const c = await running();
    const now = local(1, '09:00');

    expect(await repos.prn.available(c.patient, now)).toEqual([
      {
        medicationId: c.prnId,
        courseId: c.courseId,
        timezone: 'Asia/Tashkent',
        displayName: 'Painaway',
        doseValue: '1.000',
        doseDisplay: null,
        doseUnit: 'TABLET',
        foodRule: 'ANY',
        maxDailyDoses: 3,
        minimumIntervalMinutes: 240,
        takenInDay: 0,
        lastTakenAt: null,
        undoable: null,
        excess: null,
        withinLimitsFrom: now,
      },
    ]);
    expect(await repos.prn.get(c.patient, c.prnId, now)).toMatchObject({ displayName: 'Painaway' });
  });

  it('does not list a drug outside the days it was prescribed for, or of a course that is not running', async () => {
    const short = await running({ activeFromDay: 1, activeToDay: 2 });
    expect(await repos.prn.available(short.patient, local(2, '23:00'))).toHaveLength(1);
    expect(await repos.prn.available(short.patient, local(3, '00:30'))).toEqual([]);
    expect(await repos.prn.get(short.patient, short.prnId, local(3, '00:30'))).toBeNull();
    expect((await take(short, local(3, '00:30'))).status).toBe('NOT_AVAILABLE');

    const paused = await running();
    await repos.lifecycle.pause(paused.doctor, {
      courseId: paused.courseId,
      now: local(1, '07:00'),
      key: key(),
    });
    expect(await repos.prn.available(paused.patient, local(1, '09:00'))).toEqual([]);
    expect((await take(paused, local(1, '09:00'))).status).toBe('NOT_AVAILABLE');
    expect(await eventsOf(paused.courseId)).toEqual([]);
  });
});

describe('marking an intake', () => {
  it('records the fact, counts it, and tells the doctor nothing while it is within the limits', async () => {
    const c = await running();
    const now = local(1, '09:00');

    const result = await take(c, now);

    expect(result).toMatchObject({
      status: 'RECORDED',
      over: null,
      item: {
        takenInDay: 1,
        lastTakenAt: now,
        excess: 'INTERVAL',
        withinLimitsFrom: local(1, '13:00'),
      },
    });
    const events = await eventsOf(c.courseId);
    expect(events).toMatchObject([
      { event_type: 'PRN_TAKEN', actor_kind: 'PATIENT', details: null, occurred_at: now },
    ]);
    if (result.status === 'RECORDED') {
      expect(result.item.undoable).toEqual({ eventId: events[0]?.id, until: local(1, '10:00') });
    }
    expect(await alertKinds(c.courseId)).toEqual([]);
  });

  it('is within the limits again exactly when the minimum interval has passed', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));
    expect((await repos.prn.get(c.patient, c.prnId, local(1, '12:59')))?.excess).toBe('INTERVAL');
    expect((await repos.prn.get(c.patient, c.prnId, local(1, '13:00')))?.excess).toBeNull();
    expect(await take(c, local(1, '13:00'))).toMatchObject({ status: 'RECORDED', over: null });
  });

  it('sooner than the doctor allowed is still recorded, marked as such, and the doctor is told', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));

    const result = await take(c, local(1, '10:30'));

    expect(result).toMatchObject({
      status: 'RECORDED',
      over: 'INTERVAL',
      item: { takenInDay: 2 },
    });
    expect((await eventsOf(c.courseId)).map((event) => event.details)).toEqual([
      null,
      { over: 'INTERVAL' },
    ]);
    expect(await alertKinds(c.courseId)).toEqual(['PRN_OVER']);
    const [alert] = (
      await repos.alerts.claimDue(system, { now: local(1, '10:30'), limit: 50, lockMs: 60_000 })
    ).filter((due) => due.courseId === c.courseId);
    expect(alert).toMatchObject({
      kind: 'PRN_OVER',
      prn: {
        displayName: 'Painaway',
        maxDailyDoses: 3,
        minimumIntervalMinutes: 240,
        takenInDay: 2,
        stillOver: true,
      },
    });
  });

  it('beyond the daily limit counts any 24 hours, not the calendar day', async () => {
    const c = await running();
    await take(c, local(1, '14:00'));
    await take(c, local(1, '18:00'));
    await take(c, local(1, '22:00'));
    expect(await alertKinds(c.courseId)).toEqual([]);

    // 02:00 the next calendar day, four hours on: the interval is kept, the daily limit is not.
    const item = await repos.prn.get(c.patient, c.prnId, local(2, '02:00'));
    expect(item).toMatchObject({
      takenInDay: 3,
      excess: 'DAILY_LIMIT',
      withinLimitsFrom: local(2, '14:00'),
    });
    expect(await take(c, local(2, '02:00'))).toMatchObject({
      status: 'RECORDED',
      over: 'DAILY_LIMIT',
    });
    expect(await alertKinds(c.courseId)).toEqual(['PRN_OVER']);

    // A day after the first mark it no longer counts.
    expect((await repos.prn.get(c.patient, c.prnId, local(2, '18:01')))?.takenInDay).toBe(2);
  });

  it('twice within a minute is one tap made twice', async () => {
    const c = await running();
    const now = local(1, '09:00');
    await take(c, now);

    const again = await take(c, new Date(now.getTime() + 20_000));

    expect(again).toMatchObject({ status: 'ALREADY', item: { takenInDay: 1 } });
    expect(await eventsOf(c.courseId)).toHaveLength(1);
    expect(await alertKinds(c.courseId)).toEqual([]);
  });

  it('redelivered by Telegram records nothing twice', async () => {
    const c = await running();
    const same = key();
    await repos.prn.take(c.patient, { medicationId: c.prnId, now: local(1, '09:00'), key: same });
    // The same tap, arriving again long after.
    const again = await repos.prn.take(c.patient, {
      medicationId: c.prnId,
      now: local(1, '15:00'),
      key: same,
    });
    expect(again.status).toBe('ALREADY');
    expect(await eventsOf(c.courseId)).toHaveLength(1);
  });

  it('by two taps at the very same moment is still recorded once', async () => {
    const c = await running();
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from treatment_courses where id = ${c.courseId} for update`,
    );
    const taps = [take(c, local(1, '09:00')), take(c, local(1, '09:00'))];
    await waitForBlocked(sql(), 2);
    await held.release();

    const results = await Promise.all(taps);
    expect(results.map((result) => result.status).sort()).toEqual(['ALREADY', 'RECORDED']);
    expect(await eventsOf(c.courseId)).toHaveLength(1);
  });

  it('is the patient’s own to do, and only for an as-needed drug', async () => {
    const c = await running();
    const now = local(1, '09:00');
    const stranger: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };

    expect((await take(c, now, stranger)).status).toBe('NOT_AVAILABLE');
    expect(await repos.prn.get(stranger, c.prnId, now)).toBeNull();
    await expect(take(c, now, c.doctor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.prn.available(system, now)).rejects.toBeInstanceOf(ForbiddenError);

    const [scheduled] = await sql()<{ id: string }[]>`
      select m.id from course_medications m join treatment_courses c on c.current_revision_id = m.revision_id
      where c.id = ${c.courseId} and not m.prn`;
    expect(
      await repos.prn.take(c.patient, { medicationId: scheduled?.id ?? '', now, key: key() }),
    ).toEqual({ status: 'NOT_AVAILABLE' });
    expect(await eventsOf(c.courseId)).toEqual([]);
  });
});

describe('taking a mark back', () => {
  it('adds a cancelling event, and the mark stops counting', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));
    const [mark] = await eventsOf(c.courseId);

    const result = await repos.prn.undo(c.patient, {
      eventId: mark?.id ?? '',
      now: local(1, '09:10'),
    });

    expect(result).toMatchObject({
      status: 'UNDONE',
      item: { takenInDay: 0, lastTakenAt: null, undoable: null, excess: null },
    });
    expect(await eventsOf(c.courseId)).toMatchObject([
      { event_type: 'PRN_TAKEN' },
      {
        event_type: 'PRN_CANCELLED',
        details: { cancels: mark?.id },
        occurred_at: local(1, '09:10'),
      },
    ]);
  });

  it('twice is once, and touches no other mark', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));
    await take(c, local(1, '13:00'));
    const [, second] = await eventsOf(c.courseId);

    await repos.prn.undo(c.patient, { eventId: second?.id ?? '', now: local(1, '13:05') });
    const again = await repos.prn.undo(c.patient, {
      eventId: second?.id ?? '',
      now: local(1, '13:06'),
    });

    expect(again).toMatchObject({ status: 'ALREADY', item: { takenInDay: 1 } });
    expect((await eventsOf(c.courseId)).map((event) => event.event_type)).toEqual([
      'PRN_TAKEN',
      'PRN_TAKEN',
      'PRN_CANCELLED',
    ]);
  });

  it('is possible for an hour, the last minute included, and not after', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));
    const [mark] = await eventsOf(c.courseId);
    const eventId = mark?.id ?? '';

    expect(
      (await repos.prn.undo(c.patient, { eventId, now: new Date(local(1, '10:00').getTime() + 1) }))
        .status,
    ).toBe('NOT_CORRECTABLE');
    expect((await repos.prn.undo(c.patient, { eventId, now: local(1, '10:00') })).status).toBe(
      'UNDONE',
    );
  });

  it('of a mark that went over the limits leaves the doctor nothing to be told', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));
    await take(c, local(1, '10:30'));
    const [, over] = await eventsOf(c.courseId);
    await repos.prn.undo(c.patient, { eventId: over?.id ?? '', now: local(1, '10:35') });

    const [alert] = (
      await repos.alerts.claimDue(system, { now: local(1, '10:35'), limit: 50, lockMs: 60_000 })
    ).filter((due) => due.courseId === c.courseId);
    expect(alert).toMatchObject({ kind: 'PRN_OVER', prn: { takenInDay: 1, stillOver: false } });
  });

  it('is only for the patient who made the mark', async () => {
    const c = await running();
    await take(c, local(1, '09:00'));
    const [mark] = await eventsOf(c.courseId);
    const stranger: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };

    expect(
      await repos.prn.undo(stranger, { eventId: mark?.id ?? '', now: local(1, '09:05') }),
    ).toEqual({ status: 'NOT_AVAILABLE' });
    await expect(
      repos.prn.undo(c.doctor, { eventId: mark?.id ?? '', now: local(1, '09:05') }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await eventsOf(c.courseId)).toHaveLength(1);
  });
});
