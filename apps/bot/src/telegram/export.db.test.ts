import { randomBytes } from 'node:crypto';
import {
  MAX_EXPORTS_PER_HOUR,
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
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelegram, createHarness, type Harness, type SentDocument } from './test-harness';

/**
 * The report of a course as a file (TZ §14.3), end to end: a button under the summary, a
 * document in the chat of the person who pressed it, and nothing for anyone else. The course is
 * "Amoxicillin" at 08:00 and 20:00 for seven days, started at 05:00 on 3 October 2026 (Tashkent
 * time). Day 1: the morning dose taken, the evening one skipped with a comment.
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

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

beforeEach(() => {
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
  bot.clock = SENT;
});

let nextId = 33_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const csvOf = (document: SentDocument | undefined): string =>
  new TextDecoder().decode(document?.content ?? new Uint8Array());

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
  readonly courseId: string;
}

/** A doctor, a patient and a course with one day lived through. The clock is left at day 2, 07:00. */
async function lived(
  options: { doctorLocale?: Locale; medication?: Partial<NewMedication> } = {},
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
  await repos.plans.addMedication(actor, courseId, { ...AMOXICILLIN, ...options.medication });
  const sent = await repos.plans.send(actor, courseId, { windowDays: 7, now: SENT });
  expect(sent.status).toBe('SENT');
  bot.clock = STARTED;
  await bot.say(patient, '/menu');
  await bot.press(patient, `pc:${courseId}`);

  const doses = await sql()<{ id: string }[]>`
    select id from scheduled_doses where course_id = ${courseId} order by scheduled_at limit 2`;
  bot.clock = local(1, '08:05');
  await bot.press(patient, `xt:${doses[0]?.id ?? ''}`);
  bot.clock = local(1, '20:10');
  await bot.press(patient, `xk:${doses[1]?.id ?? ''}`);
  await bot.press(patient, `xr:${doses[1]?.id ?? ''}:o`);
  await bot.say(patient, 'была в дороге; =не успела');
  bot.clock = local(2, '07:00');
  return { doc, patient, courseId };
}

