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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * What a doctor does to a course after sending it (take it back, hold it, resume it, stop it,
 * change its plan), and what the patient sees and does about it. The course is "Amoxicillin"
 * at 08:00 and 20:00 for seven days, sent on 2 October 2026 and started at 05:00 on the 3rd
 * (Tashkent time).
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
/** 15:00 on 2 October 2026 in Tashkent. */
const SENT = new Date('2026-10-02T10:00:00Z');
/** 05:00 on 3 October 2026 in Tashkent. */
const STARTED = new Date('2026-10-03T00:00:00Z');
/** A moment on the patient's clock on day `day` of the course (day 1 is 3 October). */
const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

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
  bot.clock = SENT;
});

let nextId = 17_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const labelsOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.text);
const countOf = (id: number, fragment: string): number =>
  telegram.messagesTo(id).filter((message) => message.text.includes(fragment)).length;
const allTo = (id: number): string =>
  telegram
    .messagesTo(id)
    .map((message) => message.text)
    .join('\n---\n');

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

interface Scene {
  readonly doc: number;
  readonly patient: number;
  readonly relationshipId: string;
  readonly courseId: string;
}

/** A doctor, a patient and a course that has been sent but not started. */
async function sent(
  options: { patientLocale?: Locale; doctorLocale?: Locale } = {},
): Promise<Scene> {
  bot.clock = SENT;
  const doc = await doctor(
    options.doctorLocale === undefined ? {} : { locale: options.doctorLocale },
  );
  const patient = newPerson();
  await register(
    patient,
    options.patientLocale === undefined ? {} : { locale: options.patientLocale },
  );
  const relationshipId = await insertRelationship(
    sql(),
    await userId(patient),
    await userId(doc),
    'ACTIVE',
  );
  const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;
  const opened = await repos.plans.openDraft(actor, { relationshipId, durationDays: 7 });
  const courseId = opened?.course.id ?? '';
  await repos.plans.addMedication(actor, courseId, AMOXICILLIN);
  const result = await repos.plans.send(actor, courseId, { windowDays: 7, now: SENT });
  expect(result.status).toBe('SENT');
  return { doc, patient, relationshipId, courseId };
}

/** The same, started by the patient at 05:00 on day 1. The clock is left at that moment. */
async function running(
  options: { patientLocale?: Locale; doctorLocale?: Locale } = {},
): Promise<Scene> {
  const scene = await sent(options);
  bot.clock = STARTED;
  await bot.say(scene.patient, '/menu');
  await bot.press(scene.patient, `pc:${scene.courseId}`);
  expect(await statusOf(scene.courseId)).toBe('ACTIVE');
  return scene;
}

async function statusOf(courseId: string): Promise<string | undefined> {
  const [row] = await sql()<{ status: string }[]>`
    select status from treatment_courses where id = ${courseId}`;
  return row?.status;
}

