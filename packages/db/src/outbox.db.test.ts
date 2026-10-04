import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import {
  MINUTE,
  afterFirstDose,
  startRunningCourse,
  type RunningCourse,
} from '../test/running-course';
import { systemActor } from './access/actor';
import { ForbiddenError } from './access/errors';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

/** The reminder queue as the worker uses it. Each test has its own database row set to itself. */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('outbox test');
const LOCK_MS = 60_000;

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

/** Every reminder that other tests left behind is put out of the way, so each test sees its own. */
async function running(
  options: Parameters<typeof startRunningCourse>[2] = {},
): Promise<RunningCourse> {
  await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
  return startRunningCourse(sql(), repos, options);
}

const claim = (now: Date, limit = 25) =>
  repos.outbox.claimDue(system, { now, limit, lockMs: LOCK_MS });

async function notificationRow(id: string) {
  const [row] = await sql()<
    {
      status: string;
      locked_until: Date | null;
      sent_at: Date | null;
      due_at: Date;
      tries: number;
      last_error: string | null;
    }[]
  >`select status, locked_until, sent_at, due_at, tries, last_error from notifications where id = ${id}`;
  return row;
}

async function doseStatus(doseId: string): Promise<string | undefined> {
  const [row] = await sql()<
    { status: string }[]
  >`select status from scheduled_doses where id = ${doseId}`;
  return row?.status;
}

async function violation(statement: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return error.constraint_name ?? error.code;
    }
    throw error;
  }
  return undefined;
}

