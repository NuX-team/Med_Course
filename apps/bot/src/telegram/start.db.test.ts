import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  systemActor,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/** The patient starts a course: two taps, one start, and the plan becomes a schedule. */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
/** 15:00 on 2 October 2026 in Tashkent. */
const AFTERNOON = new Date('2026-10-02T10:00:00Z');
/** 05:00 on 3 October 2026 in Tashkent. */
const MORNING = new Date('2026-10-03T00:00:00Z');
/** 21:30 on 2 October 2026 in Tashkent. */
const EVENING = new Date('2026-10-02T16:30:00Z');
const DAY = 86_400_000;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(orm(), repositoryDeps);
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(() => {
  bot.clock = AFTERNOON;
});

let nextId = 11_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const labelsOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.text);
const countOf = (id: number, fragment: string): number =>
  telegram.messagesTo(id).filter((message) => message.text.includes(fragment)).length;

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(
  id: number,
  options: { locale?: Locale; first?: string; last?: string } = {},
) {
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, 'z:ok');
}

async function doctor(options: { locale?: Locale; last?: string } = {}): Promise<number> {
  const id = newPerson();
  await register(id, { first: 'Rustam', last: options.last ?? 'Rahimov', ...options });
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

interface Linked {
  readonly patient: number;
  readonly relationshipId: string;
}

async function linked(
  doc: number,
  options: { locale?: Locale; patient?: number } = {},
): Promise<Linked> {
  const patient = options.patient ?? newPerson();
  if (options.patient === undefined) {
    await register(patient, options);
  }
  const relationshipId = await insertRelationship(
    sql(),
    await userId(patient),
    await userId(doc),
    'ACTIVE',
  );
  return { patient, relationshipId };
}

const TWICE_A_DAY: NewMedication = {
  displayName: 'Amoxicillin',
  doseValue: 500,
  doseUnit: 'MG',
  foodRule: 'AFTER_MEAL',
  activeFromDay: 1,
  activeToDay: 7,
  schedule: { kind: 'TIMES', times: ['08:00', '20:00'] },
};

/** A course written and sent through the repositories: the wizard has its own tests. */
async function sentCourse(
  doc: number,
  link: Linked,
  options: { durationDays?: number; medication?: Partial<NewMedication> } = {},
): Promise<string> {
  const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;
  const durationDays = options.durationDays ?? 7;
  const opened = await repos.plans.openDraft(actor, {
    relationshipId: link.relationshipId,
    durationDays,
  });
  const courseId = opened?.course.id ?? '';
  await repos.plans.addMedication(actor, courseId, {
    ...TWICE_A_DAY,
    activeToDay: durationDays,
    ...options.medication,
  });
  const sent = await repos.plans.send(actor, courseId, { windowDays: 7, now: AFTERNOON });
  expect(sent.status).toBe('SENT');
  return courseId;
}

/** Doctor, patient and a course waiting to be started, with "my course" open on the patient's screen. */
async function waiting(
  options: {
    patientLocale?: Locale;
    doctorLocale?: Locale;
    durationDays?: number;
    medication?: Partial<NewMedication>;
  } = {},
) {
  const doc = await doctor(
    options.doctorLocale === undefined ? {} : { locale: options.doctorLocale },
  );
  const link = await linked(
    doc,
    options.patientLocale === undefined ? {} : { locale: options.patientLocale },
  );
  const courseId = await sentCourse(doc, link, options);
  await bot.say(link.patient, '/menu');
  await bot.press(link.patient, 'm:c');
  return { doc, patient: link.patient, link, courseId };
}

async function courseRow(courseId: string) {
  const [row] = await sql()<{ status: string; start_at: Date | null; day_one: string | null }[]>`
    select status, start_at, effective_start_date::text as day_one
    from treatment_courses where id = ${courseId}`;
  return row;
}

async function doseCount(courseId: string): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    select count(*)::int as n from scheduled_doses where course_id = ${courseId}`;
  return row?.n ?? 0;
}

describe('the way to start', () => {
  it('is a button under the prescription the doctor sends', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:c');
    await bot.press(doc, `kb:${link.relationshipId}`);
    await bot.press(doc, 'w:l:7');
    await bot.say(doc, 'Amoxicillin');
    await bot.say(doc, '500');
    await bot.press(doc, 'w:u:MG');
    await bot.press(doc, 'w:f:AFTER_MEAL');
    await bot.press(doc, 'w:q:2');
    await bot.press(doc, 'w:t:ok');
    await bot.press(doc, 'w:d:all');
    await bot.press(doc, 'w:n:skip');
    const [course] = await sql()<{ id: string }[]>`
      select id from treatment_courses where care_relationship_id = ${link.relationshipId}`;
    await bot.press(doc, `ks:${course?.id ?? ''}`);
    await bot.press(doc, `kw:${course?.id ?? ''}:7`);

    expect(textOf(link.patient)).toContain('Amoxicillin');
    expect(dataOf(link.patient)).toEqual([`ps:${course?.id ?? ''}`]);
    expect(labelsOf(link.patient)).toEqual([t('ru', 'course.start')]);
  });

  it('is also under "my course" while the course waits', async () => {
    const { patient, courseId } = await waiting();
    expect(dataOf(patient)).toEqual([`ps:${courseId}`, 'm:h']);
  });

  it('numbers the courses when several are waiting, so each button names its own', async () => {
    const first = await doctor({ last: 'First' });
    const second = await doctor({ last: 'Second' });
    const link = await linked(first);
    const one = await sentCourse(first, link);
    const two = await sentCourse(second, await linked(second, { patient: link.patient }));
    await sql()`update treatment_courses set created_at = '2026-01-01' where id = ${one}`;

    await bot.say(link.patient, '/menu');
    await bot.press(link.patient, 'm:c');

    expect(textOf(link.patient)).toContain(t('ru', 'course.titleN', { n: 1 }));
    expect(textOf(link.patient)).toContain(t('ru', 'course.titleN', { n: 2 }));
    expect(dataOf(link.patient)).toEqual([`ps:${two}`, `ps:${one}`, 'm:h']);
    expect(labelsOf(link.patient).slice(0, 2)).toEqual([
      t('ru', 'course.startN', { n: 1 }),
      t('ru', 'course.startN', { n: 2 }),
    ]);
  });
});

describe('the first tap: what starting now would mean', () => {
  it('warns an afternoon starter that part of today is gone, and changes nothing', async () => {
    const { patient, courseId } = await waiting();

    await bot.press(patient, `ps:${courseId}`);

    const text = textOf(patient);
    expect(text).toContain(t('ru', 'start.question'));
    expect(text).toContain(
      t('ru', 'start.dayOne', { date: '02.10.2026', days: 7, last: '08.10.2026' }),
    );
    expect(text).toContain(t('ru', 'start.todayPartial', { left: 1, planned: 2, time: '20:00' }));
    expect(text).toContain(t('ru', 'start.irreversible'));
    expect(dataOf(patient)).toEqual([`pc:${courseId}`, 'm:c']);
    expect(await courseRow(courseId)).toMatchObject({ status: 'PENDING_PATIENT', start_at: null });
    expect(await doseCount(courseId)).toBe(0);
  });

  it('promises a full day to someone who starts in the morning', async () => {
    const { patient, courseId } = await waiting();
    bot.clock = MORNING;
    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toContain(
      t('ru', 'start.dayOne', { date: '03.10.2026', days: 7, last: '09.10.2026' }),
    );
    expect(textOf(patient)).toContain(t('ru', 'start.todayFull', { count: 2, time: '08:00' }));
  });

  it('says when today has nothing left and the first reminder comes tomorrow', async () => {
    const { patient, courseId } = await waiting();
    bot.clock = EVENING;
    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toContain(t('ru', 'start.todayNone', { first: '03.10.2026 08:00' }));
  });

  it('says that a course of as-needed medications has no reminders', async () => {
    const { patient, courseId } = await waiting({
      medication: { schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 } },
    });
    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toContain(t('ru', 'start.prnOnly'));
  });

  it('lets the patient back out: "not now" starts nothing', async () => {
    const { patient, courseId } = await waiting();
    await bot.press(patient, `ps:${courseId}`);
    await bot.press(patient, 'm:c');
    expect(textOf(patient)).toContain('Amoxicillin');
    expect(dataOf(patient)).toEqual([`ps:${courseId}`, 'm:h']);
    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
  });

  it('asks in the patient’s language', async () => {
    const { patient, courseId } = await waiting({ patientLocale: 'uz' });
    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toContain(t('uz', 'start.question'));
    expect(labelsOf(patient)).toEqual([t('uz', 'start.confirm'), t('uz', 'start.later')]);
  });
});

describe('the second tap: the course starts', () => {
  it('starts it, tells the patient the dates, tells the doctor, and lays out the doses', async () => {
    const { doc, patient, courseId } = await waiting({ doctorLocale: 'uz' });
    await bot.press(patient, `ps:${courseId}`);

    await bot.press(patient, `pc:${courseId}`);

    expect(textOf(patient)).toBe(t('ru', 'start.done', { date: '02.10.2026', last: '08.10.2026' }));
    expect(textOf(doc)).toBe(
      t('uz', 'doctor.courseStarted', {
        patient: 'Aziza Karimova',
        date: '02.10.2026',
        last: '08.10.2026',
      }),
    );
    expect(await courseRow(courseId)).toEqual({
      status: 'ACTIVE',
      start_at: AFTERNOON,
      day_one: '2026-10-02',
    });
    expect(await doseCount(courseId)).toBe(13);
  });

  it('then shows the course as running, on day 1, with no start button', async () => {
    const { patient, courseId } = await waiting();
    await bot.press(patient, `pc:${courseId}`);

    await bot.press(patient, 'm:c');

    const text = textOf(patient);
    expect(text).toContain(t('ru', 'card.status', { status: t('ru', 'status.ACTIVE') }));
    expect(text).toContain(t('ru', 'card.started', { date: '02.10.2026', last: '08.10.2026' }));
    expect(text).toContain(t('ru', 'card.day', { day: 1, days: 7 }));
    // No start button any more; what is offered instead is asking the doctor for a pause.
    expect(dataOf(patient)).toEqual([`pp:${courseId}`, 'm:h']);

    bot.clock = new Date(AFTERNOON.getTime() + 3 * DAY);
    await bot.press(patient, 'm:c');
    expect(textOf(patient)).toContain(t('ru', 'card.day', { day: 4, days: 7 }));
  });

  it('happens once: five taps at the same moment start one course and tell the doctor once', async () => {
    const { doc, patient, courseId } = await waiting();
    await bot.press(patient, `ps:${courseId}`);
    const question = telegram.lastTo(patient)?.messageId ?? 0;

    await Promise.all(
      Array.from({ length: 5 }, () => bot.press(patient, `pc:${courseId}`, question)),
    );

    expect(await doseCount(courseId)).toBe(13);
    expect(countOf(doc, 'Aziza Karimova начал курс')).toBe(1);
    const [history] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_transitions
      where course_id = ${courseId} and to_status = 'ACTIVE'`;
    expect(history?.n).toBe(1);
  });

  it('cannot be repeated later: an old button says the course is already started', async () => {
    const { doc, patient, courseId } = await waiting();
    await bot.press(patient, `pc:${courseId}`);
    const toldDoctor = telegram.messagesTo(doc).length;

    bot.clock = new Date(AFTERNOON.getTime() + 2 * DAY);
    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toBe(t('ru', 'start.already'));
    await bot.press(patient, `pc:${courseId}`);
    expect(textOf(patient)).toBe(t('ru', 'start.already'));

    expect(await courseRow(courseId)).toMatchObject({ start_at: AFTERNOON, day_one: '2026-10-02' });
    expect(await doseCount(courseId)).toBe(13);
    expect(telegram.messagesTo(doc)).toHaveLength(toldDoctor);
  });

  it('starts in Uzbek for an Uzbek-speaking patient', async () => {
    const { patient, courseId } = await waiting({ patientLocale: 'uz' });
    await bot.press(patient, `pc:${courseId}`);
    expect(textOf(patient)).toBe(t('uz', 'start.done', { date: '02.10.2026', last: '08.10.2026' }));
  });
});

