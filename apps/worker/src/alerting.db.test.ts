import { randomBytes } from 'node:crypto';
import {
  MAX_NOTICE_TRIES,
  NOTICE_RETRY_MS,
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type Repositories,
} from '@medcourse/db';
import {
  afterFirstDose,
  createTestDatabase,
  insertClinic,
  insertPatient,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t } from '@medcourse/i18n';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runIncidentNotices } from './notices';
import { runReconciliation } from './reconcile';
import { runOutbox } from './reminders';

/**
 * Alerts, checked with failures made on purpose (stage 14): the worker is made to stall, the
 * queue to fall behind, Telegram to refuse, and each time the question is whether the people who
 * handle it are told, once, in their own language, with nothing about a patient in the message.
 */

let testDatabase: TestDatabase;
let repos: Repositories;
let course: RunningCourse;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
const logger = createLogger({ service: 'alerting-test', level: 'silent' });
const system = systemActor('alerting test');
const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
const MINUTE = 60_000;

class Telegram {
  readonly sent: { chatId: number; text: string }[] = [];
  /** Telegram answers with this for these chats. */
  refuse = new Set<number>();
  sendMessage(chatId: number, text: string): Promise<unknown> {
    if (this.refuse.has(chatId)) {
      return Promise.reject(
        Object.assign(new Error('https://api.telegram.org/bot1:x/send'), { error_code: 403 }),
      );
    }
    this.sent.push({ chatId, text });
    return Promise.resolve({ message_id: this.sent.length });
  }
  to(chatId: number): string[] {
    return this.sent.filter((message) => message.chatId === chatId).map((message) => message.text);
  }
}
let telegram: Telegram;

let telegramId = 91_000_000;
async function admin(locale: 'ru' | 'uz' = 'ru'): Promise<{ userId: string; chatId: number }> {
  telegramId += 1;
  const userId = await insertPatient(sql(), { telegramId });
  await sql()`update users set locale = ${locale} where id = ${userId}`;
  await repos.platform.grantTechAdmin(system, userId);
  return { userId, chatId: telegramId };
}
async function desk(
  clinicId: string,
  locale: 'ru' | 'uz' = 'ru',
): Promise<{ userId: string; chatId: number }> {
  telegramId += 1;
  const userId = await insertPatient(sql(), { telegramId });
  await sql()`update users set locale = ${locale} where id = ${userId}`;
  await repos.panel.addClinicStaff(system, {
    clinicId,
    telegramUserId: telegramId,
    role: 'RECEPTION',
  });
  return { userId, chatId: telegramId };
}

const notices = (now: Date) =>
  runIncidentNotices({ orm: orm(), repositoryDeps, api: telegram, now, logger });

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(orm(), repositoryDeps);
  course = await startRunningCourse(sql(), repos);
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(async () => {
  telegram = new Telegram();
  // Each test starts with nothing to announce and nobody on the staff.
  await sql()`update incidents set notified_at = now() where notified_at is null`;
  await sql()`update platform_staff set status = 'REVOKED'`;
  await sql()`update clinic_staff set status = 'REVOKED'`;
});

