import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import {
  createTestDatabase,
  insertRelationship,
  insertTechAdmin,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The worker's own code: what the doctor is told is sent by the worker, not by the bot.
import { runAlerts } from '../../../worker/src/alerts';
import { runMissedSweep, runOutbox } from '../../../worker/src/reminders';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * What follows a course as it runs: its history and figures, as-needed intake, a patient asking
 * for a pause, and what the doctor is told. The course is "Amoxicillin" at 08:00 and 20:00 for
 * seven days, started at 05:00 on 3 October 2026 (Tashkent time); some tests add "Painaway", as
 * needed, at most three times in 24 hours and at least four hours apart.
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;
const logger = createLogger({ service: 'followup-test', level: 'silent' });

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
const SENT = new Date('2026-10-02T10:00:00Z');
const STARTED = new Date('2026-10-03T00:00:00Z');
const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(orm(), repositoryDeps);
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(async () => {
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
  bot.clock = SENT;
  // Each test sees only its own course: earlier ones no longer run, and their queues are empty.
  await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
  await sql()`update doctor_alerts set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
  await sql()`update treatment_courses set status = 'PAUSED' where status = 'ACTIVE'`;
});

let nextId = 23_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const textsTo = (id: number): string[] => telegram.messagesTo(id).map((message) => message.text);
/**
 * What a doctor has been told about their patient by the worker: every message naming the
 * patient except the bot's own "the patient has started the course".
 */
const toldTo = (id: number): string[] =>
  textsTo(id).filter((text) => text.includes('Aziza Karimova') && !text.startsWith('🔔'));

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(id: number, options: { locale?: Locale; first?: string; last?: string }) {
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, 'z:ok');
}

async function doctor(options: { locale?: Locale } = {}): Promise<number> {
  const id = newPerson();
  await register(id, { first: 'Rustam', last: 'Rahimov', ...options });
  await bot.press(id, 'm:d');
  await bot.press(id, 'd:r');
  await bot.say(id, 'Pediatrician, licence UZ-1');
  const admin = await insertTechAdmin(sql());
  await repos.clinicians.verify(
    { kind: 'TECH_ADMIN', userId: admin },
    { clinicianId: await userId(id), reference: 'test' },
  );
  return id;
}

const AMOXICILLIN: NewMedication = {
  displayName: 'Amoxicillin',
  doseValue: 500,
  doseUnit: 'MG',
  foodRule: 'AFTER_MEAL',
  activeFromDay: 1,
  activeToDay: 7,
  schedule: { kind: 'TIMES', times: ['08:00', '20:00'] },
};
const PAINAWAY: NewMedication = {
  ...AMOXICILLIN,
  displayName: 'Painaway',
  doseValue: 1,
  doseUnit: 'TABLET',
  foodRule: 'ANY',
  schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 },
};

interface Scene {
  readonly doc: number;
  readonly patient: number;
  readonly courseId: string;
}

/** A doctor, a patient and a course started at 05:00 on day 1. The clock is left there. */
async function running(
  options: { doctorLocale?: Locale; medications?: NewMedication[] } = {},
): Promise<Scene> {
  bot.clock = SENT;
  const doc = await doctor(
    options.doctorLocale === undefined ? {} : { locale: options.doctorLocale },
  );
  const patient = newPerson();
  await register(patient, {});
  const relationshipId = await insertRelationship(
    sql(),
    await userId(patient),
    await userId(doc),
    'ACTIVE',
  );
  const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;
  const opened = await repos.plans.openDraft(actor, { relationshipId, durationDays: 7 });
  const courseId = opened?.course.id ?? '';
  for (const medication of options.medications ?? [AMOXICILLIN]) {
    await repos.plans.addMedication(actor, courseId, medication);
  }
  const sent = await repos.plans.send(actor, courseId, { windowDays: 7, now: SENT });
  expect(sent.status).toBe('SENT');
  bot.clock = STARTED;
  await bot.say(patient, '/menu');
  await bot.press(patient, `pc:${courseId}`);
  return { doc, patient, courseId };
}

async function doseAt(s: Scene, at: Date): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from scheduled_doses where course_id = ${s.courseId} and scheduled_at = ${at}`;
  return row?.id ?? '';
}

async function prnId(s: Scene): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select m.id from course_medications m join treatment_courses c on c.current_revision_id = m.revision_id
    where c.id = ${s.courseId} and m.prn`;
  return row?.id ?? '';
}

/** The worker at the given moment: reminders, misses, then what the doctors are told. */
async function worker(now: Date): Promise<void> {
  await runOutbox({ orm: orm(), repositoryDeps, api: telegram, logger, now: () => now });
  await runMissedSweep({ orm: orm(), repositoryDeps, now, logger });
  for (let round = 0; round < 6; round += 1) {
    await runAlerts({ orm: orm(), repositoryDeps, api: telegram, logger, now: () => now });
  }
}

/** The patient opens a fresh menu and presses a button in it, at the given moment. */
async function tap(s: Scene, now: Date, data: string): Promise<void> {
  bot.clock = now;
  await bot.say(s.patient, '/menu');
  await bot.press(s.patient, data);
}

/**
 * Two days lived through: day 1 morning taken, day 1 evening skipped with words of the
 * patient's own, day 2 morning left unanswered and then marked late, day 2 evening missed.
 */
async function twoDays(s: Scene): Promise<void> {
  await tap(s, local(1, '08:05'), `xt:${await doseAt(s, local(1, '08:00'))}`);
  const evening = await doseAt(s, local(1, '20:00'));
  await tap(s, local(1, '20:10'), `xk:${evening}`);
  await bot.press(s.patient, `xr:${evening}:o`);
  await bot.say(s.patient, 'была в дороге');
  await worker(local(2, '08:30'));
  await tap(s, local(2, '09:15'), `xt:${await doseAt(s, local(2, '08:00'))}`);
  await worker(local(2, '20:30'));
}

describe('the patient’s history', () => {
  it('is empty before any course has a past', async () => {
    const patient = newPerson();
    await register(patient, {});
    await bot.press(patient, 'm:y');
    expect(textOf(patient)).toBe(t('ru', 'history.none'));
  });

  it('lists each course with how its schedule was followed', async () => {
    const s = await running();
    await twoDays(s);

    await tap(s, local(3, '07:00'), 'm:y');

    expect(textOf(s.patient)).toBe(
      [
        t('ru', 'history.title'),
        [
          t('ru', 'history.course', {
            n: 1,
            status: t('ru', 'status.ACTIVE'),
            date: '03.10.2026',
          }),
          t('ru', 'card.doctor', { name: 'Rustam Rahimov' }),
          t('ru', 'history.figure', { taken: 1, occurred: 4, percent: '25' }),
        ].join('\n'),
      ].join('\n\n'),
    );
    expect(dataOf(s.patient)).toEqual([`hv:${s.courseId}`, 'm:h']);
  });

  it('opens into a summary that prints its own formula and never calls itself a result of treatment', async () => {
    const s = await running();
    await twoDays(s);
    await tap(s, local(3, '07:00'), `hv:${s.courseId}`);

    const text = textOf(s.patient);
    for (const line of [
      t('ru', 'report.title'),
      t('ru', 'card.doctor', { name: 'Rustam Rahimov' }),
      t('ru', 'report.due', { occurred: 4 }),
      t('ru', 'report.taken', { count: 1 }),
      t('ru', 'report.takenLate', { count: 1 }),
      t('ru', 'report.skipped', { count: 1 }),
      t('ru', 'report.missed', { count: 1 }),
      t('ru', 'report.percent', { percent: '25' }),
      t('ru', 'report.reasons', { forgot: 0, none: 0, other: 1 }),
      '03.10.2026 20:10 — Amoxicillin: была в дороге',
      t('ru', 'report.formula'),
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toMatch(/эффективн/i);
    expect(dataOf(s.patient)).toEqual([
      `hd:${s.courseId}:1`,
      `hx:${s.courseId}:p`,
      `hx:${s.courseId}:c`,
      'm:y',
    ]);
  });

  it('shows the course day by day, newest first, and only what has come due', async () => {
    const s = await running();
    await twoDays(s);
    await tap(s, local(3, '07:00'), `hd:${s.courseId}:1`);

    expect(textOf(s.patient)).toBe(
      [
        [
          '04.10.2026',
          `08:00 — Amoxicillin, 500 мг · ${t('ru', 'dose.TAKEN_LATE')}`,
          `20:00 — Amoxicillin, 500 мг · ${t('ru', 'dose.MISSED')}`,
        ].join('\n'),
        [
          '03.10.2026',
          `08:00 — Amoxicillin, 500 мг · ${t('ru', 'dose.TAKEN')}`,
          `20:00 — Amoxicillin, 500 мг · ${t('ru', 'dose.SKIPPED')} (${t('ru', 'dose.reason.OTHER')})`,
        ].join('\n'),
        t('ru', 'history.page', { page: 1, pages: 1 }),
      ].join('\n\n'),
    );
    expect(dataOf(s.patient)).toEqual([`hv:${s.courseId}`]);
  });

  it('turns pages in both directions and stays inside them', async () => {
    const s = await running();
    await worker(local(7, '20:30'));

    await tap(s, local(8, '00:10'), `hd:${s.courseId}:1`);
    expect(textOf(s.patient)).toContain('09.10.2026');
    expect(dataOf(s.patient)).toEqual([`hd:${s.courseId}:2`, `hv:${s.courseId}`]);

    await bot.press(s.patient, `hd:${s.courseId}:2`);
    expect(textOf(s.patient)).toContain('06.10.2026');
    expect(textOf(s.patient)).toContain(t('ru', 'history.page', { page: 2, pages: 3 }));
    expect(dataOf(s.patient)).toEqual([
      `hd:${s.courseId}:3`,
      `hd:${s.courseId}:1`,
      `hv:${s.courseId}`,
    ]);

    await bot.press(s.patient, `hd:${s.courseId}:900`);
    expect(textOf(s.patient)).toContain(t('ru', 'history.page', { page: 3, pages: 3 }));
    expect(dataOf(s.patient)).toEqual([`hd:${s.courseId}:2`, `hv:${s.courseId}`]);
  });

  it('keeps a finished or cancelled course, with its figures', async () => {
    const s = await running();
    await twoDays(s);
    bot.clock = local(3, '07:00');
    await bot.say(s.doc, '/menu');
    await bot.press(s.doc, `kz:${s.courseId}`);

    await tap(s, local(3, '07:10'), 'm:y');
    expect(textOf(s.patient)).toContain(
      t('ru', 'history.course', {
        n: 1,
        status: t('ru', 'status.CANCELLED'),
        date: '03.10.2026',
      }),
    );
    expect(textOf(s.patient)).toContain(
      t('ru', 'history.figure', { taken: 1, occurred: 4, percent: '25' }),
    );
  });
});

describe('the doctor’s view of a course', () => {
  it('has the same summary, under the patient’s name, and says who skipped', async () => {
    const s = await running();
    await twoDays(s);
    bot.clock = local(3, '07:00');
    await bot.say(s.doc, '/menu');
    await bot.press(s.doc, `kv:${s.courseId}`);
    expect(dataOf(s.doc)).toContain(`hr:${s.courseId}`);

    await bot.press(s.doc, `hr:${s.courseId}`);
    const summary = textOf(s.doc);
    expect(summary).toContain(t('ru', 'card.patient', { name: 'Aziza Karimova' }));
    expect(summary).toContain(t('ru', 'report.percent', { percent: '25' }));
    expect(summary).toContain('была в дороге');
    expect(dataOf(s.doc)).toEqual([
      `hk:${s.courseId}:1`,
      `hy:${s.courseId}:p`,
      `hy:${s.courseId}:c`,
      `kv:${s.courseId}`,
    ]);

    await bot.press(s.doc, `hk:${s.courseId}:1`);
    expect(textOf(s.doc)).toContain(
      `20:00 — Amoxicillin, 500 мг · ${t('ru', 'history.skippedByPatient')} (${t('ru', 'dose.reason.OTHER')})`,
    );
    expect(dataOf(s.doc)).toEqual([`hr:${s.courseId}`]);
  });

  it('is closed to everybody else', async () => {
    const s = await running();
    await twoDays(s);
    bot.clock = local(3, '07:00');

    const otherPatient = newPerson();
    await register(otherPatient, { first: 'Other', last: 'Person' });
    for (const data of [`hv:${s.courseId}`, `hd:${s.courseId}:1`]) {
      await bot.press(otherPatient, data);
      expect(textOf(otherPatient), data).toBe(t('ru', 'history.notAvailable'));
    }

    const otherDoctor = await doctor();
    bot.clock = local(3, '07:00');
    for (const data of [`hr:${s.courseId}`, `hk:${s.courseId}:1`]) {
      await bot.press(otherDoctor, data);
      expect(textOf(otherDoctor), data).toBe(t('ru', 'history.notAvailable'));
    }

    // The doctor's buttons in the hands of the patient (who is no doctor) do nothing at all.
    await bot.say(s.patient, '/menu');
    const before = textOf(s.patient);
    await bot.press(s.patient, `hr:${s.courseId}`);
    expect(textOf(s.patient)).toBe(before);
    // And the doctor reading "as a patient" finds no course of their own under that id.
    await bot.press(s.doc, `hv:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'history.notAvailable'));
  });
});