describe('taking reminders from the queue', () => {
  it('takes what is due, with everything needed to write the message', async () => {
    const c = await running({ medications: [{ instructions: 'With a glass of water' }] });

    const [reminder, ...rest] = await claim(afterFirstDose(0));

    expect(rest).toEqual([]);
    expect(reminder).toMatchObject({
      kind: 'DOSE_REMINDER',
      attemptNo: 1,
      tries: 0,
      doseId: c.firstDoseId,
      doseStatus: 'SCHEDULED',
      scheduledAt: afterFirstDose(0),
      deadlineAt: afterFirstDose(30),
      courseId: c.courseId,
      courseStatus: 'ACTIVE',
      timezone: 'Asia/Tashkent',
      revisionCurrent: true,
      medication: {
        displayName: 'Testamol',
        doseValue: '500.000',
        doseUnit: 'MG',
        foodRule: 'AFTER_MEAL',
        instructions: 'With a glass of water',
      },
      recipient: {
        userId: c.patientId,
        telegramUserId: c.patientTelegramId,
        locale: 'ru',
        active: true,
      },
      snoozeOptions: [5, 10, 15],
    });
    expect(await notificationRow(reminder?.notificationId ?? '')).toMatchObject({
      status: 'SENDING',
      locked_until: new Date(afterFirstDose(0).getTime() + LOCK_MS),
    });
  });

  it('does not take what is not due yet, nor take the same reminder twice', async () => {
    await running();
    expect(await claim(new Date(afterFirstDose(0).getTime() - 1))).toEqual([]);
    expect(await claim(afterFirstDose(0))).toHaveLength(1);
    expect(await claim(afterFirstDose(0))).toEqual([]);
  });

  it('takes a reminder over when the worker that had it never reported back', async () => {
    await running();
    const [first] = await claim(afterFirstDose(0));

    // Still locked a second before the lock runs out; free a millisecond after it.
    expect(await claim(new Date(afterFirstDose(0).getTime() + LOCK_MS))).toEqual([]);
    const [again] = await claim(new Date(afterFirstDose(0).getTime() + LOCK_MS + 1));

    expect(again?.notificationId).toBe(first?.notificationId);
  });

  it('gives one person one message at a time, and the rest on the next round', async () => {
    const c = await running({
      medications: [{ displayName: 'First' }, { displayName: 'Second' }, { displayName: 'Third' }],
    });

    const rounds = [
      await claim(afterFirstDose(0)),
      await claim(afterFirstDose(0)),
      await claim(afterFirstDose(0)),
      await claim(afterFirstDose(0)),
    ];

    expect(rounds.map((round) => round.length)).toEqual([1, 1, 1, 0]);
    expect(
      rounds
        .flat()
        .map((reminder) => reminder.medication.displayName)
        .sort(),
    ).toEqual(['First', 'Second', 'Third']);
    expect(new Set(rounds.flat().map((reminder) => reminder.recipient.userId))).toEqual(
      new Set([c.patientId]),
    );
  });

  it('takes no more than the limit, across people', async () => {
    await running();
    await startRunningCourse(sql(), repos);
    await startRunningCourse(sql(), repos);

    expect(await claim(afterFirstDose(0), 2)).toHaveLength(2);
    expect(await claim(afterFirstDose(0), 2)).toHaveLength(1);
  });

  it('never hands the same reminder to two workers asking at once', async () => {
    await running();
    for (let index = 0; index < 5; index += 1) {
      await startRunningCourse(sql(), repos);
    }

    const batches = await Promise.all([
      claim(afterFirstDose(0), 4),
      claim(afterFirstDose(0), 4),
      claim(afterFirstDose(0), 4),
    ]);

    const ids = batches.flat().map((reminder) => reminder.notificationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  it('offers only the "later" choices that still fit before the deadline', async () => {
    await running();
    for (const minute of [0, 10]) {
      const [reminder] = await claim(afterFirstDose(minute));
      await repos.outbox.finish(system, reminder?.notificationId ?? '', {
        status: 'SENT',
        at: afterFirstDose(minute),
      });
    }
    // The third reminder, 20 minutes in: ten minutes are left, and one must stay free.
    const [third] = await claim(afterFirstDose(20));
    expect(third).toMatchObject({ attemptNo: 3, snoozeOptions: [5] });
  });

  it('says so when the dose is from a replaced plan or the recipient’s account is closed', async () => {
    const c = await running();
    await sql()`update users set status = 'BLOCKED' where id = ${c.patientId}`;
    const [blocked] = await claim(afterFirstDose(0));
    expect(blocked?.recipient.active).toBe(false);

    const stale = await running();
    // Another revision becomes the course's current one: this dose belongs to the old plan.
    const [revision] = await sql()<{ id: string }[]>`
      insert into course_revisions (course_id, rev_no, created_by)
      values (${stale.courseId}, 2, ${stale.doctorId}) returning id`;
    await sql()`update treatment_courses set current_revision_id = ${revision?.id ?? ''} where id = ${stale.courseId}`;
    const [replaced] = await claim(afterFirstDose(0));
    expect(replaced?.revisionCurrent).toBe(false);
  });

  it('is the system’s alone', async () => {
    const c = await running();
    for (const actor of [c.patient, c.doctor]) {
      await expect(
        repos.outbox.claimDue(actor, { now: afterFirstDose(0), limit: 1, lockMs: LOCK_MS }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        repos.outbox.finish(actor, '00000000-0000-4000-8000-000000000000', {
          status: 'CANCELLED',
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe('reporting what happened to a reminder', () => {
  it('sent: the reminder is marked, the dose becomes announced, and the event is logged once', async () => {
    const c = await running();
    const [reminder] = await claim(afterFirstDose(0));
    const sentAt = new Date(afterFirstDose(0).getTime() + 1500);

    expect(
      await repos.outbox.finish(system, reminder?.notificationId ?? '', {
        status: 'SENT',
        at: sentAt,
      }),
    ).toBe(true);

    expect(await notificationRow(reminder?.notificationId ?? '')).toMatchObject({
      status: 'SENT',
      sent_at: sentAt,
      locked_until: null,
    });
    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
    const events = await sql()<{ event_type: string; actor_kind: string; details: unknown }[]>`
      select event_type, actor_kind, details from dose_events where scheduled_dose_id = ${c.firstDoseId}`;
    expect(events).toEqual([
      { event_type: 'NOTIFIED', actor_kind: 'SYSTEM', details: { attempt: 1 } },
    ]);
  });

  it('a repeated reminder is logged too, and leaves the dose announced', async () => {
    const c = await running();
    const [first] = await claim(afterFirstDose(0));
    await repos.outbox.finish(system, first?.notificationId ?? '', {
      status: 'SENT',
      at: afterFirstDose(0),
    });
    const [second] = await claim(afterFirstDose(10));
    expect(second).toMatchObject({ attemptNo: 2, doseStatus: 'NOTIFIED' });

    await repos.outbox.finish(system, second?.notificationId ?? '', {
      status: 'SENT',
      at: afterFirstDose(10),
    });

    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'NOTIFIED'`;
    expect(events?.n).toBe(2);
  });

  it('a snoozed dose is announced again when its reminder comes back', async () => {
    const c = await running();
    const [first] = await claim(afterFirstDose(0));
    await repos.outbox.finish(system, first?.notificationId ?? '', {
      status: 'SENT',
      at: afterFirstDose(0),
    });
    await repos.answers.snooze(c.patient, {
      doseId: c.firstDoseId,
      now: afterFirstDose(2),
      key: 'outbox-snooze',
      minutes: 5,
    });
    expect(await doseStatus(c.firstDoseId)).toBe('SNOOZED');

    const [back] = await claim(afterFirstDose(7));
    expect(back).toMatchObject({ attemptNo: 4, doseStatus: 'SNOOZED', dueAt: afterFirstDose(7) });
    await repos.outbox.finish(system, back?.notificationId ?? '', {
      status: 'SENT',
      at: afterFirstDose(7),
    });

    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
  });

  it('a heads-up that was sent does not announce the dose', async () => {
    const c = await running();
    await sql()`
      insert into notifications (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at)
      values (${c.courseId}, ${c.firstDoseId}, ${c.patientId}, 'DOSE_LEAD', 1, ${afterFirstDose(-15)})`;
    const [lead] = await claim(afterFirstDose(-15));
    expect(lead?.kind).toBe('DOSE_LEAD');

    await repos.outbox.finish(system, lead?.notificationId ?? '', {
      status: 'SENT',
      at: afterFirstDose(-15),
    });

    expect(await doseStatus(c.firstDoseId)).toBe('SCHEDULED');
  });

  it('to be retried: back in the queue for later, with the failure counted and named', async () => {
    await running();
    const [reminder] = await claim(afterFirstDose(0));
    const retryAt = new Date(afterFirstDose(0).getTime() + 30_000);

    await repos.outbox.finish(system, reminder?.notificationId ?? '', {
      status: 'RETRY',
      at: retryAt,
      error: 'HTTP_429',
    });

    expect(await notificationRow(reminder?.notificationId ?? '')).toEqual({
      status: 'QUEUED',
      locked_until: null,
      sent_at: null,
      due_at: retryAt,
      tries: 1,
      last_error: 'HTTP_429',
    });
    expect(await claim(new Date(retryAt.getTime() - 1))).toEqual([]);
    expect((await claim(retryAt))[0]).toMatchObject({ tries: 1 });
  });

  it('failed for good, or no longer wanted: out of the queue, and the dose is untouched', async () => {
    const failed = await running();
    const [first] = await claim(afterFirstDose(0));
    await repos.outbox.finish(system, first?.notificationId ?? '', {
      status: 'FAILED',
      error: 'HTTP_403',
    });
    expect(await notificationRow(first?.notificationId ?? '')).toMatchObject({
      status: 'FAILED',
      tries: 1,
      last_error: 'HTTP_403',
    });
    expect(await doseStatus(failed.firstDoseId)).toBe('SCHEDULED');

    const cancelled = await running();
    const [second] = await claim(afterFirstDose(0));
    await repos.outbox.finish(system, second?.notificationId ?? '', {
      status: 'CANCELLED',
      reason: 'x'.repeat(200),
    });
    const row = await notificationRow(second?.notificationId ?? '');
    expect(row?.status).toBe('CANCELLED');
    expect(row?.last_error).toHaveLength(60);
    expect(await doseStatus(cancelled.firstDoseId)).toBe('SCHEDULED');
  });

  it('is ignored from a worker that no longer holds the reminder', async () => {
    const c = await running();
    const [reminder] = await claim(afterFirstDose(0));
    const id = reminder?.notificationId ?? '';
    await repos.outbox.finish(system, id, { status: 'SENT', at: afterFirstDose(0) });

    // A second report (the first worker's lock had expired and another one sent it).
    expect(await repos.outbox.finish(system, id, { status: 'FAILED', error: 'HTTP_500' })).toBe(
      false,
    );
    expect(await repos.outbox.finish(system, id, { status: 'SENT', at: afterFirstDose(5) })).toBe(
      false,
    );

    expect(await notificationRow(id)).toMatchObject({ status: 'SENT', sent_at: afterFirstDose(0) });
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events where scheduled_dose_id = ${c.firstDoseId}`;
    expect(events?.n).toBe(1);
    expect(
      await repos.outbox.finish(system, '00000000-0000-4000-8000-000000000000', {
        status: 'SENT',
        at: afterFirstDose(0),
      }),
    ).toBe(false);
  });

  it('does not announce a dose that was answered while its reminder was on the way', async () => {
    const c = await running();
    const [reminder] = await claim(afterFirstDose(0));
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: new Date(afterFirstDose(0).getTime() + 500),
      key: 'outbox-race',
    });

    await repos.outbox.finish(system, reminder?.notificationId ?? '', {
      status: 'SENT',
      at: new Date(afterFirstDose(0).getTime() + MINUTE),
    });

    expect(await doseStatus(c.firstDoseId)).toBe('TAKEN');
  });
});

describe('what the database itself refuses about the queue', () => {
  it('keeps the counters and codes within bounds, and allows the extra attempts of "later"', async () => {
    const c = await running();
    const [row] = await sql()<{ id: string }[]>`
      select id from notifications where scheduled_dose_id = ${c.firstDoseId} limit 1`;
    const id = row?.id ?? '';

    expect(await violation(sql()`update notifications set tries = -1 where id = ${id}`)).toBe(
      'notifications_tries_chk',
    );
    expect(
      await violation(
        sql()`update notifications set last_error = ${'x'.repeat(61)} where id = ${id}`,
      ),
    ).toBe('notifications_last_error_len_chk');
    expect(await violation(sql()`update notifications set attempt_no = 31 where id = ${id}`)).toBe(
      'notifications_attempt_no_chk',
    );
    expect(
      await violation(sql()`update notifications set attempt_no = 30 where id = ${id}`),
    ).toBeUndefined();
  });
});