describe('the service falls behind', () => {
  it('a stalled worker is announced to the technical administrators, once, with no patient in it', async () => {
    const first = await admin('ru');
    const second = await admin('uz');
    // The worker is down: the 08:00 reminders (08:00, 08:10, 08:20) are 45 minutes overdue and
    // one dose is past its deadline with nobody to record it as missed.
    const now = afterFirstDose(45);

    expect(await runReconciliation({ orm: orm(), repositoryDeps, now, logger })).toBe(2);
    const first_round = await notices(now);

    expect(first_round).toEqual({ incidents: 2, delivered: 4, failed: 0 });
    for (const [person, locale] of [
      [first, 'ru'],
      [second, 'uz'],
    ] as const) {
      expect(telegram.to(person.chatId).sort()).toEqual(
        [
          t(locale, 'incident.notice', { what: t(locale, 'pn.inc.type.QUEUE_LATE') }),
          t(locale, 'incident.notice', { what: t(locale, 'pn.inc.type.SWEEP_LATE') }),
        ].sort(),
      );
    }
    const dump = JSON.stringify(telegram.sent);
    for (const secret of [
      'Aziza',
      'Karimova',
      'Testamol',
      'Rustam',
      course.patientId,
      course.courseId,
    ]) {
      expect(dump).not.toContain(secret);
    }

    // The worker goes on being down: the same facts are not announced again, hour after hour.
    expect(
      await runReconciliation({ orm: orm(), repositoryDeps, now: afterFirstDose(120), logger }),
    ).toBe(0);
    expect(await notices(afterFirstDose(121))).toEqual({ incidents: 0, delivered: 0, failed: 0 });
    expect(telegram.sent).toHaveLength(4);
  });

  it('a reminder the worker took and never reported on is announced as stuck', async () => {
    const person = await admin();
    // Taken at 08:00 with a one-minute reservation; the worker died. Twenty minutes later nobody
    // has put it back, and it is more than ten minutes overdue.
    await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
    await sql()`update incidents set notified_at = now(), status = 'RESOLVED', resolved_at = now(), resolved_by = ${person.userId} where kind = 'TECHNICAL' and status = 'OPEN'`;
    await sql()`delete from incidents where kind = 'TECHNICAL' and dedupe_key like 'QUEUE_STUCK:%'`;
    const claimed = await repos.outbox.claimDue(system, {
      now: afterFirstDose(0),
      limit: 5,
      lockMs: MINUTE,
    });
    expect(claimed).toHaveLength(0);
    // Put one back to be taken, then let its reservation lapse unseen.
    await sql()`
      insert into notifications (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at)
      select course_id, id, ${course.patientId}, 'DOSE_REMINDER', 7, ${afterFirstDose(0)}
      from scheduled_doses where id = ${course.firstDoseId}`;
    await repos.outbox.claimDue(system, { now: afterFirstDose(0), limit: 5, lockMs: MINUTE });
    const later = afterFirstDose(25);

    await runReconciliation({ orm: orm(), repositoryDeps, now: later, logger });
    await notices(later);

    expect(telegram.to(person.chatId)).toContain(
      t('ru', 'incident.notice', { what: t('ru', 'pn.inc.type.QUEUE_STUCK') }),
    );
  });
});

describe('a patient cannot be reached, or does not answer', () => {
  it('a reminder that Telegram refuses for good tells the clinic’s own staff, and nobody else’s', async () => {
    const own = await desk(course.clinicId);
    const otherClinic = await insertClinic(sql());
    const stranger = await desk(otherClinic);
    const tech = await admin();
    await sql()`update notifications set status = 'CANCELLED', locked_until = null where course_id <> ${course.courseId} and status in ('QUEUED', 'SENDING')`;
    // Earlier tests used up this course's reminders: one fresh reminder is due at 08:00.
    await sql()`update notifications set status = 'CANCELLED', locked_until = null where course_id = ${course.courseId} and status in ('QUEUED', 'SENDING')`;
    await sql()`
      insert into notifications (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at)
      select course_id, id, ${course.patientId}, 'DOSE_REMINDER', 8, ${afterFirstDose(0)}
      from scheduled_doses where id = ${course.firstDoseId}`;
    // The patient has stopped the bot: Telegram answers 403 to the first reminder.
    const blocked = {
      sendMessage: () => Promise.reject(Object.assign(new Error('x'), { error_code: 403 })),
    };
    const at = afterFirstDose(0);
    await runOutbox({ orm: orm(), repositoryDeps, api: blocked, logger, now: () => at });

    expect(await notices(at)).toMatchObject({ incidents: 1, delivered: 1, failed: 0 });

    expect(telegram.to(own.chatId)).toEqual([
      t('ru', 'incident.notice', { what: t('ru', 'pn.inc.type.UNDELIVERED') }),
    ]);
    // Another clinic's staff and the technical administrator are not told about a patient.
    expect(telegram.to(stranger.chatId)).toEqual([]);
    expect(telegram.to(tech.chatId)).toEqual([]);
    expect(JSON.stringify(telegram.sent)).not.toContain('Aziza');
  });

  it('three misses in a row tell the clinic’s staff, in their own language', async () => {
    const own = await desk(course.clinicId, 'uz');
    await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
    const day = (n: number, time: string) => {
      const [h, m] = time.split(':').map(Number);
      return new Date(Date.UTC(2026, 9, 2 + n, (h ?? 0) - 5, m ?? 0));
    };
    for (const now of [day(1, '08:30'), day(1, '20:30'), day(2, '08:30')]) {
      while ((await repos.answers.sweepMissed(system, now)) > 0) {
        // until nothing is left
      }
    }

    await notices(day(2, '08:31'));

    expect(telegram.to(own.chatId)).toEqual([
      t('uz', 'incident.notice', { what: t('uz', 'pn.inc.type.MISS_SERIES') }),
    ]);
  });
});