async function tally(courseId: string): Promise<Record<string, number>> {
  const rows = await sql()<{ status: string; n: number }[]>`
    select status, count(*)::int as n from scheduled_doses
    where course_id = ${courseId} group by status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

async function liveDrugs(courseId: string): Promise<Record<string, number>> {
  const rows = await sql()<{ name: string; n: number }[]>`
    select m.display_name as name, count(*)::int as n
    from scheduled_doses d join course_medications m on m.id = d.medication_id
    where d.course_id = ${courseId} and d.status <> 'SUPERSEDED' group by m.display_name`;
  return Object.fromEntries(rows.map((row) => [row.name, row.n]));
}

/** The doctor opens the course from a fresh menu, so the reply is a message of its own. */
async function openCourse(s: Scene): Promise<void> {
  await bot.say(s.doc, '/menu');
  await bot.press(s.doc, `kv:${s.courseId}`);
}

/** The doctor adds "Ibuprofen 200 mg, once a day" through the wizard. */
async function addIbuprofen(s: Scene): Promise<void> {
  await bot.press(s.doc, `ka:${s.courseId}`);
  await bot.say(s.doc, 'Ibuprofen');
  await bot.say(s.doc, '200');
  await bot.press(s.doc, 'w:u:MG');
  await bot.press(s.doc, 'w:f:ANY');
  await bot.press(s.doc, 'w:q:1');
  await bot.press(s.doc, 'w:t:ok');
  await bot.press(s.doc, 'w:d:all');
  await bot.press(s.doc, 'w:n:skip');
}

/** The doctor writes a change that adds Ibuprofen and sends it to the patient. */
async function proposeIbuprofen(s: Scene): Promise<void> {
  await openCourse(s);
  await bot.press(s.doc, `ke:${s.courseId}`);
  await addIbuprofen(s);
  await bot.press(s.doc, `kt:${s.courseId}`);
  await bot.press(s.doc, `ko:${s.courseId}`);
}

describe('taking back a course that has not been started', () => {
  it('asks first, then withdraws it, tells the patient, and offers a corrected course', async () => {
    const s = await sent();
    await openCourse(s);
    expect(dataOf(s.doc)).toEqual([`kc:${s.courseId}`, 'm:d']);
    expect(labelsOf(s.doc)[0]).toBe(t('ru', 'cw.withdraw'));

    await bot.press(s.doc, `kc:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.withdrawConfirm', { patient: 'Aziza Karimova' }));
    expect(dataOf(s.doc)).toEqual([`kz:${s.courseId}`, `kv:${s.courseId}`]);
    // The question changes nothing.
    expect(await statusOf(s.courseId)).toBe('PENDING_PATIENT');
    expect(countOf(s.patient, 'Rustam Rahimov')).toBe(0);

    await bot.press(s.doc, `kz:${s.courseId}`);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.withdrawn', { patient: 'Aziza Karimova' }));
    expect(dataOf(s.doc)).toEqual([`kb:${s.relationshipId}`, 'm:d']);
    expect(await statusOf(s.courseId)).toBe('CANCELLED');
    expect(textOf(s.patient)).toBe(t('ru', 'course.withdrawn', { doctor: 'Rustam Rahimov' }));

    // The corrected course can start from the one just withdrawn.
    await bot.press(s.doc, `kb:${s.relationshipId}`);
    expect(dataOf(s.doc)).toContain('w:s:copy');
  });

  it('leaves the patient unable to start it, with a reason they can understand', async () => {
    const s = await sent();
    await openCourse(s);
    await bot.press(s.doc, `kc:${s.courseId}`);
    await bot.press(s.doc, `kz:${s.courseId}`);

    bot.clock = STARTED;
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, `ps:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'start.withdrawn'));
    await bot.press(s.patient, `pc:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'start.withdrawn'));
    expect(await statusOf(s.courseId)).toBe('CANCELLED');
    expect(await tally(s.courseId)).toEqual({});

    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).not.toContain('Amoxicillin');
  });

  it('a second tap finds nothing left to withdraw and tells the patient nothing more', async () => {
    const s = await sent();
    await openCourse(s);
    await bot.press(s.doc, `kc:${s.courseId}`);
    const question = telegram.lastTo(s.doc)?.messageId;
    await bot.press(s.doc, `kz:${s.courseId}`, question);
    await bot.press(s.doc, `kz:${s.courseId}`, question);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.wrongState', { status: t('ru', 'status.CANCELLED') }));
    expect(countOf(s.patient, t('ru', 'course.withdrawn', { doctor: 'Rustam Rahimov' }))).toBe(1);
  });
});

