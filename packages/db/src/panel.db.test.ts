import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertPatient } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  MAX_PANEL_LOGINS,
  MAX_RESOLUTION_NOTE_LENGTH,
  PANEL_LOGIN_TTL_MS,
  PANEL_SESSION_TTL_MS,
  createRepositories,
  createRepositoryDeps,
  type Repositories,
} from './repositories';

/**
 * The staff panel's data: signing in, and what each kind of staff may see. The acceptance rule
 * of the stage is here: clinic staff and technical administrators each see only their own.
 * The course is "Testamol" at 08:00 and 20:00, started at 05:00 on 3 October 2026 in Tashkent,
 * prescribed by "Rustam Tor" to "Aziza Karimova".
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('panel test');
let telegramId = 70_000_000;
const NOW = new Date('2026-10-03T04:00:00Z');
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

interface Person {
  readonly userId: string;
  readonly telegramUserId: number;
}

/** A registered person (everyone who uses the bot has a name on file). */
async function person(firstName = 'Staff', lastName = 'Member'): Promise<Person> {
  telegramId += 1;
  return {
    userId: await insertPatient(sql(), { telegramId, firstName, lastName }),
    telegramUserId: telegramId,
  };
}

async function techAdmin(): Promise<Person & { actor: Actor & { kind: 'TECH_ADMIN' } }> {
  const who = await person('Tech', 'Admin');
  await repos.platform.grantTechAdmin(system, who.userId);
  return { ...who, actor: { kind: 'TECH_ADMIN', userId: who.userId } };
}

async function staffOf(
  clinicId: string,
  role: 'RECEPTION' | 'CLINIC_ADMIN' = 'RECEPTION',
): Promise<Person & { actor: Actor & { kind: 'CLINIC_STAFF' } }> {
  const who = await person('Front', 'Desk');
  const added = await repos.panel.addClinicStaff(system, {
    clinicId,
    telegramUserId: who.telegramUserId,
    role,
  });
  expect(added.status).toBe('ADDED');
  return { ...who, actor: { kind: 'CLINIC_STAFF', userId: who.userId, clinicId, role } };
}

const running = (): Promise<RunningCourse> => startRunningCourse(sql(), repos);

async function signIn(who: Person, now = NOW): Promise<string> {
  const issued = await repos.panel.issueLogin(system, { userId: who.userId, now });
  if (issued.status !== 'ISSUED') {
    throw new Error(`no sign-in link: ${issued.status}`);
  }
  const session = await repos.panel.redeemLogin({ token: issued.token, now });
  if (session === null) {
    throw new Error('the sign-in link did not work');
  }
  return session.sessionToken;
}

