import { randomBytes } from 'node:crypto';
import {
  DELETION_GRACE_MS,
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
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The worker's own code: it is the worker that carries out deletions and draws up summaries.
import { runPrivacySweep } from '../../../worker/src/privacy';
import { runOutbox } from '../../../worker/src/reminders';
import { CONSENT_VERSION } from './handler';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * "Consent and data", end to end (TZ §12, §12.1): leaving a doctor, letting a new doctor see
 * earlier courses, withdrawing consent, asking for deletion and taking it back. The course is
 * "Amoxicillin" at 08:00 and 20:00 for seven days, started at 05:00 on 3 October 2026 (Tashkent
 * time), prescribed by "Rustam Rahimov" to "Aziza Karimova".
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;
const logger = createLogger({ service: 'privacy-test', level: 'silent' });
const system = systemActor('privacy e2e');

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
const SENT = new Date('2026-10-02T10:00:00Z');
const STARTED = new Date('2026-10-03T00:00:00Z');
const DAY = 86_400_000;
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
  await sql()`
    update notifications set status = 'CANCELLED', locked_until = null
    where status in ('QUEUED', 'SENDING')`;
});

let nextId = 35_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const textsTo = (id: number): string[] => telegram.messagesTo(id).map((message) => message.text);

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

async function doctor(options: { locale?: Locale; first?: string; last?: string } = {}) {
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
  readonly relationshipId: string;
}

/** Connects a doctor to a patient and starts a course. The clock is left at 07:00 on day 2. */
async function treat(doc: number, patient: number): Promise<Scene> {
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
  const sent = await repos.plans.send(actor, courseId, { windowDays: 7, now: SENT });
  expect(sent.status).toBe('SENT');
  bot.clock = STARTED;
  await bot.say(patient, '/menu');
  await bot.press(patient, `pc:${courseId}`);
  bot.clock = local(2, '07:00');
  return { doc, patient, courseId, relationshipId };
}

async function running(options: { doctorLocale?: Locale } = {}): Promise<Scene> {
  bot.clock = SENT;
  const doc = await doctor(
    options.doctorLocale === undefined ? {} : { locale: options.doctorLocale },
  );
  const patient = newPerson();
  await register(patient, {});
  return treat(doc, patient);
}

const courseStatus = async (courseId: string): Promise<string | undefined> =>
  (
    await sql()<{ status: string }[]>`select status from treatment_courses where id = ${courseId}`
  )[0]?.status;

/** What the worker would send right now: reminders that are due and still stand. */
async function remindersSent(now: Date): Promise<number> {
  const before = telegram.sent.length;
  await runOutbox({ orm: orm(), repositoryDeps, api: telegram, logger, now: () => now });
  return telegram.sent.length - before;
}

describe('consent and data', () => {
  it('is in the settings, and shows what was agreed to and what can be done about it', async () => {
    const s = await running();

    await bot.press(s.patient, 'm:s');
    expect(dataOf(s.patient)).toContain('s:p');
    await bot.press(s.patient, 's:p');

    expect(textOf(s.patient)).toContain(
      t('ru', 'privacy.consentGiven', { date: '04.10.2026', version: CONSENT_VERSION }).slice(
        0,
        30,
      ),
    );
    expect(textOf(s.patient)).toContain(CONSENT_VERSION);
    expect(dataOf(s.patient)).toEqual(['v:m', 'v:w', 'v:d', 'm:s']);
  });

  it('lists the person’s doctors, with what can be done about each', async () => {
    const s = await running();

    await bot.press(s.patient, 'v:m');

    expect(textOf(s.patient)).toBe(
      `${t('ru', 'privacy.doctorsTitle')}\n${t('ru', 'privacy.doctorLine', { name: 'Rustam Rahimov' })}`,
    );
    expect(dataOf(s.patient)).toEqual([`vs:${s.relationshipId}`, `vl:${s.relationshipId}`, 's:p']);
  });
});