describe('putting a running course on hold and resuming it', () => {
  it('asks first, then stops the reminders and tells the patient in the patient’s language', async () => {
    const s = await running({ patientLocale: 'uz' });
    bot.clock = local(1, '07:00');
    await openCourse(s);
    expect(dataOf(s.doc)).toEqual([
      `kp:${s.courseId}`,
      `ke:${s.courseId}`,
      `kc:${s.courseId}`,
      `hr:${s.courseId}`,
      'm:d',
    ]);

    await bot.press(s.doc, `kp:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.pauseConfirm', { patient: 'Aziza Karimova' }));
    expect(await statusOf(s.courseId)).toBe('ACTIVE');
    expect(await tally(s.courseId)).toEqual({ SCHEDULED: 14 });

    await bot.press(s.doc, `kn:${s.courseId}`);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.paused', { patient: 'Aziza Karimova' }));
    expect(await statusOf(s.courseId)).toBe('PAUSED');
    expect(await tally(s.courseId)).toEqual({ SUPERSEDED: 14 });
    expect(textOf(s.patient)).toBe(t('uz', 'course.paused', { doctor: 'Rustam Rahimov' }));
  });

  it('shows the patient a paused course with no end date and nothing for today', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `kp:${s.courseId}`);
    await bot.press(s.doc, `kn:${s.courseId}`);

    bot.clock = local(1, '09:00');
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).toContain(
      t('ru', 'card.status', { status: t('ru', 'status.PAUSED') }),
    );
    expect(textOf(s.patient)).toContain(t('ru', 'card.pausedSince', { since: '03.10.2026 07:00' }));
    expect(textOf(s.patient)).not.toContain('09.10.2026');

    await bot.press(s.patient, 'm:t');
    expect(textOf(s.patient)).toBe(t('ru', 'today.none'));
  });

  it('makes an old reminder’s buttons harmless while the course is on hold', async () => {
    const s = await running();
    const [first] = await sql()<{ id: string }[]>`
      select id from scheduled_doses where course_id = ${s.courseId} order by scheduled_at limit 1`;
    bot.clock = local(1, '08:05');
    await openCourse(s);
    await bot.press(s.doc, `kp:${s.courseId}`);
    await bot.press(s.doc, `kn:${s.courseId}`);

    bot.clock = local(1, '08:10');
    await bot.press(s.patient, `xt:${first?.id ?? ''}`);

    expect(textOf(s.patient)).toBe(t('ru', 'dose.notAvailable'));
    expect(await tally(s.courseId)).toEqual({ SUPERSEDED: 14 });
  });

  it('resumes after a question, lays the rest out again and tells both the new last day', async () => {
    const s = await running();
    bot.clock = local(2, '12:00');
    await openCourse(s);
    await bot.press(s.doc, `kp:${s.courseId}`);
    await bot.press(s.doc, `kn:${s.courseId}`);

    // Three days later: the 5th and the 6th of October were wholly on hold.
    bot.clock = local(5, '10:00');
    await openCourse(s);
    expect(dataOf(s.doc)).toEqual([
      `ku:${s.courseId}`,
      `ke:${s.courseId}`,
      `kc:${s.courseId}`,
      `hr:${s.courseId}`,
      'm:d',
    ]);
    await bot.press(s.doc, `ku:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.resumeConfirm', { patient: 'Aziza Karimova' }));
    expect(await statusOf(s.courseId)).toBe('PAUSED');

    await bot.press(s.doc, `kg:${s.courseId}`);

    expect(textOf(s.doc)).toBe(
      t('ru', 'cw.resumed', { patient: 'Aziza Karimova', last: '11.10.2026' }),
    );
    expect(textOf(s.patient)).toBe(
      t('ru', 'course.resumed', { doctor: 'Rustam Rahimov', last: '11.10.2026' }),
    );
    expect(await statusOf(s.courseId)).toBe('ACTIVE');
    expect((await tally(s.courseId)).SCHEDULED).toBe(9);

    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).toContain(
      t('ru', 'card.started', { date: '03.10.2026', last: '11.10.2026' }),
    );
    expect(textOf(s.patient)).toContain(t('ru', 'card.day', { day: 3, days: 7 }));
  });

  it('a stale or repeated button says where the course stands and changes nothing', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `kp:${s.courseId}`);
    const question = telegram.lastTo(s.doc)?.messageId;
    await bot.press(s.doc, `kn:${s.courseId}`, question);
    await bot.press(s.doc, `kn:${s.courseId}`, question);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.wrongState', { status: t('ru', 'status.PAUSED') }));
    await bot.press(s.doc, `kp:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.wrongState', { status: t('ru', 'status.PAUSED') }));

    expect(countOf(s.patient, t('ru', 'course.paused', { doctor: 'Rustam Rahimov' }))).toBe(1);
    const [pauses] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_pauses where course_id = ${s.courseId}`;
    expect(pauses?.n).toBe(1);

    // Resuming twice: the first tap resumes, the second finds the course already running.
    await bot.press(s.doc, `kg:${s.courseId}`);
    await bot.press(s.doc, `kg:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.wrongState', { status: t('ru', 'status.ACTIVE') }));
  });
});

describe('stopping a running course for good', () => {
  it('asks first, then cancels it at once and tells the patient', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `kc:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.cancelConfirm', { patient: 'Aziza Karimova' }));
    expect(await statusOf(s.courseId)).toBe('ACTIVE');

    await bot.press(s.doc, `kz:${s.courseId}`);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.cancelled', { patient: 'Aziza Karimova' }));
    expect(await statusOf(s.courseId)).toBe('CANCELLED');
    expect(await tally(s.courseId)).toEqual({ SUPERSEDED: 14 });
    expect(textOf(s.patient)).toBe(t('ru', 'course.cancelled', { doctor: 'Rustam Rahimov' }));

    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 'm:t');
    expect(textOf(s.patient)).toBe(t('ru', 'today.none'));
    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).not.toContain('Amoxicillin');

    // The doctor's own view: cancelled, and nothing more to be done to it.
    await openCourse(s);
    expect(textOf(s.doc)).toContain(
      t('ru', 'card.status', { status: t('ru', 'status.CANCELLED') }),
    );
    // Nothing more to be done to it, but its history is still there to read.
    expect(dataOf(s.doc)).toEqual([`hr:${s.courseId}`, 'm:d']);
  });
});