describe('when the course cannot be started', () => {
  it('says the window has passed, until when it was open, and who to contact', async () => {
    const { doc, patient, courseId } = await waiting();
    const toldDoctor = telegram.messagesTo(doc).length;
    bot.clock = new Date(AFTERNOON.getTime() + 7 * DAY + 60_000);
    const expected = t('ru', 'start.tooLate', {
      until: '09.10.2026 15:00',
      doctor: 'Rustam Rahimov',
    });

    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toBe(expected);
    await bot.press(patient, `pc:${courseId}`);
    expect(textOf(patient)).toBe(expected);

    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
    expect(await doseCount(courseId)).toBe(0);
    expect(telegram.messagesTo(doc)).toHaveLength(toldDoctor);
  });

  it('says the same after the system has closed the course', async () => {
    const { patient, courseId } = await waiting();
    const later = new Date(AFTERNOON.getTime() + 8 * DAY);
    await repos.runs.expireUnstarted(systemActor('test'), later);
    bot.clock = later;

    await bot.press(patient, `pc:${courseId}`);
    expect(textOf(patient)).toContain('09.10.2026 15:00');
    expect((await courseRow(courseId))?.status).toBe('EXPIRED_NOT_STARTED');
  });

  it('refuses a start that would leave the course without a single dose', async () => {
    const { patient, courseId } = await waiting({ durationDays: 1 });
    bot.clock = EVENING;

    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toBe(t('ru', 'start.nothingLeft', { until: '09.10.2026 15:00' }));
    await bot.press(patient, `pc:${courseId}`);

    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
  });

  it('refuses when the doctor has lost standing since prescribing', async () => {
    const { doc, patient, courseId } = await waiting();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${await userId(doc)}`;

    await bot.press(patient, `ps:${courseId}`);
    expect(textOf(patient)).toBe(t('ru', 'start.doctorUnavailable'));
    await bot.press(patient, `pc:${courseId}`);

    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
    expect(await doseCount(courseId)).toBe(0);
  });
});

describe('courses that are not this person’s to start', () => {
  it('cannot be started by another patient, by the doctor, or by a stranger', async () => {
    const { doc, courseId } = await waiting();
    const other = newPerson();
    await register(other);
    const stranger = newPerson();

    for (const who of [other, doc]) {
      await bot.press(who, `ps:${courseId}`);
      expect(textOf(who)).toBe(t('ru', 'start.notAvailable'));
      await bot.press(who, `pc:${courseId}`);
      expect(textOf(who)).toBe(t('ru', 'start.notAvailable'));
    }
    await bot.press(stranger, `pc:${courseId}`);

    expect(telegram.messagesTo(stranger)).toEqual([]);
    expect(telegram.messagesTo(other).some((message) => message.text.includes('Amoxicillin'))).toBe(
      false,
    );
    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
    expect(await doseCount(courseId)).toBe(0);
    expect(countOf(doc, 'начал курс')).toBe(0);
  });

  it('cannot be started while still a draft, even by the patient it is for', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const opened = await repos.plans.openDraft(
      { kind: 'CLINICIAN', userId: await userId(doc) },
      { relationshipId: link.relationshipId, durationDays: 7 },
    );
    const draftId = opened?.course.id ?? '';

    await bot.press(link.patient, `pc:${draftId}`);

    expect(textOf(link.patient)).toBe(t('ru', 'start.notAvailable'));
    expect((await courseRow(draftId))?.status).toBe('DRAFT');
  });

  it('ignores ids that are not ids', async () => {
    const { patient } = await waiting();
    const before = telegram.messagesTo(patient).length;
    for (const data of ['ps:nope', 'pc:nope', "pc:' or 1=1 --", 'pc:']) {
      await bot.press(patient, data);
    }
    expect(telegram.messagesTo(patient)).toHaveLength(before);
  });
});

describe('today', () => {
  it('says there is no running course before the start', async () => {
    const { patient } = await waiting();
    await bot.press(patient, 'm:h');
    await bot.press(patient, 'm:t');
    expect(textOf(patient)).toBe(t('ru', 'today.none'));
  });

  it('lists what is still to take today, in order, once the course runs', async () => {
    const { patient, courseId } = await waiting();
    bot.clock = MORNING;
    await bot.press(patient, `pc:${courseId}`);

    await bot.press(patient, 'm:h');
    await bot.press(patient, 'm:t');

    const waitingLabel = t('ru', 'dose.SCHEDULED');
    expect(textOf(patient)).toBe(
      [
        t('ru', 'today.title', { date: '03.10.2026' }),
        '',
        `08:00 — Amoxicillin, 500 мг, после еды · ${waitingLabel}`,
        `20:00 — Amoxicillin, 500 мг, после еды · ${waitingLabel}`,
      ].join('\n'),
    );
    expect(dataOf(patient)).toEqual(['m:h']);
  });

  it('follows the patient’s own day: after local midnight it is tomorrow’s list', async () => {
    const { patient, courseId } = await waiting();
    await bot.press(patient, `pc:${courseId}`);

    // 00:30 on 3 October in Tashkent.
    bot.clock = new Date('2026-10-02T19:30:00Z');
    await bot.press(patient, 'm:t');
    expect(textOf(patient)).toContain(t('ru', 'today.title', { date: '03.10.2026' }));
    expect(textOf(patient)).toContain('08:00 — Amoxicillin');
  });

  it('says so when a running course asks nothing today', async () => {
    const { patient, courseId } = await waiting({
      medication: { schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 } },
    });
    await bot.press(patient, `pc:${courseId}`);
    await bot.press(patient, 'm:t');
    // Nothing by the clock; the as-needed drug is listed with what the doctor allowed.
    expect(textOf(patient)).toBe(
      [
        t('ru', 'today.title', { date: '02.10.2026' }),
        t('ru', 'today.nothing'),
        `${t('ru', 'prn.title')}\n${t('ru', 'prn.line', { name: 'Amoxicillin', dose: '500 мг', count: 0, max: 3 })}`,
      ].join('\n\n'),
    );
    expect(dataOf(patient)).toHaveLength(2);
    expect(dataOf(patient)[0]).toMatch(/^np:/);
  });

  it('never shows one patient another patient’s day', async () => {
    const { patient, courseId } = await waiting();
    await bot.press(patient, `pc:${courseId}`);
    const other = newPerson();
    await register(other);
    await bot.press(other, 'm:t');
    expect(textOf(other)).toBe(t('ru', 'today.none'));
  });
});