describe('signing in', () => {
  it('starts with a link issued only to staff, shown once and stored as a hash', async () => {
    const admin = await techAdmin();
    const nobody = await person('Just', 'Patient');

    expect(await repos.panel.issueLogin(system, { userId: nobody.userId, now: NOW })).toEqual({
      status: 'NOT_STAFF',
    });
    const issued = await repos.panel.issueLogin(system, { userId: admin.userId, now: NOW });
    expect(issued).toMatchObject({
      status: 'ISSUED',
      expiresAt: new Date(NOW.getTime() + PANEL_LOGIN_TTL_MS),
    });
    const token = issued.status === 'ISSUED' ? issued.token : '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await sql()<{ dump: string }[]>`
      select row_to_json(l)::text as dump from panel_logins l where user_id = ${admin.userId}`;
    expect(stored?.dump).not.toContain(token);

    await expect(
      repos.panel.issueLogin(admin.actor, { userId: admin.userId, now: NOW }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('turns the link into a session exactly once, and only while it is fresh', async () => {
    const admin = await techAdmin();
    const issue = async (now: Date): Promise<string> => {
      const issued = await repos.panel.issueLogin(system, { userId: admin.userId, now });
      return issued.status === 'ISSUED' ? issued.token : '';
    };

    const token = await issue(NOW);
    const session = await repos.panel.redeemLogin({ token, now: NOW });
    expect(session).toMatchObject({ expiresAt: new Date(NOW.getTime() + PANEL_SESSION_TTL_MS) });
    expect(session?.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.sessionToken).not.toBe(token);
    expect(await repos.panel.redeemLogin({ token, now: NOW })).toBeNull();

    const stale = await issue(NOW);
    expect(
      await repos.panel.redeemLogin({
        token: stale,
        now: new Date(NOW.getTime() + PANEL_LOGIN_TTL_MS),
      }),
    ).toBeNull();
    for (const garbage of ['', 'x', `${token}x`, "' or 1=1 --", 'A'.repeat(43)]) {
      expect(await repos.panel.redeemLogin({ token: garbage, now: NOW }), garbage).toBeNull();
    }
    const [sessions] = await sql()<{ n: number; leaked: number }[]>`
      select count(*)::int as n,
             count(*) filter (where token_hash = ${session?.sessionToken ?? ''})::int as leaked
      from panel_sessions where user_id = ${admin.userId}`;
    expect(sessions).toEqual({ n: 1, leaked: 0 });
  });

  it('limits how many links one person may ask for', async () => {
    const admin = await techAdmin();
    for (let index = 0; index < MAX_PANEL_LOGINS; index += 1) {
      expect(
        (await repos.panel.issueLogin(system, { userId: admin.userId, now: NOW })).status,
      ).toBe('ISSUED');
    }
    expect(await repos.panel.issueLogin(system, { userId: admin.userId, now: NOW })).toEqual({
      status: 'TOO_MANY',
    });
    const later = new Date(NOW.getTime() + 16 * 60_000);
    expect(
      (await repos.panel.issueLogin(system, { userId: admin.userId, now: later })).status,
    ).toBe('ISSUED');
  });

  it('gives a session that names the person and what they may act as right now', async () => {
    const clinicId = await insertClinic(sql(), { name: 'Shifo Clinic' });
    const desk = await staffOf(clinicId, 'CLINIC_ADMIN');
    await repos.platform.grantTechAdmin(system, desk.userId);
    const token = await signIn(desk);

    const session = await repos.panel.session({ token, now: NOW });

    expect(session).toMatchObject({
      userId: desk.userId,
      firstName: 'Front',
      lastName: 'Desk',
      locale: 'ru',
    });
    expect(session?.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session?.roles).toEqual(
      expect.arrayContaining([
        { actor: { kind: 'TECH_ADMIN', userId: desk.userId } },
        {
          actor: { kind: 'CLINIC_STAFF', userId: desk.userId, clinicId, role: 'CLINIC_ADMIN' },
          clinicName: 'Shifo Clinic',
        },
      ]),
    );
    expect(session?.roles).toHaveLength(2);
  });

  it('ends when it expires, when the person signs out, and when their account is closed', async () => {
    const admin = await techAdmin();
    const token = await signIn(admin);
    const at = (ms: number) => repos.panel.session({ token, now: new Date(NOW.getTime() + ms) });

    expect(await at(PANEL_SESSION_TTL_MS - 1)).not.toBeNull();
    expect(await at(PANEL_SESSION_TTL_MS)).toBeNull();

    const second = await signIn(admin);
    await repos.panel.signOut({ token: second, now: NOW });
    expect(await repos.panel.session({ token: second, now: NOW })).toBeNull();
    // Signing one browser out leaves the other alone.
    expect(await at(0)).not.toBeNull();

    await sql()`update users set status = 'BLOCKED' where id = ${admin.userId}`;
    expect(await at(0)).toBeNull();
  });

  it('is useless from the moment the role is taken away, and a link issued before that is too', async () => {
    const clinicId = await insertClinic(sql());
    const desk = await staffOf(clinicId);
    const token = await signIn(desk);
    const pending = await repos.panel.issueLogin(system, { userId: desk.userId, now: NOW });
    expect(await repos.panel.session({ token, now: NOW })).not.toBeNull();

    await sql()`update clinic_staff set status = 'REVOKED' where user_id = ${desk.userId}`;

    expect(await repos.panel.session({ token, now: NOW })).toBeNull();
    expect(
      await repos.panel.redeemLogin({
        token: pending.status === 'ISSUED' ? pending.token : '',
        now: NOW,
      }),
    ).toBeNull();
    expect(await repos.panel.issueLogin(system, { userId: desk.userId, now: NOW })).toEqual({
      status: 'NOT_STAFF',
    });
  });

  it('does not count staff of a suspended clinic as staff', async () => {
    const clinicId = await insertClinic(sql());
    const desk = await staffOf(clinicId);
    const token = await signIn(desk);
    await sql()`update clinics set status = 'SUSPENDED' where id = ${clinicId}`;
    expect(await repos.panel.session({ token, now: NOW })).toBeNull();
  });

  it('forgets links and sessions that ran out', async () => {
    const admin = await techAdmin();
    await signIn(admin);
    await expect(repos.panel.prune(admin.actor, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await repos.panel.prune(system, NOW)).toBe(0);
    const removed = await repos.panel.prune(
      system,
      new Date(NOW.getTime() + PANEL_SESSION_TTL_MS + 1),
    );
    expect(removed).toBeGreaterThanOrEqual(2);
    const [left] = await sql()<{ n: number }[]>`
      select count(*)::int as n from panel_sessions where user_id = ${admin.userId}`;
    expect(left?.n).toBe(0);
  });
});

describe('what a clinic’s staff see', () => {
  it('is their own clinic: its doctors and the state of its courses, with names and no prescription', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);

    expect(await repos.panel.clinicOverview(desk.actor)).toEqual({
      clinicName: 'Test clinic',
      doctors: [{ firstName: 'Rustam', lastName: 'Tor', verificationStatus: 'VERIFIED' }],
    });
    const courses = await repos.panel.clinicCourses(desk.actor);
    expect(courses).toEqual([
      {
        courseId: c.courseId,
        status: 'ACTIVE',
        durationDays: 7,
        createdAt: expect.any(Date) as Date,
        startAt: new Date('2026-10-03T00:00:00Z'),
        endedAt: null,
        patientName: 'Aziza Karimova',
        clinicianName: 'Rustam Tor',
      },
    ]);
    // What was prescribed is not the front desk's to know.
    expect(JSON.stringify(courses)).not.toContain('Testamol');
  });

  it('is nothing of any other clinic', async () => {
    const mine = await running();
    const other = await running();
    const desk = await staffOf(mine.clinicId);

    const courses = await repos.panel.clinicCourses(desk.actor);
    expect(courses.map((course) => course.courseId)).toEqual([mine.courseId]);
    // Claiming another clinic in the actor value does not help: the membership is checked.
    await expect(
      repos.panel.clinicCourses({ ...desk.actor, clinicId: other.clinicId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.panel.clinicOverview({ ...desk.actor, clinicId: other.clinicId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('keeps the name of a patient the clinic no longer treats to itself', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    await sql()`
      update care_relationships set status = 'ENDED', ended_at = now() where id = ${c.relationshipId}`;
    const [course] = await repos.panel.clinicCourses(desk.actor);
    expect(course).toMatchObject({ courseId: c.courseId, patientName: null });
  });

  it('is logged each time: a list of who is being treated is personal data', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    await repos.panel.clinicCourses(desk.actor);
    const rows = await sql()<{ action: string; entity_type: string; actor_kind: string }[]>`
      select action, entity_type, actor_kind from audit_log
      where actor_user_id = ${desk.userId} and action = 'READ'`;
    expect(rows).toEqual([
      { action: 'READ', entity_type: 'treatment_courses', actor_kind: 'CLINIC_STAFF' },
    ]);
  });

  it('is closed to a technical administrator, and to staff whose role was revoked', async () => {
    const c = await running();
    const admin = await techAdmin();
    const desk = await staffOf(c.clinicId);

    await expect(repos.panel.clinicCourses(admin.actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.panel.clinicOverview(admin.actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.panel.clinicCourses(c.doctor)).rejects.toBeInstanceOf(ForbiddenError);

    await sql()`update clinic_staff set status = 'REVOKED' where user_id = ${desk.userId}`;
    await expect(repos.panel.clinicCourses(desk.actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.panel.clinicOverview(desk.actor)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('what a technical administrator sees', () => {
  it('is the state of the queues in numbers, and nobody’s name', async () => {
    const c = await running();
    const admin = await techAdmin();
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    await sql()`update treatment_courses set status = 'PAUSED' where status = 'ACTIVE' and id <> ${c.courseId}`;
    // 08:00, 08:10 and 08:20 of day 1 have come due and nothing has been sent: the worker is down.
    const now = local(1, '08:45');

    const stats = await repos.panel.techStats(admin.actor, now);

    expect(stats.reminders).toMatchObject({
      overdue: 3,
      oldestOverdueSeconds: 45 * 60,
      stuck: 0,
      failures: {},
      sentInDay: 0,
      delaySecondsP50: null,
      delaySecondsP95: null,
    });
    expect(stats.reminders.byStatus.QUEUED).toBe(42);
    expect(stats.unsweptDoses).toBe(1);
    expect(stats.courses.ACTIVE).toBe(1);
    expect(stats.doctors.VERIFIED).toBeGreaterThanOrEqual(1);
    expect(stats.users).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(stats);
    for (const secret of ['Aziza', 'Karimova', 'Rustam', 'Testamol', c.patientId, c.courseId]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('includes how late reminders went out, what failed and with which code, and what is stuck', async () => {
    const c = await running();
    const admin = await techAdmin();
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    const claim = (now: Date) => repos.outbox.claimDue(system, { now, limit: 5, lockMs: 60_000 });

    const [first] = await claim(local(1, '08:00'));
    await repos.outbox.finish(system, first?.notificationId ?? '', {
      status: 'SENT',
      at: new Date(local(1, '08:00').getTime() + 4_000),
    });
    const [second] = await claim(local(1, '08:10'));
    await repos.outbox.finish(system, second?.notificationId ?? '', {
      status: 'FAILED',
      error: 'HTTP_403',
      at: local(1, '08:10'),
    });
    // Taken and never reported on: the worker died.
    await claim(local(1, '08:20'));

    const stats = await repos.panel.techStats(admin.actor, local(1, '08:25'));

    expect(stats.reminders).toMatchObject({
      sentInDay: 1,
      delaySecondsP50: 4,
      delaySecondsP95: 4,
      stuck: 1,
    });
    expect(stats.reminders.failures.HTTP_403).toBe(1);
    // The failure also reached the doctor's queue, and is counted there.
    expect(stats.alerts.byStatus.QUEUED).toBeGreaterThanOrEqual(1);
  });

  it('is the audit trail: who as a reference, what, which fields, and never a value', async () => {
    const c = await running();
    const admin = await techAdmin();

    const all = await repos.panel.auditTrail(admin.actor);
    expect(all.length).toBeGreaterThan(3);
    expect(all.map((row) => row.id)).toEqual([...all.map((row) => row.id)].sort((a, b) => b - a));
    const starts = (await repos.panel.auditTrail(admin.actor, { entityType: 'treatment_courses' }))
      .filter((row) => row.action === 'START')
      .find((row) => c.courseId.startsWith(row.entityRef));
    expect(starts).toMatchObject({
      actorKind: 'PATIENT',
      actorRef: c.patientId.slice(0, 8),
      entityType: 'treatment_courses',
      entityRef: c.courseId.slice(0, 8),
      changes: ['status', 'start_at', 'effective_start_date'],
    });
    const dump = JSON.stringify(all);
    for (const secret of ['Aziza', 'Testamol', c.patientId, c.courseId]) {
      expect(dump).not.toContain(secret);
    }

    const older = await repos.panel.auditTrail(admin.actor, { beforeId: all.at(-1)?.id ?? 0 });
    expect(older.every((row) => row.id < (all.at(-1)?.id ?? 0))).toBe(true);
  });

  it('is closed to clinic staff, to doctors, and to an administrator who was revoked', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId, 'CLINIC_ADMIN');
    const admin = await techAdmin();

    for (const actor of [desk.actor, c.doctor, c.patient]) {
      await expect(repos.panel.techStats(actor, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(repos.panel.auditTrail(actor)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(repos.panel.clinics(actor)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${admin.userId}`;
    await expect(repos.panel.techStats(admin.actor, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.panel.auditTrail(admin.actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.panel.clinics(admin.actor)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('appointing clinic staff', () => {
  it('is done by a technical administrator, by Telegram id, and can be undone', async () => {
    const admin = await techAdmin();
    const clinicId = await insertClinic(sql(), { name: 'Nur Clinic' });
    const who = await person('Malika', 'Usmanova');

    expect(
      await repos.panel.addClinicStaff(admin.actor, {
        clinicId,
        telegramUserId: who.telegramUserId,
        role: 'RECEPTION',
      }),
    ).toEqual({ status: 'ADDED' });
    expect(
      await repos.panel.addClinicStaff(admin.actor, {
        clinicId,
        telegramUserId: who.telegramUserId,
        role: 'CLINIC_ADMIN',
      }),
    ).toEqual({ status: 'UPDATED' });

    const clinic = (await repos.panel.clinics(admin.actor)).find(
      (entry) => entry.clinicId === clinicId,
    );
    expect(clinic).toMatchObject({
      name: 'Nur Clinic',
      status: 'ACTIVE',
      staff: [
        { role: 'CLINIC_ADMIN', status: 'ACTIVE', firstName: 'Malika', lastName: 'Usmanova' },
      ],
    });

    const token = await signIn(who);
    const staffId = clinic?.staff[0]?.staffId ?? '';
    expect(await repos.panel.revokeClinicStaff(admin.actor, staffId)).toBe(true);
    expect(await repos.panel.revokeClinicStaff(admin.actor, staffId)).toBe(false);
    expect(await repos.panel.session({ token, now: NOW })).toBeNull();
  });

  it('needs a real clinic and a registered person', async () => {
    const admin = await techAdmin();
    const clinicId = await insertClinic(sql());
    const who = await person();
    expect(
      await repos.panel.addClinicStaff(admin.actor, {
        clinicId,
        telegramUserId: 999_999_999,
        role: 'RECEPTION',
      }),
    ).toEqual({ status: 'NOT_FOUND' });
    expect(
      await repos.panel.addClinicStaff(admin.actor, {
        clinicId: '00000000-0000-4000-8000-000000000000',
        telegramUserId: who.telegramUserId,
        role: 'RECEPTION',
      }),
    ).toEqual({ status: 'NOT_FOUND' });
  });

  it('is not for clinic staff themselves, whatever their role', async () => {
    const clinicId = await insertClinic(sql());
    const boss = await staffOf(clinicId, 'CLINIC_ADMIN');
    const who = await person();
    await expect(
      repos.panel.addClinicStaff(boss.actor, {
        clinicId,
        telegramUserId: who.telegramUserId,
        role: 'RECEPTION',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.panel.revokeClinicStaff(boss.actor, boss.userId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('incidents', () => {
  /** Three moments in a row left unanswered: the third opens an incident for the clinic. */
  async function missedThree(c: RunningCourse): Promise<void> {
    await sql()`update treatment_courses set status = 'PAUSED' where status = 'ACTIVE' and id <> ${c.courseId}`;
    for (const now of [local(1, '08:30'), local(1, '20:30'), local(2, '08:30')]) {
      while ((await repos.answers.sweepMissed(system, now)) > 0) {
        // until nothing is left
      }
    }
  }

  it('open for the clinic when a patient misses three in a row, with the names its staff may know', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    await missedThree(c);

    const open = await repos.incidents.list(desk.actor, 'OPEN');

    expect(open).toEqual([
      {
        id: expect.any(String) as string,
        kind: 'OPERATIONAL',
        type: 'MISS_SERIES',
        status: 'OPEN',
        openedAt: local(2, '08:30'),
        details: null,
        resolvedAt: null,
        note: null,
        course: { status: 'ACTIVE', patientName: 'Aziza Karimova', clinicianName: 'Rustam Tor' },
      },
    ]);
    expect(JSON.stringify(open)).not.toContain('Testamol');
  });

  it('open once a day when reminders cannot be delivered', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    for (const now of [local(1, '08:00'), local(1, '08:10')]) {
      const [reminder] = await repos.outbox.claimDue(system, { now, limit: 5, lockMs: 60_000 });
      await repos.outbox.finish(system, reminder?.notificationId ?? '', {
        status: 'FAILED',
        error: 'HTTP_403',
        at: now,
      });
    }
    expect(await repos.incidents.list(desk.actor, 'OPEN')).toMatchObject([
      { type: 'UNDELIVERED', openedAt: local(1, '08:00') },
    ]);
  });

  it('of a clinic are for that clinic’s staff only: not another clinic’s, not the technical administrator’s', async () => {
    const c = await running();
    const other = await running();
    const desk = await staffOf(c.clinicId);
    const stranger = await staffOf(other.clinicId, 'CLINIC_ADMIN');
    const admin = await techAdmin();
    await missedThree(c);
    const [incident] = await repos.incidents.list(desk.actor, 'OPEN');
    const incidentId = incident?.id ?? '';

    expect(await repos.incidents.list(stranger.actor, 'OPEN')).toEqual([]);
    expect(
      (await repos.incidents.list(admin.actor, 'OPEN')).filter((row) => row.id === incidentId),
    ).toEqual([]);
    for (const actor of [stranger.actor, admin.actor]) {
      expect(await repos.incidents.resolve(actor, { incidentId, note: 'x', now: NOW })).toBe(false);
    }
    // Claiming the other clinic in the actor value opens nothing either.
    expect(await repos.incidents.list({ ...stranger.actor, clinicId: c.clinicId }, 'OPEN')).toEqual(
      [],
    );
    await expect(repos.incidents.list(c.doctor, 'OPEN')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.incidents.list(c.patient, 'OPEN')).rejects.toBeInstanceOf(ForbiddenError);
    expect((await repos.incidents.list(desk.actor, 'OPEN')).map((row) => row.id)).toEqual([
      incidentId,
    ]);
  });

  it('are closed with a note of what was done, stored encrypted', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    await missedThree(c);
    const [incident] = await repos.incidents.list(desk.actor, 'OPEN');
    const incidentId = incident?.id ?? '';
    const at = local(2, '10:00');

    expect(
      await repos.incidents.resolve(desk.actor, {
        incidentId,
        note: 'Позвонили: пациентка в отъезде до пятницы',
        now: at,
      }),
    ).toBe(true);

    expect(await repos.incidents.list(desk.actor, 'OPEN')).toEqual([]);
    expect(await repos.incidents.list(desk.actor, 'RESOLVED')).toMatchObject([
      {
        id: incidentId,
        status: 'RESOLVED',
        resolvedAt: at,
        note: 'Позвонили: пациентка в отъезде до пятницы',
      },
    ]);
    const [stored] = await sql()<{ resolution_note_enc: string; resolved_by: string }[]>`
      select resolution_note_enc, resolved_by from incidents where id = ${incidentId}`;
    expect(stored?.resolution_note_enc).not.toContain('отъезде');
    expect(stored?.resolved_by).toBe(desk.userId);
    const audit = await sql()<{ dump: string }[]>`
      select row_to_json(a)::text as dump from audit_log a where entity_id = ${incidentId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.dump).not.toContain('отъезде');

    // Closed is closed: a second note does not replace the first.
    expect(await repos.incidents.resolve(desk.actor, { incidentId, note: 'другое', now: at })).toBe(
      false,
    );
  });

  it('can be closed without a note, and refuse one that is too long', async () => {
    const c = await running();
    const desk = await staffOf(c.clinicId);
    await missedThree(c);
    const [incident] = await repos.incidents.list(desk.actor, 'OPEN');
    const incidentId = incident?.id ?? '';

    await expect(
      repos.incidents.resolve(desk.actor, {
        incidentId,
        note: 'я'.repeat(MAX_RESOLUTION_NOTE_LENGTH + 1),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await repos.incidents.resolve(desk.actor, { incidentId, note: '  ', now: NOW })).toBe(
      true,
    );
    expect((await repos.incidents.list(desk.actor, 'RESOLVED'))[0]?.note).toBeNull();
  });

  it('about the service itself are for technical administrators, and say only how many', async () => {
    const c = await running();
    const admin = await techAdmin();
    const desk = await staffOf(c.clinicId);
    await sql()`update incidents set status = 'RESOLVED', resolved_at = now(), resolved_by = ${admin.userId} where kind = 'TECHNICAL' and status = 'OPEN'`;
    await sql()`delete from incidents where kind = 'TECHNICAL'`;
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    await sql()`update treatment_courses set status = 'PAUSED' where status = 'ACTIVE' and id <> ${c.courseId}`;
    await sql()`update doctor_alerts set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;

    // 08:09: the first reminder is nine minutes late. Not an incident yet.
    expect(await repos.incidents.reconcile(system, local(1, '08:09'))).toBe(0);
    // 08:45: three reminders are more than ten minutes late, and one dose is past its deadline.
    expect(await repos.incidents.reconcile(system, local(1, '08:45'))).toBe(2);
    // Later the same day: the same facts add nothing.
    expect(await repos.incidents.reconcile(system, local(1, '09:30'))).toBe(0);

    const open = await repos.incidents.list(admin.actor, 'OPEN');
    expect(open.map((row) => [row.type, row.details, row.course])).toEqual(
      expect.arrayContaining([
        ['QUEUE_LATE', { reminders: 3, alerts: 0 }, null],
        ['SWEEP_LATE', { doses: 1 }, null],
      ]),
    );
    expect(open).toHaveLength(2);
    expect(await repos.incidents.list(desk.actor, 'OPEN')).toEqual([]);
    await expect(repos.incidents.reconcile(admin.actor, NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const [late] = open;
    expect(
      await repos.incidents.resolve(desk.actor, {
        incidentId: late?.id ?? '',
        note: null,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      await repos.incidents.resolve(admin.actor, {
        incidentId: late?.id ?? '',
        note: 'воркер перезапущен',
        now: NOW,
      }),
    ).toBe(true);
  });
});