describe('leaving a doctor', () => {
  it('asks first, then stops the course, the reminders and the doctor’s view, and tells the doctor', async () => {
    const s = await running();

    await bot.press(s.patient, `vl:${s.relationshipId}`);
    expect(textOf(s.patient)).toBe(t('ru', 'privacy.leaveAsk', { name: 'Rustam Rahimov' }));
    expect(dataOf(s.patient)).toEqual([`vy:${s.relationshipId}`, 'v:m']);
    // Asking changes nothing.
    expect(await courseStatus(s.courseId)).toBe('ACTIVE');

    await bot.press(s.patient, `vy:${s.relationshipId}`);

    expect(textOf(s.patient)).toBe(
      `${t('ru', 'privacy.left', { name: 'Rustam Rahimov', count: 1 })}\n\n${t('ru', 'privacy.doctorsNone')}`,
    );
    expect(await courseStatus(s.courseId)).toBe('CANCELLED');
    expect(textOf(s.doc)).toBe(t('ru', 'privacy.doctorTold', { name: 'Aziza Karimova', count: 1 }));
    // 08:00 comes and nothing is sent: the reminders went with the course.
    expect(await remindersSent(local(2, '08:00'))).toBe(0);

    // The doctor no longer has the patient or the course.
    await bot.press(s.doc, 'd:p');
    expect(textOf(s.doc)).not.toContain('Karimova');
    await bot.press(s.doc, `hr:${s.courseId}`);
    expect(textOf(s.doc)).toBe(t('ru', 'history.notAvailable'));
    // The patient still has their own history.
    await bot.press(s.patient, `hv:${s.courseId}`);
    expect(textOf(s.patient)).toContain(t('ru', 'report.title'));
  });

  it('tells the doctor in the doctor’s language', async () => {
    const s = await running({ doctorLocale: 'uz' });
    await bot.press(s.patient, `vy:${s.relationshipId}`);
    expect(textOf(s.doc)).toBe(t('uz', 'privacy.doctorTold', { name: 'Aziza Karimova', count: 1 }));
  });

  it('cannot be done to somebody else’s doctor by forging the button', async () => {
    const s = await running();
    const other = await running();

    await bot.press(other.patient, `vy:${s.relationshipId}`);
    await bot.press(other.patient, `vs:${s.relationshipId}`);

    expect(await courseStatus(s.courseId)).toBe('ACTIVE');
    const [relationship] = await sql()<{ status: string; history_shared_at: Date | null }[]>`
      select status, history_shared_at from care_relationships where id = ${s.relationshipId}`;
    expect(relationship).toEqual({ status: 'ACTIVE', history_shared_at: null });
    expect(textsTo(s.doc).some((text) => text.includes('отключился'))).toBe(false);
  });
});