describe('Telegram itself is down', () => {
  it('an incident that reached nobody is tried again after a pause, and stops being tried after a few times', async () => {
    const person = await admin();
    telegram.refuse.add(person.chatId);
    const opened = new Date('2026-10-05T10:00:00Z');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_LATE', 'down-test', '{"reminders": 9}'::jsonb, ${opened})`;

    let at = opened;
    const rounds: number[] = [];
    for (let attempt = 0; attempt < MAX_NOTICE_TRIES + 3; attempt += 1) {
      const result = await notices(at);
      rounds.push(result.incidents);
      // Within the pause nothing is tried again.
      expect((await notices(new Date(at.getTime() + NOTICE_RETRY_MS - 1))).incidents).toBe(0);
      at = new Date(at.getTime() + NOTICE_RETRY_MS);
    }

    // Tried six times in all, a pause apart, and then given up on: the panel still shows it.
    expect(rounds).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(telegram.sent).toEqual([]);
    const [row] = await sql()<{ notice_tries: number; notified_at: Date | null }[]>`
      select notice_tries, notified_at from incidents where dedupe_key = 'down-test'`;
    expect(row?.notice_tries).toBe(MAX_NOTICE_TRIES);
    expect(row?.notified_at).not.toBeNull();
  });

  it('an incident that has used up its tries is not offered again, even when the worker died before saying so', async () => {
    const person = await admin();
    const opened = new Date('2026-10-05T10:30:00Z');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at, notice_tries)
      values ('TECHNICAL', 'QUEUE_LATE', 'spent-test', '{"reminders": 9}'::jsonb, ${opened}, ${MAX_NOTICE_TRIES})`;

    expect(await notices(new Date(opened.getTime() + 60 * MINUTE))).toMatchObject({ incidents: 0 });

    expect(telegram.to(person.chatId)).toEqual([]);
  });

  it('is told as soon as Telegram is back, and then not again', async () => {
    const person = await admin();
    telegram.refuse.add(person.chatId);
    const opened = new Date('2026-10-05T11:00:00Z');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_STUCK', 'back-test', '{"reminders": 2}'::jsonb, ${opened})`;
    expect((await notices(opened)).failed).toBe(1);

    telegram.refuse.clear();
    const retry = new Date(opened.getTime() + NOTICE_RETRY_MS);
    expect(await notices(retry)).toEqual({ incidents: 1, delivered: 1, failed: 0 });
    expect(await notices(new Date(retry.getTime() + 10 * MINUTE))).toMatchObject({ incidents: 0 });
    expect(telegram.to(person.chatId)).toHaveLength(1);
  });

  it('one person refusing does not keep the others from being told, and counts as done', async () => {
    const reachable = await admin();
    const blocked = await admin();
    telegram.refuse.add(blocked.chatId);
    const opened = new Date('2026-10-05T12:00:00Z');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'SWEEP_LATE', 'partial-test', '{"doses": 1}'::jsonb, ${opened})`;

    expect(await notices(opened)).toEqual({ incidents: 1, delivered: 1, failed: 1 });

    expect(telegram.to(reachable.chatId)).toHaveLength(1);
    expect(await notices(new Date(opened.getTime() + 10 * MINUTE))).toMatchObject({ incidents: 0 });
  });

  it('writes the number of failures to the log and nothing of why', async () => {
    const person = await admin();
    telegram.refuse.add(person.chatId);
    const lines: string[] = [];
    const loud = createLogger({
      service: 'alerting-test',
      level: 'info',
      stream: { write: (line) => lines.push(line) },
    });
    const opened = new Date('2026-10-05T13:00:00Z');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_LATE', 'log-test', '{"reminders": 4}'::jsonb, ${opened})`;

    await runIncidentNotices({
      orm: orm(),
      repositoryDeps,
      api: telegram,
      now: opened,
      logger: loud,
    });

    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { level: 'warn', msg: 'incident notices could not be delivered', failed: 1 },
    ]);
    expect(lines.join('')).not.toContain('api.telegram.org');
  });
});

