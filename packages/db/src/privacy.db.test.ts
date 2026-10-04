import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertCaregiver,
  insertClinic,
  insertClinician,
  insertPatient,
  insertRelationship,
  insertTechAdmin,
} from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { startRunningCourse, type RunningCourse } from '../test/running-course';
import { hashInviteCode } from './index';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  DELETION_GRACE_MS,
  ERASED_NAME,
  createRepositories,
  createRepositoryDeps,
  type Repositories,
} from './repositories';

/**
 * A person's say over their own data (TZ §12, §12.1). The course is "Testamol" at 08:00 and
 * 20:00 for seven days, started at 05:00 on 3 October 2026 in Tashkent, prescribed by "Rustam
 * Tor" to "Aziza Karimova", with an instruction the doctor wrote for her.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('privacy test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;
const DAY = 86_400_000;

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
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

const running = (): Promise<RunningCourse> =>
  startRunningCourse(sql(), repos, {
    medications: [{ instructions: 'Азизе: запивать тёплой водой' }],
  });

async function doseAt(c: RunningCourse, at: Date): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from scheduled_doses
    where course_id = ${c.courseId} and scheduled_at = ${at} and status <> 'SUPERSEDED'`;
  return row?.id ?? '';
}

/** Day 1: the morning dose taken, the evening one skipped in the patient's own words. */
async function oneDay(c: RunningCourse): Promise<void> {
  await repos.answers.take(c.patient, {
    doseId: await doseAt(c, local(1, '08:00')),
    now: local(1, '08:05'),
    key: key(),
  });
  await repos.answers.skip(c.patient, {
    doseId: await doseAt(c, local(1, '20:00')),
    now: local(1, '20:10'),
    key: key(),
    reason: 'OTHER',
    text: 'позвоните моей маме Гульнаре',
  });
}

/** A second doctor, in another practice, who also treats the same patient. */
async function secondDoctor(c: RunningCourse): Promise<{ actor: Actor; relationshipId: string }> {
  const clinicId = await insertClinic(sql());
  const doctorId = await insertClinician(sql(), clinicId, { firstName: 'Nodira' });
  const relationshipId = await insertRelationship(sql(), c.patientId, doctorId, 'ACTIVE');
  return { actor: { kind: 'CLINICIAN', userId: doctorId }, relationshipId };
}

const courseRow = async (courseId: string) =>
  (
    await sql()<{ status: string; reason: string | null; ended_at: Date | null }[]>`
      select status, cancellation_reason_code as reason, ended_at
      from treatment_courses where id = ${courseId}`
  )[0];

const count = async (query: PromiseLike<{ n: number }[]>): Promise<number> =>
  (await query)[0]?.n ?? 0;

const openDoses = (courseId: string) =>
  count(sql()<{ n: number }[]>`
    select count(*)::int as n from scheduled_doses
    where course_id = ${courseId} and status in ('SCHEDULED', 'NOTIFIED', 'SNOOZED')`);

const waitingReminders = (courseId: string) =>
  count(sql()<{ n: number }[]>`
    select count(*)::int as n from notifications
    where course_id = ${courseId} and status in ('QUEUED', 'SENDING')`);

const relationshipStatus = async (id: string): Promise<string | undefined> =>
  (await sql()<{ status: string }[]>`select status from care_relationships where id = ${id}`)[0]
    ?.status;