describe('as-needed intake', () => {
  it('is offered in "today" with the doctor’s limits, and recorded in two taps', async () => {
    const s = await running({ medications: [AMOXICILLIN, PAINAWAY] });
    const drug = await prnId(s);

    await tap(s, local(1, '09:00'), 'm:t');
    expect(textOf(s.patient)).toContain(
      `${t('ru', 'prn.title')}\n${t('ru', 'prn.line', { name: 'Painaway', dose: '1 табл.', count: 0, max: 3 })}`,
    );
    expect(dataOf(s.patient)).toContain(`np:${drug}`);

    await bot.press(s.patient, `np:${drug}`);
    expect(textOf(s.patient)).toBe(
      t('ru', 'prn.ask', { name: 'Painaway', dose: '1 табл.', max: 3, interval: '4 ч', count: 0 }),
    );
    expect(dataOf(s.patient)).toEqual([`ny:${drug}`, 'm:t']);
    // The question records nothing.
    expect(
      (
        await repos.prn.get(
          { kind: 'PATIENT', userId: await userId(s.patient) },
          drug,
          local(1, '09:00'),
        )
      )?.takenInDay,
    ).toBe(0);

    await bot.press(s.patient, `ny:${drug}`);
    expect(textOf(s.patient)).toBe(t('ru', 'prn.done', { name: 'Painaway', time: '09:00' }));
    expect(dataOf(s.patient)[0]).toMatch(/^nu:/);

    await bot.press(s.patient, 'm:t');
    expect(textOf(s.patient)).toContain(
      t('ru', 'prn.line', { name: 'Painaway', dose: '1 табл.', count: 1, max: 3 }),
    );
    await worker(local(1, '09:01'));
    expect(textsTo(s.doc).join('\n')).not.toContain('Painaway');
  });

  it('beyond the doctor’s limits is said plainly before, recorded anyway, and the doctor is told', async () => {
    const s = await running({ medications: [AMOXICILLIN, PAINAWAY] });
    const drug = await prnId(s);
    await tap(s, local(1, '09:00'), `ny:${drug}`);

    await tap(s, local(1, '10:30'), `np:${drug}`);
    const question = textOf(s.patient);
    expect(question).toContain(t('ru', 'prn.lastAt', { time: '03.10.2026 09:00' }));
    expect(question).toContain(t('ru', 'prn.warnInterval', { time: '03.10.2026 13:00' }));
    expect(question).toContain(t('ru', 'prn.warnTail'));

    await bot.press(s.patient, `ny:${drug}`);
    expect(textOf(s.patient)).toBe(t('ru', 'prn.doneOver', { name: 'Painaway', time: '10:30' }));

    await worker(local(1, '10:31'));
    expect(textOf(s.doc)).toBe(
      t('ru', 'alert.prnOver', {
        patient: 'Aziza Karimova',
        name: 'Painaway',
        max: 3,
        interval: '4 ч',
        count: 2,
      }),
    );
    expect(dataOf(s.doc)).toEqual([`kv:${s.courseId}`, `hr:${s.courseId}`]);
  });

  it('can be taken back, once, and a mark taken back is not reported', async () => {
    const s = await running({ medications: [AMOXICILLIN, PAINAWAY] });
    const drug = await prnId(s);
    await tap(s, local(1, '09:00'), `ny:${drug}`);
    await tap(s, local(1, '10:30'), `ny:${drug}`);
    const undo = dataOf(s.patient).find((data) => data.startsWith('nu:')) ?? '';

    await bot.press(s.patient, undo);
    expect(textOf(s.patient)).toBe(t('ru', 'prn.undone', { name: 'Painaway' }));
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, undo);
    expect(textOf(s.patient)).toBe(t('ru', 'prn.undoneAlready'));

    await worker(local(1, '10:31'));
    expect(textsTo(s.doc).join('\n')).not.toContain('Painaway');
    await bot.press(s.patient, 'm:t');
    expect(textOf(s.patient)).toContain(
      t('ru', 'prn.line', { name: 'Painaway', dose: '1 табл.', count: 1, max: 3 }),
    );
  });

  it('tapped twice is recorded once', async () => {
    const s = await running({ medications: [AMOXICILLIN, PAINAWAY] });
    const drug = await prnId(s);
    await tap(s, local(1, '09:00'), `ny:${drug}`);
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, `ny:${drug}`);
    expect(textOf(s.patient)).toBe(t('ru', 'prn.already', { name: 'Painaway', time: '09:00' }));
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events
      where course_id = ${s.courseId} and event_type = 'PRN_TAKEN'`;
    expect(events?.n).toBe(1);
  });

  it('appears in the history and stays out of the percentage', async () => {
    const s = await running({ medications: [AMOXICILLIN, PAINAWAY] });
    const drug = await prnId(s);
    await tap(s, local(1, '09:00'), `ny:${drug}`);

    await tap(s, local(1, '09:30'), `hv:${s.courseId}`);
    expect(textOf(s.patient)).toContain(t('ru', 'report.prn', { name: 'Painaway', count: 1 }));
    expect(textOf(s.patient)).toContain(t('ru', 'report.due', { occurred: 0 }));
    expect(textOf(s.patient)).toContain(t('ru', 'report.noPercent'));

    await bot.press(s.patient, `hd:${s.courseId}:1`);
    expect(textOf(s.patient)).toContain(
      `09:00 — Painaway, 1 табл. · ${t('ru', 'history.prnEntry')}`,
    );
  });

  it('is not there for a course on hold, or for anyone but the patient', async () => {
    const s = await running({ medications: [AMOXICILLIN, PAINAWAY] });
    const drug = await prnId(s);
    bot.clock = local(1, '09:00');
    await bot.say(s.doc, '/menu');
    await bot.press(s.doc, `ny:${drug}`);
    expect(textOf(s.doc)).toBe(t('ru', 'prn.notAvailable'));

    await bot.press(s.doc, `kn:${s.courseId}`);
    await tap(s, local(1, '09:10'), `ny:${drug}`);
    expect(textOf(s.patient)).toBe(t('ru', 'prn.notAvailable'));
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events
      where course_id = ${s.courseId} and scheduled_dose_id is null`;
    expect(events?.n).toBe(0);
  });
});