describe('earlier courses for a new doctor', () => {
  it('are shown only once the patient opens them, as summaries without the patient’s words', async () => {
    const s = await running();
    // The first course ends: the patient leaves the first doctor on day 2.
    await bot.press(s.patient, `vy:${s.relationshipId}`);
    await runPrivacySweep({
      orm: orm(),
      repositoryDeps,
      now: new Date(local(2, '07:00').getTime() + 3 * DAY),
      logger,
    });
    bot.clock = local(6, '09:00');
    const second = await doctor({ first: 'Nodira', last: 'Yusupova' });
    const relationshipId = await insertRelationship(
      sql(),
      await userId(s.patient),
      await userId(second),
      'ACTIVE',
    );

    // Not opened: the new doctor has no button, and a forged one is refused.
    await bot.press(second, 'd:p');
    expect(dataOf(second)).not.toContain(`dh:${relationshipId}`);
    await bot.press(second, `dh:${relationshipId}`);
    expect(textOf(second)).toBe(t('ru', 'past.notShared'));

    await bot.press(s.patient, 'v:m');
    await bot.press(s.patient, `vs:${relationshipId}`);
    expect(textOf(s.patient)).toContain(t('ru', 'privacy.shared', { name: 'Nodira Yusupova' }));
    expect(dataOf(s.patient)).toContain(`vn:${relationshipId}`);

    await bot.press(second, 'd:p');
    expect(dataOf(second)).toContain(`dh:${relationshipId}`);
    await bot.press(second, `dh:${relationshipId}`);
    expect(textOf(second)).toBe(
      [
        t('ru', 'past.title'),
        '',
        t('ru', 'past.course', {
          started: '03.10.2026',
          ended: '04.10.2026',
          status: t('ru', 'status.CANCELLED'),
          doctor: 'Rustam Rahimov',
        }),
        // Both doses of day 1 went unanswered before the patient left.
        t('ru', 'past.figure', { taken: 0, occurred: 2, percent: '0' }),
        t('ru', 'past.med', { name: 'Amoxicillin', dose: '500 мг', taken: 0, occurred: 2 }),
      ].join('\n'),
    );

    // The patient closes it again.
    await bot.press(s.patient, `vn:${relationshipId}`);
    expect(textOf(s.patient)).toContain(t('ru', 'privacy.unshared', { name: 'Nodira Yusupova' }));
    await bot.press(second, `dh:${relationshipId}`);
    expect(textOf(second)).toBe(t('ru', 'past.notShared'));
  });
});

describe('withdrawing consent', () => {
  it('asks first, then stops everything, tells the doctor, and answers only with the way back', async () => {
    const s = await running();

    await bot.press(s.patient, 'v:w');
    expect(textOf(s.patient)).toBe(t('ru', 'privacy.withdrawAsk'));
    expect(dataOf(s.patient)).toEqual(['v:x', 's:p']);
    expect(await courseStatus(s.courseId)).toBe('ACTIVE');

    await bot.press(s.patient, 'v:x');

    expect(textOf(s.patient)).toBe(t('ru', 'privacy.withdrawn'));
    expect(dataOf(s.patient)).toEqual(['v:g']);
    expect(await courseStatus(s.courseId)).toBe('CANCELLED');
    expect(textOf(s.doc)).toBe(t('ru', 'privacy.doctorTold', { name: 'Aziza Karimova', count: 1 }));
    expect(await remindersSent(local(2, '08:00'))).toBe(0);

    // Whatever the person sends now, the bot does nothing for them but offer the way back.
    for (const act of [
      () => bot.say(s.patient, '/menu'),
      () => bot.say(s.patient, 'привет'),
      () => bot.press(s.patient, 'm:t'),
      () => bot.press(s.patient, `hv:${s.courseId}`),
      () => bot.press(s.patient, 's:p'),
      () => bot.say(s.patient, '/panel'),
    ]) {
      await act();
      expect(textOf(s.patient)).toBe(t('ru', 'privacy.withdrawn'));
      expect(dataOf(s.patient)).toEqual(['v:g']);
    }
  });

  it('can be given again: the account works, without the doctors', async () => {
    const s = await running();
    await bot.press(s.patient, 'v:x');

    await bot.press(s.patient, 'v:g');

    expect(textOf(s.patient)).toBe(t('ru', 'privacy.regranted'));
    await bot.say(s.patient, '/menu');
    expect(dataOf(s.patient)).toContain('m:t');
    await bot.press(s.patient, 'v:m');
    expect(textOf(s.patient)).toBe(t('ru', 'privacy.doctorsNone'));
    const [consent] = await sql()<{ decision: string; version: string; context: string }[]>`
      select decision, version, context from consent_records
      where user_id = ${await userId(s.patient)} order by at desc limit 1`;
    expect(consent).toEqual({ decision: 'GRANTED', version: CONSENT_VERSION, context: 'SETTINGS' });
  });

  it('is not offered to a doctor, and a forged button does nothing for one', async () => {
    const s = await running();

    await bot.press(s.doc, 's:p');
    expect(textOf(s.doc)).toContain(t('ru', 'privacy.hasRole.CLINICIAN'));
    expect(dataOf(s.doc)).toEqual(['v:m', 'm:s']);

    await bot.press(s.doc, 'v:x');
    await bot.press(s.doc, 'v:e');

    expect(await courseStatus(s.courseId)).toBe('ACTIVE');
    expect((await repos.privacy.standing(system, await userId(s.doc))).consent).toBe('GRANTED');
    await bot.say(s.doc, '/menu');
    expect(dataOf(s.doc)).toContain('m:d');
  });
});