describe('changing the plan of a running course', () => {
  it('is written by the doctor out of the patient’s sight, with the plan in force untouched', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `ke:${s.courseId}`);

    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeTitle'));
    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeNone'));
    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeHint'));
    // Nothing is changed yet, so there is nothing to send.
    expect(dataOf(s.doc)).toEqual([
      `ka:${s.courseId}`,
      `kr:${s.courseId}`,
      `kf:${s.courseId}`,
      `kv:${s.courseId}`,
    ]);

    const before = telegram.messagesTo(s.patient).length;
    await addIbuprofen(s);

    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeAdded', { names: 'Ibuprofen' }));
    expect(dataOf(s.doc)).toContain(`kt:${s.courseId}`);
    expect(telegram.messagesTo(s.patient)).toHaveLength(before);
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14 });

    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).not.toContain('Ibuprofen');
    expect(textOf(s.patient)).not.toContain(t('ru', 'course.changePending'));
    expect(dataOf(s.patient)).toEqual([`pp:${s.courseId}`, 'm:h']);

    // The doctor's course screen remembers the unfinished change.
    await openCourse(s);
    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeDraftNote'));
    expect(labelsOf(s.doc)).toContain(t('ru', 'cw.changeContinue'));
  });

  it('is sent after one more look, and reaches the patient as a question with the whole new plan', async () => {
    const s = await running({ patientLocale: 'uz' });
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `ke:${s.courseId}`);
    await addIbuprofen(s);

    await bot.press(s.doc, `kt:${s.courseId}`);
    expect(textOf(s.doc)).toContain('Ibuprofen');
    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeSendConfirm', { patient: 'Aziza Karimova' }));
    expect(dataOf(s.doc)).toEqual([`ko:${s.courseId}`, `ke:${s.courseId}`]);
    expect(countOf(s.patient, 'Ibuprofen')).toBe(0);

    await bot.press(s.doc, `ko:${s.courseId}`);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.changeSent', { patient: 'Aziza Karimova' }));
    const proposal = textOf(s.patient);
    expect(proposal).toContain(t('uz', 'course.changeProposed', { doctor: 'Rustam Rahimov' }));
    expect(proposal).toContain(t('uz', 'cw.changeAdded', { names: 'Ibuprofen' }));
    expect(proposal).toContain(t('uz', 'course.changeNewPlan'));
    expect(proposal).toContain('Amoxicillin');
    expect(proposal).toContain('Ibuprofen');
    expect(proposal).toContain(t('uz', 'course.changeAsk'));
    expect(dataOf(s.patient)).toEqual([`pa:${s.courseId}`]);
    // Sending is not applying: the old plan keeps running.
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14 });

    // The doctor cannot write a second change while this one waits; it can only be taken back.
    await openCourse(s);
    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeWaiting'));
    expect(dataOf(s.doc)).toEqual([
      `kp:${s.courseId}`,
      `kf:${s.courseId}`,
      `kc:${s.courseId}`,
      `hr:${s.courseId}`,
      'm:d',
    ]);
    await bot.press(s.doc, `ka:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'cw.notAvailable'));
  });

  it('takes effect when the patient accepts, and the doctor is told', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await proposeIbuprofen(s);

    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).toContain(t('ru', 'course.changePending'));
    expect(dataOf(s.patient)).toEqual([`pv:${s.courseId}`, `pp:${s.courseId}`, 'm:h']);
    await bot.press(s.patient, `pv:${s.courseId}`);
    expect(textOf(s.patient)).toContain(t('ru', 'cw.changeAdded', { names: 'Ibuprofen' }));
    expect(dataOf(s.patient)).toEqual([`pa:${s.courseId}`, 'm:c']);

    bot.clock = local(1, '07:30');
    await bot.press(s.patient, `pa:${s.courseId}`);

    expect(textOf(s.patient)).toBe(
      `${t('ru', 'course.changeApplied')} ${t('ru', 'course.changeNextDose', { time: '03.10.2026 08:00' })}`,
    );
    expect(textOf(s.doc)).toBe(t('ru', 'doctor.changeAccepted', { patient: 'Aziza Karimova' }));
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14, Ibuprofen: 7 });

    await bot.press(s.patient, 'm:c');
    expect(textOf(s.patient)).toContain('Ibuprofen');
    expect(textOf(s.patient)).not.toContain(t('ru', 'course.changePending'));

    // The doctor may now change the plan again.
    await openCourse(s);
    expect(dataOf(s.doc)).toContain(`ke:${s.courseId}`);
    expect(textOf(s.doc)).toContain('Ibuprofen');
  });

  it('is applied once however often the patient taps', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await proposeIbuprofen(s);
    const proposal = telegram.lastTo(s.patient)?.messageId;

    await bot.press(s.patient, `pa:${s.courseId}`, proposal);
    await bot.press(s.patient, `pa:${s.courseId}`, proposal);

    expect(textOf(s.patient)).toBe(t('ru', 'course.changeNothing'));
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14, Ibuprofen: 7 });
    expect(countOf(s.doc, t('ru', 'doctor.changeAccepted', { patient: 'Aziza Karimova' }))).toBe(1);
  });

  it('can be taken back after sending: the patient is told, and the old button does nothing', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await proposeIbuprofen(s);
    const proposal = telegram.lastTo(s.patient)?.messageId;

    await openCourse(s);
    await bot.press(s.doc, `kf:${s.courseId}`);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.changeDropped'));
    expect(textOf(s.patient)).toBe(t('ru', 'course.changeDropped', { doctor: 'Rustam Rahimov' }));

    await bot.press(s.patient, `pa:${s.courseId}`, proposal);
    expect(
      telegram.messagesTo(s.patient).some((m) => m.text === t('ru', 'course.changeNothing')),
    ).toBe(true);
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14 });
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, `pv:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'course.changeNothing'));
  });

  it('can be dropped before sending without the patient ever hearing of it', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `ke:${s.courseId}`);
    await addIbuprofen(s);
    const before = telegram.messagesTo(s.patient).length;

    await bot.press(s.doc, `kf:${s.courseId}`);

    expect(textOf(s.doc)).toBe(t('ru', 'cw.changeDropped'));
    expect(telegram.messagesTo(s.patient)).toHaveLength(before);
    await openCourse(s);
    expect(textOf(s.doc)).not.toContain('Ibuprofen');
    expect(dataOf(s.doc)).toContain(`ke:${s.courseId}`);
  });

  it('can remove a drug; a plan left empty is refused with the reason', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `ke:${s.courseId}`);
    await bot.press(s.doc, `kr:${s.courseId}`);
    const removal = dataOf(s.doc).find((data) => data.startsWith('kx:')) ?? '';
    await bot.press(s.doc, removal);

    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeRemoved', { names: 'Amoxicillin' }));
    expect(textOf(s.doc)).toContain(t('ru', 'card.noMeds'));

    await bot.press(s.doc, `kt:${s.courseId}`);
    await bot.press(s.doc, `ko:${s.courseId}`);
    expect(textOf(s.doc)).toContain(t('ru', 'cw.cannotSend'));
    expect(textOf(s.doc)).toContain(t('ru', 'cw.problem.NO_MEDICATIONS'));
    expect(countOf(s.patient, t('ru', 'course.changeNewPlan'))).toBe(0);
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14 });
  });

  it('accepted while the course is on hold waits for the course to resume', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await proposeIbuprofen(s);
    await openCourse(s);
    await bot.press(s.doc, `kp:${s.courseId}`);
    await bot.press(s.doc, `kn:${s.courseId}`);

    await bot.press(s.patient, `pv:${s.courseId}`);
    await bot.press(s.patient, `pa:${s.courseId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'course.changeAppliedPaused'));
    expect(await liveDrugs(s.courseId)).toEqual({});

    bot.clock = local(1, '07:45');
    await openCourse(s);
    await bot.press(s.doc, `ku:${s.courseId}`);
    await bot.press(s.doc, `kg:${s.courseId}`);
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14, Ibuprofen: 7 });
  });
});

describe('who may do this', () => {
  it('not the patient: the doctor’s buttons do nothing in a patient’s hands', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await bot.say(s.patient, '/menu');
    const before = telegram.messagesTo(s.patient).length;
    for (const code of ['kp', 'kn', 'kc', 'kz', 'ke', 'kt', 'ko', 'kf', 'ku', 'kg']) {
      await bot.press(s.patient, `${code}:${s.courseId}`);
    }
    expect(await statusOf(s.courseId)).toBe('ACTIVE');
    expect(await tally(s.courseId)).toEqual({ SCHEDULED: 14 });
    expect(allTo(s.patient)).not.toContain(t('ru', 'cw.paused', { patient: 'Aziza Karimova' }));
    expect(telegram.messagesTo(s.patient).length).toBe(before);
    expect(textOf(s.patient)).toBe(t('ru', 'doctor.notAllowed'));
  });

  it('not another doctor: someone else’s course is simply not there', async () => {
    const s = await running();
    const stranger = await doctor();
    bot.clock = local(1, '07:00');
    await bot.say(stranger, '/menu');
    for (const code of ['kn', 'kz', 'ke', 'ko', 'kf', 'kg']) {
      await bot.press(stranger, `${code}:${s.courseId}`);
      expect(textOf(stranger), code).toBe(t('ru', 'cw.notAvailable'));
    }
    expect(await statusOf(s.courseId)).toBe('ACTIVE');
    expect(await tally(s.courseId)).toEqual({ SCHEDULED: 14 });
    expect(countOf(s.patient, 'Rustam Rahimov')).toBe(0);
  });

  it('not a doctor who has lost verification', async () => {
    const s = await running();
    await sql()`
      update clinician_profiles set verification_status = 'REVOKED' where user_id = ${await userId(s.doc)}`;
    bot.clock = local(1, '07:00');
    await bot.say(s.doc, '/menu');
    await bot.press(s.doc, `kn:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'doctor.notAllowed'));
    expect(await statusOf(s.courseId)).toBe('ACTIVE');
  });

  it('nobody but the patient accepts a change', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await proposeIbuprofen(s);
    const outsider = newPerson();
    await register(outsider, { first: 'Other', last: 'Person' });

    await bot.press(outsider, `pa:${s.courseId}`);
    expect(textOf(outsider)).toBe(t('ru', 'start.notAvailable'));
    await bot.press(outsider, `pv:${s.courseId}`);
    expect(textOf(outsider)).toBe(t('ru', 'course.changeNothing'));
    await bot.press(s.doc, `pa:${s.courseId}`);
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14 });
  });
});