describe('the report as a file', () => {
  it('is offered under the summary of a course, to the patient and to the doctor', async () => {
    const s = await lived();

    await bot.press(s.patient, `hv:${s.courseId}`);
    expect(dataOf(s.patient)).toEqual([
      `hd:${s.courseId}:1`,
      `hx:${s.courseId}:p`,
      `hx:${s.courseId}:c`,
      'm:y',
    ]);
    expect(telegram.lastTo(s.patient)?.buttons[1]?.map((button) => button.text)).toEqual([
      t('ru', 'export.pdf'),
      t('ru', 'export.csv'),
    ]);

    await bot.press(s.doc, `hr:${s.courseId}`);
    expect(dataOf(s.doc)).toEqual([
      `hk:${s.courseId}:1`,
      `hy:${s.courseId}:p`,
      `hy:${s.courseId}:c`,
      `kv:${s.courseId}`,
    ]);
  });

  it('comes to the doctor as a CSV that says what the summary says, and to nobody else', async () => {
    const s = await lived();
    const before = telegram.messagesTo(s.doc).length;

    await bot.press(s.doc, `hy:${s.courseId}:c`);

    expect(telegram.documents).toHaveLength(1);
    const [file] = telegram.documentsTo(s.doc);
    expect(file?.filename).toBe(`medcourse-2026-10-04-${s.courseId.slice(0, 8)}.csv`);
    expect(file?.caption).toBe(
      t('ru', 'export.caption', { name: 'Aziza Karimova', at: '04.10.2026 07:00' }),
    );
    expect([...(file?.content.slice(0, 3) ?? [])]).toEqual([0xef, 0xbb, 0xbf]);
    const text = csvOf(file);
    for (const line of [
      'Пациент;Aziza Karimova',
      'Врач;Rustam Rahimov',
      'Отчёт сформирован;04.10.2026 07:00',
      'Кем запрошен;врач',
      'Наступило приёмов;2',
      'Принято вовремя;1',
      'Пропущено с указанием причины;1',
      '"Соблюдение расписания, %";50'.replaceAll('"', ''),
      'Amoxicillin;500 мг;2;1;0;1;0;50',
      '03.10.2026;08:00;Amoxicillin;500 мг;принят вовремя;08:05;;',
      // What the patient typed is in the file as text, and cannot run as a formula.
      '03.10.2026;20:00;Amoxicillin;500 мг;пропущен пациентом;20:10;Другая причина;"была в дороге; =не успела"',
    ]) {
      expect(text, line).toContain(`${line}\r\n`);
    }
    expect(text).toContain(t('ru', 'report.formula'));
    // The screen the button was on is left as it was: the file is a new message.
    expect(telegram.messagesTo(s.doc)).toHaveLength(before);
    expect(telegram.documentsTo(s.patient)).toEqual([]);
  });

  it('comes to the patient as a PDF, in their own language', async () => {
    const s = await lived({ doctorLocale: 'uz' });

    await bot.press(s.patient, `hx:${s.courseId}:p`);

    const [file] = telegram.documentsTo(s.patient);
    expect(file?.filename).toBe(`medcourse-2026-10-04-${s.courseId.slice(0, 8)}.pdf`);
    const pdf = await PDFDocument.load(file?.content ?? new Uint8Array());
    expect(pdf.getTitle()).toBe(t('ru', 'rp.title'));
    expect(pdf.getPageCount()).toBe(1);
    expect(telegram.documentsTo(s.doc)).toEqual([]);

    // The doctor reads Uzbek: the same course, the doctor's words.
    await bot.press(s.doc, `hy:${s.courseId}:p`);
    await bot.press(s.doc, `hy:${s.courseId}:c`);
    const [docPdf, docCsv] = telegram.documentsTo(s.doc);
    expect((await PDFDocument.load(docPdf?.content ?? new Uint8Array())).getTitle()).toBe(
      t('uz', 'rp.title'),
    );
    expect(docPdf?.caption).toBe(
      t('uz', 'export.caption', { name: 'Aziza Karimova', at: '04.10.2026 07:00' }),
    );
    expect(csvOf(docCsv)).toContain('Kim soʻragan;shifokor\r\n');
    expect(csvOf(docCsv)).toContain('bemor oʻtkazib yuborgan');
  });

  it('is recorded each time it is handed out', async () => {
    const s = await lived();
    await bot.press(s.patient, `hx:${s.courseId}:c`);
    await bot.press(s.doc, `hy:${s.courseId}:p`);
    // The file says who it was made for.
    expect(csvOf(telegram.documentsTo(s.patient)[0])).toContain('Кем запрошен;пациент\r\n');

    const rows = await sql()<{ actor_kind: string; format: string; created_at: Date }[]>`
      select actor_kind, format, created_at from course_exports
      where course_id = ${s.courseId} order by actor_kind`;
    expect(rows).toEqual([
      { actor_kind: 'CLINICIAN', format: 'PDF', created_at: local(2, '07:00') },
      { actor_kind: 'PATIENT', format: 'CSV', created_at: local(2, '07:00') },
    ]);
    const audit = await sql()<{ actor_kind: string; reason: string }[]>`
      select actor_kind, reason from audit_log
      where entity_id = ${s.courseId} and action = 'EXPORT' order by actor_kind`;
    expect(audit).toEqual([
      { actor_kind: 'CLINICIAN', reason: 'PDF' },
      { actor_kind: 'PATIENT', reason: 'CSV' },
    ]);
  });

  it('is not given to anyone the course does not belong to, whichever button they forge', async () => {
    const s = await lived();
    const otherDoctor = await doctor();
    const otherPatient = newPerson();
    await register(otherPatient, { first: 'Malika', last: 'Usmanova' });
    bot.clock = local(2, '07:00');

    for (const [who, data] of [
      [otherPatient, `hx:${s.courseId}:p`],
      [otherPatient, `hy:${s.courseId}:c`],
      [otherDoctor, `hy:${s.courseId}:p`],
      [otherDoctor, `hx:${s.courseId}:c`],
      // The patient is not this course's doctor, and the doctor is not its patient.
      [s.patient, `hy:${s.courseId}:c`],
      [s.doc, `hx:${s.courseId}:p`],
    ] as const) {
      await bot.press(who, data);
      expect(telegram.documents, data).toEqual([]);
      if (who === otherPatient || who === otherDoctor) {
        expect(textOf(who)).not.toContain('Amoxicillin');
      }
    }
    expect(textOf(otherDoctor)).toBe(t('ru', 'history.notAvailable'));
    const [rows] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_exports where course_id = ${s.courseId}`;
    expect(rows?.n).toBe(0);
  });

  it('stops for a doctor who no longer treats the patient', async () => {
    const s = await lived();
    await sql()`
      update care_relationships set status = 'ENDED', ended_at = now()
      where clinician_id = ${await userId(s.doc)}`;

    await bot.press(s.doc, `hy:${s.courseId}:c`);

    expect(telegram.documents).toEqual([]);
    expect(textOf(s.doc)).toBe(t('ru', 'history.notAvailable'));
    await bot.press(s.patient, `hx:${s.courseId}:c`);
    expect(telegram.documentsTo(s.patient)).toHaveLength(1);
  });

  it('is limited to a number of files an hour, and says so', async () => {
    const s = await lived();
    for (let index = 0; index < MAX_EXPORTS_PER_HOUR; index += 1) {
      await bot.press(s.doc, `hy:${s.courseId}:c`);
    }
    expect(telegram.documentsTo(s.doc)).toHaveLength(MAX_EXPORTS_PER_HOUR);

    await bot.press(s.doc, `hy:${s.courseId}:p`);

    expect(telegram.documentsTo(s.doc)).toHaveLength(MAX_EXPORTS_PER_HOUR);
    expect(textOf(s.doc)).toBe(t('ru', 'export.tooMany'));
    bot.clock = new Date(local(2, '07:00').getTime() + 3_600_000);
    await bot.press(s.doc, `hy:${s.courseId}:p`);
    expect(telegram.documentsTo(s.doc)).toHaveLength(MAX_EXPORTS_PER_HOUR + 1);
  });

  it('says so when Telegram does not take the file', async () => {
    const s = await lived();
    telegram.failNext.sendDocument = new Error(
      'https://api.telegram.org/bot123:secret/sendDocument',
    );

    await bot.press(s.patient, `hx:${s.courseId}:p`);

    expect(telegram.documents).toEqual([]);
    expect(textOf(s.patient)).toBe(t('ru', 'error.generic'));
  });

  it('comes out for a drug named in letters the report’s font does not have', async () => {
    const s = await lived({ medication: { displayName: '阿司匹林 💊 =SUM(1)' } });

    await bot.press(s.doc, `hy:${s.courseId}:p`);
    await bot.press(s.doc, `hy:${s.courseId}:c`);

    const [pdf, csv] = telegram.documentsTo(s.doc);
    expect((await PDFDocument.load(pdf?.content ?? new Uint8Array())).getPageCount()).toBe(1);
    expect(csvOf(csv)).toContain('阿司匹林 💊 =SUM(1);500 мг;2;1;0;1;0;50\r\n');
  });
});