describe('asking for one’s data to be deleted', () => {
  it('asks first with the day it will happen, then closes access and waits', async () => {
    const s = await running();

    await bot.press(s.patient, 'v:d');
    expect(textOf(s.patient)).toBe(t('ru', 'privacy.deleteAsk', { days: 30, date: '03.11.2026' }));
    expect(dataOf(s.patient)).toEqual(['v:e', 's:p']);
    expect(await courseStatus(s.courseId)).toBe('ACTIVE');

    await bot.press(s.patient, 'v:e');

    const pending = t('ru', 'privacy.deletionPending', { date: '03.11.2026' });
    expect(textOf(s.patient)).toBe(pending);
    expect(dataOf(s.patient)).toEqual(['v:u']);
    expect(await courseStatus(s.courseId)).toBe('CANCELLED');
    expect(textOf(s.doc)).toBe(t('ru', 'privacy.doctorTold', { name: 'Aziza Karimova', count: 1 }));

    for (const act of [
      () => bot.say(s.patient, '/start'),
      () => bot.press(s.patient, 'm:t'),
      () => bot.press(s.patient, 'v:g'),
    ]) {
      await act();
      expect(textOf(s.patient)).toBe(pending);
      expect(dataOf(s.patient)).toEqual(['v:u']);
    }
  });

  it('can be taken back before the day, and the data stays', async () => {
    const s = await running();
    await bot.press(s.patient, 'v:e');
    bot.clock = local(20, '09:00');

    await bot.press(s.patient, 'v:u');

    expect(textOf(s.patient)).toBe(`${t('ru', 'privacy.kept')}\n\n${t('ru', 'privacy.withdrawn')}`);
    expect(dataOf(s.patient)).toEqual(['v:g']);
    await runPrivacySweep({
      orm: orm(),
      repositoryDeps,
      now: new Date(local(2, '07:00').getTime() + DELETION_GRACE_MS + DAY),
      logger,
    });
    await bot.press(s.patient, 'v:g');
    await bot.press(s.patient, `hv:${s.courseId}`);
    expect(textOf(s.patient)).toContain(t('ru', 'report.title'));
  });

  it('is carried out on the day: the person is gone, and may come back as somebody new', async () => {
    const s = await running();
    const oldId = await userId(s.patient);
    await bot.press(s.patient, 'v:e');

    const swept = await runPrivacySweep({
      orm: orm(),
      repositoryDeps,
      now: new Date(local(2, '07:00').getTime() + DELETION_GRACE_MS),
      logger,
    });
    expect(swept.accountsErased).toBe(1);

    const [person] = await sql()<{ status: string; first_name: string }[]>`
      select u.status, p.first_name from users u join patient_profiles p on p.user_id = u.id
      where u.id = ${oldId}`;
    expect(person).toEqual({ status: 'DELETED', first_name: '—' });

    bot.clock = new Date(local(2, '07:00').getTime() + DELETION_GRACE_MS + DAY);
    await bot.say(s.patient, '/start');
    expect(dataOf(s.patient)).toEqual(['l:ru', 'l:uz']);
    await register(s.patient, { first: 'Aziza', last: 'Karimova' });
    expect(await userId(s.patient)).not.toBe(oldId);
    // Nothing of the old account comes with the new one.
    await bot.press(s.patient, 'm:y');
    expect(textOf(s.patient)).toBe(t('ru', 'history.none'));
  });
});