describe('asking the doctor for a pause', () => {
  it('takes two taps, reaches the doctor through the worker, and leaves the course running', async () => {
    const s = await running();
    await tap(s, local(1, '09:00'), 'm:c');
    expect(dataOf(s.patient)).toEqual([`pp:${s.courseId}`, 'm:h']);

    await bot.press(s.patient, `pp:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'course.pauseQuestion', { doctor: 'Rustam Rahimov' }));
    expect(dataOf(s.patient)).toEqual([`pq:${s.courseId}`, 'm:c']);
    await worker(local(1, '09:00'));
    expect(textsTo(s.doc).join('\n')).not.toContain(
      t('ru', 'alert.pauseRequest', { patient: 'Aziza Karimova' }),
    );

    await bot.press(s.patient, `pq:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'course.pauseRequested'));

    await worker(local(1, '09:01'));
    expect(textOf(s.doc)).toBe(t('ru', 'alert.pauseRequest', { patient: 'Aziza Karimova' }));
    expect(dataOf(s.doc)).toEqual([`kv:${s.courseId}`, `hr:${s.courseId}`]);
    const [course] = await sql()<{ status: string }[]>`
      select status from treatment_courses where id = ${s.courseId}`;
    expect(course?.status).toBe('ACTIVE');

    // The doctor's button leads to the course, where the pause is theirs to put.
    bot.clock = local(1, '09:05');
    await bot.press(s.doc, `kv:${s.courseId}`);
    expect(dataOf(s.doc)).toContain(`kp:${s.courseId}`);
  });

  it('is sent once a day however often it is asked', async () => {
    const s = await running();
    await tap(s, local(1, '09:00'), `pq:${s.courseId}`);
    await tap(s, local(1, '11:00'), `pq:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'course.pauseAlready'));

    await worker(local(1, '11:01'));
    expect(
      textsTo(s.doc).filter(
        (text) => text === t('ru', 'alert.pauseRequest', { patient: 'Aziza Karimova' }),
      ),
    ).toHaveLength(1);
  });

  it('is not offered, and not accepted, for a course that is not running', async () => {
    const s = await running();
    bot.clock = local(1, '09:00');
    await bot.say(s.doc, '/menu');
    await bot.press(s.doc, `kn:${s.courseId}`);

    await tap(s, local(1, '09:10'), 'm:c');
    expect(dataOf(s.patient)).toEqual(['m:h']);
    for (const data of [`pp:${s.courseId}`, `pq:${s.courseId}`]) {
      await bot.press(s.patient, data);
      expect(textOf(s.patient), data).toBe(t('ru', 'start.notAvailable'));
    }
  });
});

describe('what the doctor is told about doses not taken', () => {
  const missedText = (locale: Locale, time: string): string =>
    `${t(locale, 'alert.missed', { patient: 'Aziza Karimova', time })}\n• Amoxicillin — 500 ${t(locale, 'unit.MG')}, ${t(locale, 'food.AFTER_MEAL')}`;

  it('a miss, once its deadline has passed, in the doctor’s own language', async () => {
    const s = await running({ doctorLocale: 'uz' });
    await worker(local(1, '08:00'));
    await worker(local(1, '08:29'));
    expect(textsTo(s.doc).some((text) => text.includes('Amoxicillin'))).toBe(false);

    await worker(local(1, '08:30'));

    expect(textOf(s.doc)).toBe(missedText('uz', '03.10.2026 08:00'));
    expect(dataOf(s.doc)).toEqual([`kv:${s.courseId}`, `hr:${s.courseId}`]);
    // Once: the worker running again has nothing more to say.
    const before = textsTo(s.doc).length;
    await worker(local(1, '08:35'));
    expect(textsTo(s.doc)).toHaveLength(before);
  });

  it('a skip, with the reason but never the patient’s own words', async () => {
    const s = await running();
    const dose = await doseAt(s, local(1, '08:00'));
    await tap(s, local(1, '08:05'), `xk:${dose}`);
    await bot.press(s.patient, `xr:${dose}:o`);
    await bot.say(s.patient, 'тошнит после еды');

    await worker(local(1, '08:06'));

    expect(textOf(s.doc)).toBe(
      `${t('ru', 'alert.skipped', {
        patient: 'Aziza Karimova',
        time: '03.10.2026 08:00',
        reason: t('ru', 'dose.reason.OTHER'),
      })}\n• Amoxicillin — 500 мг, после еды`,
    );
    expect(textsTo(s.doc).join('\n')).not.toContain('тошнит');
  });

  it('two single messages, then one escalation, then silence until the summary', async () => {
    const s = await running();
    const alerts = (): string[] => toldTo(s.doc);

    await worker(local(1, '08:30'));
    await worker(local(1, '20:30'));
    expect(alerts()).toEqual([
      missedText('ru', '03.10.2026 08:00'),
      missedText('ru', '03.10.2026 20:00'),
    ]);

    await worker(local(2, '08:30'));
    expect(alerts()).toHaveLength(3);
    expect(alerts()[2]).toBe(
      t('ru', 'alert.series', { patient: 'Aziza Karimova', run: '3', since: '03.10.2026 08:00' }),
    );

    // The fourth and the fifth in a row: no message of their own, only the summary of the run.
    await worker(local(2, '20:30'));
    expect(alerts()).toHaveLength(4);
    expect(alerts()[3]).toBe(
      t('ru', 'alert.digest', { patient: 'Aziza Karimova', run: '4', since: '03.10.2026 08:00' }),
    );
    await worker(local(3, '08:30'));
    expect(alerts()).toHaveLength(5);
    expect(alerts()[4]).toContain(
      t('ru', 'alert.digest', { patient: 'Aziza Karimova', run: '5', since: '03.10.2026 08:00' }),
    );
  });

  it('nothing, when the patient marks the dose late before the message goes out', async () => {
    const s = await running();
    await runMissedSweep({ orm: orm(), repositoryDeps, now: local(1, '08:30'), logger });
    await tap(s, local(1, '08:31'), `xt:${await doseAt(s, local(1, '08:00'))}`);

    await worker(local(1, '08:32'));

    expect(toldTo(s.doc)).toEqual([]);
    const [alert] = await sql()<{ status: string; last_error: string | null }[]>`
      select status, last_error from doctor_alerts where course_id = ${s.courseId}`;
    expect(alert).toEqual({ status: 'CANCELLED', last_error: 'put right' });
  });

  it('that a reminder could not be delivered at all', async () => {
    const s = await running();
    telegram.failNext.sendMessage = Object.assign(new Error('Forbidden: bot was blocked'), {
      error_code: 403,
    });

    await worker(local(1, '08:00'));

    expect(textOf(s.doc)).toBe(t('ru', 'alert.undelivered', { patient: 'Aziza Karimova' }));
    expect(JSON.stringify(telegram.sent)).not.toContain('bot was blocked');
  });

  it('nothing at all once the doctor has lost standing or cancelled the course', async () => {
    const revoked = await running();
    await runMissedSweep({ orm: orm(), repositoryDeps, now: local(1, '08:30'), logger });
    await sql()`
      update clinician_profiles set verification_status = 'REVOKED'
      where user_id = ${await userId(revoked.doc)}`;
    await worker(local(1, '08:31'));
    expect(toldTo(revoked.doc)).toEqual([]);

    const cancelled = await running();
    await runMissedSweep({ orm: orm(), repositoryDeps, now: local(1, '08:30'), logger });
    bot.clock = local(1, '08:31');
    await bot.say(cancelled.doc, '/menu');
    await bot.press(cancelled.doc, `kz:${cancelled.courseId}`);
    const before = textsTo(cancelled.doc).length;
    await worker(local(1, '08:32'));
    expect(textsTo(cancelled.doc)).toHaveLength(before);
  });

  it('again later, when Telegram refuses the alert for a moment', async () => {
    const s = await running();
    await runMissedSweep({ orm: orm(), repositoryDeps, now: local(1, '08:30'), logger });
    telegram.failNext.sendMessage = Object.assign(new Error('Bad Gateway'), { error_code: 502 });
    await runAlerts({
      orm: orm(),
      repositoryDeps,
      api: telegram,
      logger,
      now: () => local(1, '08:31'),
    });
    expect(toldTo(s.doc)).toEqual([]);

    await worker(local(1, '08:33'));
    expect(textOf(s.doc)).toBe(missedText('ru', '03.10.2026 08:00'));
  });
});