describe('nobody to tell', () => {
  it('an incident with nobody on the staff is left for the panel, and does not come round again', async () => {
    const opened = new Date('2026-10-05T14:00:00Z');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_LATE', 'nobody-test', '{"reminders": 4}'::jsonb, ${opened})`;

    expect(await notices(opened)).toEqual({ incidents: 1, delivered: 0, failed: 0 });
    expect(await notices(new Date(opened.getTime() + 10 * MINUTE))).toMatchObject({ incidents: 0 });
    const [row] = await sql()<{ notified_at: Date | null }[]>`
      select notified_at from incidents where dedupe_key = 'nobody-test'`;
    expect(row?.notified_at).not.toBeNull();
  });

  it('a closed incident is not announced, and a revoked member of staff is not told', async () => {
    const gone = await admin();
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${gone.userId}`;
    const stayer = await admin();
    const opened = new Date('2026-10-05T15:00:00Z');
    const [open] = await sql()<{ id: string }[]>`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_LATE', 'closed-test', '{"reminders": 4}'::jsonb, ${opened})
      returning id`;
    await sql()`
      update incidents set status = 'RESOLVED', resolved_at = now(), resolved_by = ${stayer.userId}
      where id = ${open?.id ?? ''}`;
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_STUCK', 'revoked-test', '{"reminders": 4}'::jsonb, ${opened})`;

    expect(await notices(opened)).toEqual({ incidents: 1, delivered: 1, failed: 0 });

    expect(telegram.to(stayer.chatId)).toEqual([
      t('ru', 'incident.notice', { what: t('ru', 'pn.inc.type.QUEUE_STUCK') }),
    ]);
    expect(telegram.to(gone.chatId)).toEqual([]);
  });

  it('is only for the system to ask', async () => {
    const person = await admin();
    await expect(
      repos.incidents.claimNotices(
        { kind: 'TECH_ADMIN', userId: person.userId },
        { now: new Date(), limit: 5 },
      ),
    ).rejects.toThrow(/only the system/);
    await expect(
      repos.incidents.finishNotice(course.patient, {
        incidentId: '00000000-0000-4000-8000-000000000000',
        reached: 1,
        recipients: 1,
        now: new Date(),
      }),
    ).rejects.toThrow(/only the system/);
    await expect(
      repos.metrics.snapshot({ kind: 'TECH_ADMIN', userId: person.userId }, new Date()),
    ).rejects.toThrow(/only the system/);
  });
});

describe('the metrics page', () => {
  it('reports the state of the service in numbers, including the delay of what was sent', async () => {
    await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
    // One reminder that went out seven seconds after it was due.
    await sql()`
      insert into notifications
        (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at, status, sent_at)
      select course_id, id, ${course.patientId}, 'DOSE_REMINDER', 9, ${afterFirstDose(0)}, 'SENT', ${new Date(afterFirstDose(0).getTime() + 7000)}
      from scheduled_doses where id = ${course.firstDoseId}`;
    // And one that went out seventeen seconds after it was due.
    await sql()`
      insert into notifications
        (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at, status, sent_at)
      select course_id, id, ${course.patientId}, 'DOSE_REMINDER', 10, ${afterFirstDose(0)}, 'SENT', ${new Date(afterFirstDose(0).getTime() + 17000)}
      from scheduled_doses where id = ${course.firstDoseId}`;
    const snapshot = await repos.metrics.snapshot(system, afterFirstDose(60));

    // Seven and seventeen: the middle is twelve, and the 95th percentile is near the top.
    expect(snapshot.reminders.delaySecondsP50).toBe(12);
    expect(snapshot.reminders.delaySecondsP95).toBe(17);
    expect(snapshot.reminders.sentInDay).toBeGreaterThanOrEqual(1);
    expect(snapshot.courses.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(snapshot.users).toBeGreaterThanOrEqual(3);
    expect(snapshot.incidentsOpen).toEqual(expect.any(Object));
    expect(snapshot.reminders.byStatus).toEqual(expect.any(Object));
    const dump = JSON.stringify(snapshot);
    for (const secret of ['Aziza', 'Karimova', 'Testamol', course.patientId]) {
      expect(dump).not.toContain(secret);
    }
  });
});