describe('a draft’s buttons on a course that is running', () => {
  it('do nothing: length, sending and discarding belong to a draft', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await bot.say(s.doc, '/menu');
    for (const data of [
      `kd:${s.courseId}`,
      `ks:${s.courseId}`,
      `kq:${s.courseId}`,
      `ky:${s.courseId}`,
      `kw:${s.courseId}:7`,
      // Adding a medication with no change open has nothing to add it to.
      `ka:${s.courseId}`,
    ]) {
      await bot.press(s.doc, data);
      expect(textOf(s.doc), data).toBe(t('ru', 'cw.notAvailable'));
    }
    expect(await statusOf(s.courseId)).toBe('ACTIVE');
    expect(await liveDrugs(s.courseId)).toEqual({ Amoxicillin: 14 });
  });

  it('do nothing even while a change is being written: a change has buttons of its own', async () => {
    const s = await running();
    bot.clock = local(1, '07:00');
    await openCourse(s);
    await bot.press(s.doc, `ke:${s.courseId}`);
    for (const data of [`kd:${s.courseId}`, `ks:${s.courseId}`, `kq:${s.courseId}`]) {
      await bot.press(s.doc, data);
      expect(textOf(s.doc), data).toBe(t('ru', 'cw.notAvailable'));
    }
    // The change itself is still there to continue.
    await bot.press(s.doc, `ke:${s.courseId}`);
    expect(textOf(s.doc)).toContain(t('ru', 'cw.changeTitle'));
  });
});