describe('leaving a doctor', () => {
  it('stops that doctor’s course at once, ends the doctor’s view, and names the doctor to tell', async () => {
    const c = await running();
    await oneDay(c);
    const now = local(2, '07:00');
    expect(await openDoses(c.courseId)).toBeGreaterThan(0);
    expect(await waitingReminders(c.courseId)).toBeGreaterThan(0);

    const result = await repos.privacy.leaveDoctor(c.patient, {
      relationshipId: c.relationshipId,
      now,
      key: key(),
    });

    expect(result).toMatchObject({
      status: 'LEFT',
      coursesStopped: 1,
      doctor: { locale: 'ru', coursesStopped: 1 },
    });
    expect(await courseRow(c.courseId)).toEqual({
      status: 'CANCELLED',
      reason: 'PATIENT_LEFT',
      ended_at: now,
    });
    expect(await openDoses(c.courseId)).toBe(0);
    expect(await waitingReminders(c.courseId)).toBe(0);
    expect(await relationshipStatus(c.relationshipId)).toBe('ENDED');
    // The doctor no longer sees the course; the patient still sees what they did.
    expect(await repos.history.report(c.doctor, c.courseId)).toBeNull();
    expect((await repos.history.report(c.patient, c.courseId))?.adherence).toMatchObject({
      taken: 1,
      skipped: 1,
    });
    const transitions = await sql()<{ to_status: string; actor_kind: string; reason: string }[]>`
      select to_status, actor_kind, reason from course_transitions
      where course_id = ${c.courseId} and to_status = 'CANCELLED'`;
    expect(transitions).toEqual([
      { to_status: 'CANCELLED', actor_kind: 'PATIENT', reason: 'PATIENT_LEFT' },
    ]);
  });

  it('leaves the patient’s other doctor and that doctor’s course alone', async () => {
    const c = await running();
    const other = await secondDoctor(c);
    const opened = await repos.plans.openDraft(other.actor, {
      relationshipId: other.relationshipId,
      durationDays: 5,
    });

    await repos.privacy.leaveDoctor(c.patient, {
      relationshipId: c.relationshipId,
      now: local(2, '07:00'),
      key: key(),
    });

    expect(await relationshipStatus(other.relationshipId)).toBe('ACTIVE');
    expect((await courseRow(opened?.course.id ?? ''))?.status).toBe('DRAFT');
  });

  it('also closes a course not started yet and a draft, and counts only what the patient was sent', async () => {
    const c = await running();
    const other = await secondDoctor(c);
    const sent = await repos.plans.openDraft(other.actor, {
      relationshipId: other.relationshipId,
      durationDays: 5,
    });
    await repos.plans.addMedication(other.actor, sent?.course.id ?? '', {
      displayName: 'Secondol',
      doseValue: 1,
      doseUnit: 'TABLET',
      foodRule: 'ANY',
      activeFromDay: 1,
      activeToDay: 5,
      schedule: { kind: 'TIMES', times: ['09:00'] },
    });
    await repos.plans.send(other.actor, sent?.course.id ?? '', {
      windowDays: 7,
      now: local(1, '12:00'),
    });
    const draft = await repos.plans.openDraft(other.actor, {
      relationshipId: other.relationshipId,
      durationDays: 3,
    });

    const result = await repos.privacy.leaveDoctor(c.patient, {
      relationshipId: other.relationshipId,
      now: local(2, '07:00'),
      key: key(),
    });

    expect(result).toMatchObject({ status: 'LEFT', coursesStopped: 1 });
    for (const id of [sent?.course.id ?? '', draft?.course.id ?? '']) {
      expect(await courseRow(id)).toMatchObject({ status: 'CANCELLED', reason: 'PATIENT_LEFT' });
    }
    // The first doctor's running course goes on.
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');
  });

  it('is the patient’s own decision about their own doctor, and nobody else’s', async () => {
    const c = await running();
    const stranger: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    const input = { relationshipId: c.relationshipId, now: local(2, '07:00'), key: key() };

    expect(await repos.privacy.leaveDoctor(stranger, input)).toEqual({ status: 'NOT_AVAILABLE' });
    for (const actor of [c.doctor, system]) {
      await expect(repos.privacy.leaveDoctor(actor, input)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');

    expect((await repos.privacy.leaveDoctor(c.patient, input)).status).toBe('LEFT');
    // A request the doctor has not confirmed yet can be taken back the same way, and nothing
    // can be shared with a doctor who has not confirmed.
    const waitingClinic = await insertClinic(sql());
    const waitingDoctor = await insertClinician(sql(), waitingClinic);
    const waiting = await insertRelationship(sql(), c.patientId, waitingDoctor, 'PENDING');
    expect(
      await repos.privacy.shareHistory(c.patient, {
        relationshipId: waiting,
        share: true,
        now: local(2, '07:00'),
      }),
    ).toBe(false);
    expect(
      await repos.privacy.leaveDoctor(c.patient, {
        relationshipId: waiting,
        now: local(2, '07:00'),
        key: key(),
      }),
    ).toMatchObject({ status: 'LEFT', coursesStopped: 0 });
    expect(await relationshipStatus(waiting)).toBe('ENDED');
    // Already left: there is nothing to leave a second time.
    expect(await repos.privacy.leaveDoctor(c.patient, { ...input, key: key() })).toEqual({
      status: 'NOT_AVAILABLE',
    });
  });
});

describe('withdrawing consent', () => {
  it('stops the service for the person: courses, doctors and caregivers, and deletes nothing', async () => {
    const c = await running();
    await oneDay(c);
    const other = await secondDoctor(c);
    const watcher = await insertCaregiver(sql(), c.patientId, {
      status: 'ACTIVE',
      addedBy: c.doctorId,
    });
    // The same person also watches over somebody else's course, and a link for a second
    // caregiver of their own is still open.
    const elsewhere = await running();
    const [watchingRow] = await sql()<{ id: string }[]>`
      insert into caregiver_relationships
        (patient_id, caregiver_user_id, added_by, scope, status, consent_at)
      values (${elsewhere.patientId}, ${c.patientId}, ${elsewhere.doctorId}, 'SCHEDULE', 'ACTIVE', now())
      returning id`;
    const watching = watchingRow?.id ?? '';
    await sql()`
      insert into caregiver_invitations
        (care_relationship_id, patient_id, clinician_id, code_hash, expires_at)
      values (${c.relationshipId}, ${c.patientId}, ${c.doctorId},
              ${hashInviteCode(`cg-${c.patientId}`)}, '2026-12-31T00:00:00Z')`;
    expect(await repos.privacy.standing(system, c.patientId)).toEqual({
      consent: 'NONE',
      deletionDueAt: null,
    });
    await repos.consents.record(c.patient, {
      userId: c.patientId,
      kind: 'PERSONAL_DATA',
      version: 'v1',
      decision: 'GRANTED',
      locale: 'ru',
      context: 'ONBOARDING',
    });

    const result = await repos.privacy.withdrawConsent(c.patient, {
      now: local(2, '07:00'),
      key: key(),
    });

    expect(result).toMatchObject({ status: 'WITHDRAWN', coursesStopped: 1 });
    expect(result.status === 'WITHDRAWN' ? result.doctors : []).toHaveLength(2);
    expect(await repos.privacy.standing(system, c.patientId)).toEqual({
      consent: 'REVOKED',
      deletionDueAt: null,
    });
    expect(await courseRow(c.courseId)).toMatchObject({
      status: 'CANCELLED',
      reason: 'PATIENT_LEFT',
    });
    expect(await waitingReminders(c.courseId)).toBe(0);
    expect(await relationshipStatus(c.relationshipId)).toBe('ENDED');
    expect(await relationshipStatus(other.relationshipId)).toBe('ENDED');
    const [caregiver] = await sql()<{ status: string }[]>`
      select status from caregiver_relationships
      where patient_id = ${c.patientId} and caregiver_user_id = ${watcher}`;
    expect(caregiver?.status).toBe('REVOKED');
    const [watched] = await sql()<{ status: string }[]>`
      select status from caregiver_relationships where id = ${watching}`;
    expect(watched?.status).toBe('REVOKED');
    const [link] = await sql()<{ revoked_at: Date | null }[]>`
      select revoked_at from caregiver_invitations where care_relationship_id = ${c.relationshipId}`;
    expect(link?.revoked_at).toEqual(local(2, '07:00'));
    // Nothing is erased: the name, the answers and the patient's own words are still there.
    expect((await repos.history.report(c.patient, c.courseId))?.otherReasons).toMatchObject([
      { text: 'позвоните моей маме Гульнаре' },
    ]);
    const [stored] = await sql()<{ version: string; decision: string; context: string }[]>`
      select version, decision, context from consent_records
      where user_id = ${c.patientId} order by at desc limit 1`;
    expect(stored).toEqual({ version: 'v1', decision: 'REVOKED', context: 'SETTINGS' });

    expect(
      await repos.privacy.withdrawConsent(c.patient, { now: local(2, '08:00'), key: key() }),
    ).toEqual({ status: 'ALREADY' });
  });

  it('can be given again, which brings the account back without its doctors', async () => {
    const c = await running();
    await repos.privacy.withdrawConsent(c.patient, { now: local(2, '07:00'), key: key() });

    expect(await repos.privacy.grantConsentAgain(c.patient, { version: 'v2', locale: 'uz' })).toBe(
      true,
    );

    expect((await repos.privacy.standing(c.patient, c.patientId)).consent).toBe('GRANTED');
    expect((await repos.privacy.overview(c.patient)).doctors).toEqual([]);
    expect((await repos.privacy.overview(c.patient)).consent?.version).toBe('v2');
    // There is nothing to give again while it stands.
    expect(await repos.privacy.grantConsentAgain(c.patient, { version: 'v2', locale: 'uz' })).toBe(
      false,
    );
  });

  it('is not open to a doctor or to a member of staff: others depend on them', async () => {
    const c = await running();
    const doctorAsPerson: Actor = { kind: 'PATIENT', userId: c.doctorId };
    await sql()`
      insert into patient_profiles (user_id, first_name, last_name)
      values (${c.doctorId}, 'Rustam', 'Tor')`;
    const adminId = await insertTechAdmin(sql());
    const admin: Actor = { kind: 'PATIENT', userId: adminId };
    await sql()`
      insert into patient_profiles (user_id, first_name, last_name)
      values (${adminId}, 'Tech', 'Admin')`;

    const deskId = await insertPatient(sql());
    await sql()`
      insert into clinic_staff (user_id, clinic_id, role) values (${deskId}, ${c.clinicId}, 'RECEPTION')`;
    const desk: Actor = { kind: 'PATIENT', userId: deskId };
    expect((await repos.privacy.overview(desk)).heldRole).toBe('STAFF');
    // A role already taken away no longer holds the person back.
    const formerId = await insertPatient(sql());
    await sql()`
      insert into clinic_staff (user_id, clinic_id, role, status)
      values (${formerId}, ${c.clinicId}, 'RECEPTION', 'REVOKED')`;
    expect(
      (await repos.privacy.overview({ kind: 'PATIENT', userId: formerId })).heldRole,
    ).toBeNull();

    for (const actor of [doctorAsPerson, admin, desk]) {
      const input = { now: local(2, '07:00'), key: key() };
      expect(await repos.privacy.withdrawConsent(actor, input)).toEqual({ status: 'HAS_ROLE' });
      expect(await repos.privacy.requestDeletion(actor, input)).toEqual({ status: 'HAS_ROLE' });
    }
    expect((await repos.privacy.overview(doctorAsPerson)).heldRole).toBe('CLINICIAN');
    expect((await repos.privacy.overview(admin)).heldRole).toBe('STAFF');
    expect((await repos.privacy.overview(c.patient)).heldRole).toBeNull();
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');
  });

  it('shows the person their consent and their doctors', async () => {
    const c = await running();
    await repos.consents.record(c.patient, {
      userId: c.patientId,
      kind: 'PERSONAL_DATA',
      version: '2026-10-v1',
      decision: 'GRANTED',
      locale: 'ru',
      context: 'ONBOARDING',
    });
    const overview = await repos.privacy.overview(c.patient);
    expect(overview.consent).toMatchObject({ version: '2026-10-v1' });
    expect(overview.doctors).toEqual([
      {
        relationshipId: c.relationshipId,
        firstName: 'Rustam',
        lastName: 'Tor',
        status: 'ACTIVE',
        sharesHistory: false,
      },
    ]);
    await expect(repos.privacy.overview(c.doctor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.privacy.standing(c.doctor, c.patientId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('asking for deletion', () => {
  it('ends access now and sets the day the data will be anonymised', async () => {
    const c = await running();
    const now = local(2, '07:00');

    const result = await repos.privacy.requestDeletion(c.patient, { now, key: key() });

    const dueAt = new Date(now.getTime() + DELETION_GRACE_MS);
    expect(result).toMatchObject({ status: 'REQUESTED', dueAt, coursesStopped: 1 });
    expect(DELETION_GRACE_MS).toBe(30 * DAY);
    expect(await repos.privacy.standing(system, c.patientId)).toEqual({
      consent: 'REVOKED',
      deletionDueAt: dueAt,
    });
    expect(await courseRow(c.courseId)).toMatchObject({ status: 'CANCELLED' });
    expect(await relationshipStatus(c.relationshipId)).toBe('ENDED');
    // Asked twice: the first request stands, with its own date.
    expect(
      await repos.privacy.requestDeletion(c.patient, { now: local(5, '07:00'), key: key() }),
    ).toEqual({ status: 'ALREADY', dueAt });
    // The account cannot be picked up again while the request is waiting.
    expect(await repos.privacy.grantConsentAgain(c.patient, { version: 'v1', locale: 'ru' })).toBe(
      false,
    );
  });

  it('can be taken back until it falls due, and then nothing is erased', async () => {
    const c = await running();
    const now = local(2, '07:00');
    await repos.privacy.requestDeletion(c.patient, { now, key: key() });

    expect(await repos.privacy.cancelDeletion(c.patient, { now: local(3, '07:00') })).toBe(true);
    expect(await repos.privacy.cancelDeletion(c.patient, { now: local(3, '07:00') })).toBe(false);

    expect(await repos.privacy.standing(system, c.patientId)).toEqual({
      consent: 'REVOKED',
      deletionDueAt: null,
    });
    expect(await repos.privacy.eraseDue(system, new Date(now.getTime() + 60 * DAY))).not.toContain(
      c.patientId,
    );
    const [name] = await sql()<{ first_name: string }[]>`
      select first_name from patient_profiles where user_id = ${c.patientId}`;
    expect(name?.first_name).toBe('Aziza');
    expect(await repos.privacy.grantConsentAgain(c.patient, { version: 'v1', locale: 'ru' })).toBe(
      true,
    );
  });

  it('is carried out when due: the person is gone from the data, the books still add up', async () => {
    const c = await running();
    await oneDay(c);
    await sql()`
      insert into invitations (clinician_id, code_hash, label, created_at, expires_at, used_at, used_by, care_relationship_id)
      values (${c.doctorId}, ${hashInviteCode(`label-${c.patientId}`)}, 'Азиза с Чиланзара',
              '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', '2026-10-02T00:00:00Z',
              ${c.patientId}, ${c.relationshipId})`;
    await sql()`
      insert into incidents
        (kind, type, clinic_id, course_id, dedupe_key, status, resolution_note_enc, resolved_by,
         resolved_at, opened_at)
      values ('OPERATIONAL', 'MISS_SERIES', ${c.clinicId}, ${c.courseId}, ${`erase-${c.courseId}`},
              'RESOLVED', 'v1:t:called-her-mother', ${c.doctorId}, now(), now())`;
    await sql()`
      insert into panel_sessions (user_id, token_hash, csrf_token, created_at, expires_at)
      values (${c.patientId}, ${hashInviteCode(`session-${c.patientId}`)}, ${'c'.repeat(43)},
              '2026-10-01T00:00:00Z', '2026-12-31T00:00:00Z')`;
    await sql()`
      insert into conversation_states (telegram_user_id, flow, step, expires_at)
      values (${c.patientTelegramId}, 'SETTINGS', 'X', '2026-12-31T00:00:00Z')`;
    await sql()`
      insert into invitation_attempts (telegram_user_id, at)
      values (${c.patientTelegramId}, '2026-10-01T00:00:00Z')`;
    const doses = await count(sql()<{ n: number }[]>`
      select count(*)::int as n from scheduled_doses where course_id = ${c.courseId}`);
    const events = await count(sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events where course_id = ${c.courseId}`);
    const now = local(2, '07:00');
    await repos.privacy.requestDeletion(c.patient, { now, key: key() });
    const due = new Date(now.getTime() + DELETION_GRACE_MS);

    // A minute early: nothing happens.
    expect(await repos.privacy.eraseDue(system, new Date(due.getTime() - 60_000))).not.toContain(
      c.patientId,
    );
    expect(await repos.privacy.eraseDue(system, due)).toContain(c.patientId);

    const [person] = await sql()<
      {
        status: string;
        deleted_at: Date;
        telegram_user_id: string;
        first_name: string;
        last_name: string;
      }[]
    >`select u.status, u.deleted_at, u.telegram_user_id, p.first_name, p.last_name
      from users u join patient_profiles p on p.user_id = u.id where u.id = ${c.patientId}`;
    expect(person).toMatchObject({
      status: 'DELETED',
      deleted_at: due,
      first_name: ERASED_NAME,
      last_name: ERASED_NAME,
    });
    expect(Number(person?.telegram_user_id)).toBeLessThan(0);
    const [text] = await sql()<{ reasons: number; instructions: number; labels: number }[]>`
      select
        (select count(*) from dose_events
          where course_id = ${c.courseId} and reason_text_enc is not null)::int as reasons,
        (select count(*) from course_medications m join course_revisions r on r.id = m.revision_id
          where r.course_id = ${c.courseId} and m.instructions_enc is not null)::int as instructions,
        (select count(*) from invitations
          where used_by = ${c.patientId} and label is not null)::int as labels`;
    expect(text).toEqual({ reasons: 0, instructions: 0, labels: 0 });
    const [rest] = await sql()<
      { notes: number; sessions: number; talks: number; attempts: number; incidents: number }[]
    >`select
        (select count(*) from incidents
          where course_id = ${c.courseId} and resolution_note_enc is not null)::int as notes,
        (select count(*) from incidents where course_id = ${c.courseId})::int as incidents,
        (select count(*) from panel_sessions where user_id = ${c.patientId})::int as sessions,
        (select count(*) from conversation_states
          where telegram_user_id = ${c.patientTelegramId})::int as talks,
        (select count(*) from invitation_attempts
          where telegram_user_id = ${c.patientTelegramId})::int as attempts`;
    // The note about the call is gone; that there was an incident, and that it was closed, stays.
    expect(rest).toEqual({ notes: 0, incidents: 1, sessions: 0, talks: 0, attempts: 0 });
    // Nothing else was touched: every dose and every event is still there, without a person.
    expect(
      await count(sql()<{ n: number }[]>`
        select count(*)::int as n from scheduled_doses where course_id = ${c.courseId}`),
    ).toBe(doses);
    expect(
      await count(sql()<{ n: number }[]>`
        select count(*)::int as n from dose_events where course_id = ${c.courseId}`),
    ).toBeGreaterThanOrEqual(events);
    const [request] = await sql()<{ status: string; closed_at: Date }[]>`
      select status, closed_at from deletion_requests where user_id = ${c.patientId}`;
    expect(request).toEqual({ status: 'DONE', closed_at: due });

    const audit = await sql()<{ actor_kind: string; dump: string }[]>`
      select actor_kind, row_to_json(a)::text as dump from audit_log a
      where entity_id = ${c.patientId} and action = 'ERASE'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_kind).toBe('SYSTEM');
    for (const secret of ['Aziza', 'Karimova', 'Гульнар', String(c.patientTelegramId)]) {
      expect(audit[0]?.dump).not.toContain(secret);
    }
    // Carried out once: a second sweep finds nothing to do.
    expect(await repos.privacy.eraseDue(system, due)).toEqual([]);
  });

  it('lets the same person start afresh afterwards, as somebody new', async () => {
    const c = await running();
    const now = local(2, '07:00');
    await repos.privacy.requestDeletion(c.patient, { now, key: key() });
    await repos.privacy.eraseDue(system, new Date(now.getTime() + DELETION_GRACE_MS));

    expect(await repos.users.findByTelegramId(system, c.patientTelegramId)).toBeNull();
    const again = await repos.users.create(system, {
      telegramUserId: c.patientTelegramId,
      locale: 'ru',
    });
    expect(again.created).toBe(true);
    expect(again.user.id).not.toBe(c.patientId);
  });

  it('is carried out only by the system', async () => {
    const c = await running();
    for (const actor of [c.patient, c.doctor]) {
      await expect(repos.privacy.eraseDue(actor, local(60, '07:00'))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(repos.privacy.summariseDue(actor, local(60, '07:00'))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });
});

describe('the frozen text that anonymisation is allowed to blank', () => {
  it('cannot be touched outside an erasure, and nothing else can be touched inside one', async () => {
    const c = await running();
    await oneDay(c);
    const attempt = async (statements: string[], erasure: boolean): Promise<string | null> => {
      try {
        await sql().begin(async (tx) => {
          if (erasure) {
            await tx`select set_config('medcourse.erasure', 'on', true)`;
          }
          for (const statement of statements) {
            await tx.unsafe(statement);
          }
          throw new Error('rollback');
        });
      } catch (error) {
        return error instanceof Error ? error.message : 'failed';
      }
      return null;
    };
    const blankReason = `update dose_events set reason_text_enc = null where course_id = '${c.courseId}'`;
    const blankInstructions = `update course_medications set instructions_enc = null
      where revision_id in (select id from course_revisions where course_id = '${c.courseId}')`;

    expect(await attempt([blankReason], false)).toContain('append-only');
    expect(await attempt([blankInstructions], false)).toContain('can no longer change');
    // Inside an erasure exactly these two are allowed...
    expect(await attempt([blankReason, blankInstructions], true)).toBe('rollback');
    // ...and nothing else is: not another column, not another text, not a deletion.
    for (const statement of [
      `update dose_events set reason_code = 'FORGOT' where course_id = '${c.courseId}' and reason_code is not null`,
      `update dose_events set reason_text_enc = 'forged' where course_id = '${c.courseId}'`,
      `delete from dose_events where course_id = '${c.courseId}'`,
      `update audit_log set action = 'X'`,
      `update course_medications set display_name = 'Other'
        where revision_id in (select id from course_revisions where course_id = '${c.courseId}')`,
      `update course_medications set instructions_enc = 'forged'
        where revision_id in (select id from course_revisions where course_id = '${c.courseId}')`,
      // Blanking the text is not a way to change something else in the same breath.
      `update dose_events set reason_text_enc = null, reason_code = 'FORGOT'
        where course_id = '${c.courseId}' and reason_text_enc is not null`,
      `update dose_events set occurred_at = occurred_at + interval '1 hour'
        where course_id = '${c.courseId}' and reason_text_enc is null`,
      `update course_medications set instructions_enc = null, display_name = 'Other'
        where revision_id in (select id from course_revisions where course_id = '${c.courseId}')`,
    ]) {
      expect(await attempt([statement], true), statement).not.toBe('rollback');
    }
  });
});

describe('the summary of a finished course', () => {
  /** A course lived for a day and then stopped by its doctor at 07:00 on day 2. */
  async function finished(): Promise<RunningCourse> {
    const c = await running();
    await oneDay(c);
    const stopped = await repos.lifecycle.cancel(c.doctor, {
      courseId: c.courseId,
      now: local(2, '07:00'),
      key: key(),
    });
    expect(stopped.status).toBe('CANCELLED');
    return c;
  }

  const summaryOf = async (courseId: string) =>
    (
      await sql()<{ content: Record<string, unknown>; created_at: Date }[]>`
        select content, created_at from course_summaries where course_id = ${courseId}`
    )[0];

  it('is drawn up three days after the course ends, once, with figures and no free text', async () => {
    const c = await finished();
    const ended = local(2, '07:00');

    await repos.privacy.summariseDue(system, new Date(ended.getTime() + 3 * DAY - 60_000));
    expect(await summaryOf(c.courseId)).toBeUndefined();

    const at = new Date(ended.getTime() + 3 * DAY);
    expect(await repos.privacy.summariseDue(system, at)).toBeGreaterThanOrEqual(1);
    const summary = await summaryOf(c.courseId);
    expect(summary?.created_at).toEqual(at);
    expect(summary?.content).toEqual({
      status: 'CANCELLED',
      startedOn: '2026-10-03',
      endedAt: ended.toISOString(),
      durationDays: 7,
      taken: 1,
      takenLate: 0,
      skipped: 1,
      missed: 0,
      occurred: 2,
      percent: 50,
      medications: [
        {
          name: 'Testamol',
          doseValue: '500.000',
          doseDisplay: null,
          doseUnit: 'MG',
          taken: 1,
          occurred: 2,
          percent: 50,
        },
      ],
      asNeeded: [],
    });
    const dump = JSON.stringify(summary?.content);
    for (const secret of ['Гульнар', 'тёплой', 'Aziza', 'OTHER']) {
      expect(dump).not.toContain(secret);
    }
    // A later run adds nothing and rewrites nothing.
    await repos.privacy.summariseDue(system, new Date(at.getTime() + DAY));
    expect((await summaryOf(c.courseId))?.created_at).toEqual(at);
  });

  it('is not drawn up for a course that never started, or one still running', async () => {
    const c = await running();
    const other = await secondDoctor(c);
    const draft = await repos.plans.openDraft(other.actor, {
      relationshipId: other.relationshipId,
      durationDays: 3,
    });
    const third = await secondDoctor(c);
    const sent = await repos.plans.openDraft(third.actor, {
      relationshipId: third.relationshipId,
      durationDays: 5,
    });
    await repos.plans.addMedication(third.actor, sent?.course.id ?? '', {
      displayName: 'Neverol',
      doseValue: 1,
      doseUnit: 'TABLET',
      foodRule: 'ANY',
      activeFromDay: 1,
      activeToDay: 5,
      schedule: { kind: 'TIMES', times: ['09:00'] },
    });
    await repos.plans.send(third.actor, sent?.course.id ?? '', {
      windowDays: 7,
      now: local(1, '12:00'),
    });
    for (const relationshipId of [other.relationshipId, third.relationshipId]) {
      await repos.privacy.leaveDoctor(c.patient, {
        relationshipId,
        now: local(2, '07:00'),
        key: key(),
      });
    }

    await repos.privacy.summariseDue(system, local(30, '07:00'));

    expect(await summaryOf(draft?.course.id ?? '')).toBeUndefined();
    // Sent to the patient, signed off, and never started: there is nothing to summarise.
    expect(await summaryOf(sent?.course.id ?? '')).toBeUndefined();
    expect(await summaryOf(c.courseId)).toBeUndefined();
  });

  it('reaches a later doctor only with the patient’s say-so, and never the doctor who wrote it', async () => {
    const c = await finished();
    await repos.privacy.summariseDue(system, local(6, '07:00'));
    const next = await secondDoctor(c);
    const shared = () => repos.privacy.sharedSummaries(next.actor, next.relationshipId);

    expect(await shared()).toBeNull();

    expect(
      await repos.privacy.shareHistory(c.patient, {
        relationshipId: next.relationshipId,
        share: true,
        now: local(6, '08:00'),
      }),
    ).toBe(true);
    const summaries = await shared();
    expect(summaries).toMatchObject([
      { courseId: c.courseId, clinicianName: 'Rustam Tor', content: { percent: 50, taken: 1 } },
    ]);
    expect((await repos.privacy.overview(c.patient)).doctors).toContainEqual(
      expect.objectContaining({ relationshipId: next.relationshipId, sharesHistory: true }),
    );
    const [read] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_type = 'course_summaries' and entity_id = ${next.relationshipId} and action = 'READ'`;
    expect(read?.n).toBe(1);

    // The doctor who prescribed the course is not shown it as "an earlier course": it is theirs.
    await repos.privacy.shareHistory(c.patient, {
      relationshipId: c.relationshipId,
      share: true,
      now: local(6, '08:00'),
    });
    expect(await repos.privacy.sharedSummaries(c.doctor, c.relationshipId)).toEqual([]);

    // Somebody else's patient cannot open it, nor another doctor through this relationship.
    const stranger: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    expect(
      await repos.privacy.shareHistory(stranger, {
        relationshipId: next.relationshipId,
        share: false,
        now: local(6, '09:00'),
      }),
    ).toBe(false);
    expect(await repos.privacy.sharedSummaries(c.doctor, next.relationshipId)).toBeNull();
    await expect(
      repos.privacy.sharedSummaries(c.patient, next.relationshipId),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The patient closes it again; and leaving the doctor closes it too.
    await repos.privacy.shareHistory(c.patient, {
      relationshipId: next.relationshipId,
      share: false,
      now: local(6, '10:00'),
    });
    expect(await shared()).toBeNull();
    await repos.privacy.shareHistory(c.patient, {
      relationshipId: next.relationshipId,
      share: true,
      now: local(6, '11:00'),
    });
    await repos.privacy.leaveDoctor(c.patient, {
      relationshipId: next.relationshipId,
      now: local(6, '12:00'),
      key: key(),
    });
    expect(await shared()).toBeNull();
    const [left] = await sql()<{ history_shared_at: Date | null }[]>`
      select history_shared_at from care_relationships where id = ${next.relationshipId}`;
    expect(left?.history_shared_at).toBeNull();
  });

  it('is not drawn up for a person who has withdrawn consent, until they give it again', async () => {
    const c = await finished();
    await repos.privacy.withdrawConsent(c.patient, { now: local(3, '07:00'), key: key() });

    await repos.privacy.summariseDue(system, local(10, '07:00'));
    expect(await summaryOf(c.courseId)).toBeUndefined();

    await repos.privacy.grantConsentAgain(c.patient, { version: 'v2', locale: 'ru' });
    await repos.privacy.summariseDue(system, local(10, '08:00'));
    expect(await summaryOf(c.courseId)).toBeDefined();
  });

  it('is closed to a doctor who has lost their standing, and gone once the patient is erased', async () => {
    const c = await finished();
    await repos.privacy.summariseDue(system, local(6, '07:00'));
    const next = await secondDoctor(c);
    await repos.privacy.shareHistory(c.patient, {
      relationshipId: next.relationshipId,
      share: true,
      now: local(6, '08:00'),
    });
    const nextId = next.actor.kind === 'CLINICIAN' ? next.actor.userId : '';

    await sql()`
      update clinician_profiles set verification_status = 'REVOKED' where user_id = ${nextId}`;
    expect(await repos.privacy.sharedSummaries(next.actor, next.relationshipId)).toBeNull();

    const now = local(7, '07:00');
    await repos.privacy.requestDeletion(c.patient, { now, key: key() });
    await repos.privacy.eraseDue(system, new Date(now.getTime() + DELETION_GRACE_MS));
    expect(await summaryOf(c.courseId)).toBeUndefined();
    // And none is drawn up again for a person who is no longer there.
    await repos.privacy.summariseDue(system, new Date(now.getTime() + DELETION_GRACE_MS + DAY));
    expect(await summaryOf(c.courseId)).toBeUndefined();
  });
});
