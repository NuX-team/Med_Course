import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician, insertPatient, insertRelationship } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { holdLock, waitForBlocked } from '../test/locks';
import { startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  INVITATION_TTL_MS,
  MAX_FAILED_ATTEMPTS,
  MAX_OPEN_CAREGIVER_INVITATIONS,
  createRepositories,
  createRepositoryDeps,
  hashInviteCode,
  type Repositories,
} from './repositories';

/**
 * A caregiver: added by the doctor, allowed by the patient, read-only. The course of these tests
 * starts at 05:00 on 3 October 2026 in Tashkent with "Testamol" at 08:00 and 20:00.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('caregiver test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;
let telegramId = 60_000_000;

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};
const NOW = local(1, '07:00');

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
  readonly actor: Actor & { kind: 'CAREGIVER' };
  readonly userId: string;
  readonly telegramUserId: number;
}

async function person(firstName = 'Care'): Promise<Person> {
  telegramId += 1;
  const userId = await insertPatient(sql(), { telegramId, firstName, lastName: 'Giver' });
  return { actor: { kind: 'CAREGIVER', userId }, userId, telegramUserId: telegramId };
}

const running = (): Promise<RunningCourse> => startRunningCourse(sql(), repos);

async function link(c: RunningCourse, now = NOW): Promise<string> {
  const created = await repos.caregivers.invite(c.doctor, {
    relationshipId: c.relationshipId,
    now,
  });
  if (created.status !== 'CREATED') {
    throw new Error(`could not create a caregiver link: ${created.status}`);
  }
  return created.code;
}

const redeem = (who: Person, code: string, now = NOW) =>
  repos.caregivers.redeem(who.actor, {
    telegramUserId: who.telegramUserId,
    codeHash: hashInviteCode(code),
    now,
  });

/** A caregiver the patient has allowed. */
async function allowed(c: RunningCourse): Promise<{ who: Person; relationshipId: string }> {
  const who = await person();
  const requested = await redeem(who, await link(c));
  if (requested.status !== 'REQUESTED') {
    throw new Error(`could not use the link: ${requested.status}`);
  }
  await repos.caregivers.decide(c.patient, {
    relationshipId: requested.relationshipId,
    allow: true,
    now: NOW,
  });
  return { who, relationshipId: requested.relationshipId };
}

async function relationshipsOf(patientId: string) {
  return sql()<
    { status: string; scope: string; added_by: string; consent_at: Date | null }[]
  >`select status, scope, added_by, consent_at from caregiver_relationships
    where patient_id = ${patientId} order by created_at`;
}

describe('the doctor’s link', () => {
  it('is issued for a confirmed patient, shown once, and stored only as a hash', async () => {
    const c = await running();

    const created = await repos.caregivers.invite(c.doctor, {
      relationshipId: c.relationshipId,
      now: NOW,
    });

    expect(created).toMatchObject({
      status: 'CREATED',
      expiresAt: new Date(NOW.getTime() + INVITATION_TTL_MS),
      patient: { firstName: 'Aziza', lastName: 'Karimova' },
    });
    const code = created.status === 'CREATED' ? created.code : '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const [row] = await sql()<{ code_hash: string; all_columns: string }[]>`
      select code_hash, row_to_json(i)::text as all_columns from caregiver_invitations i
      where patient_id = ${c.patientId}`;
    expect(row?.code_hash).toBe(hashInviteCode(code));
    expect(row?.all_columns).not.toContain(code);
    const audit = await sql()<{ dump: string }[]>`
      select row_to_json(a)::text as dump from audit_log a where entity_type = 'caregiver_invitations'`;
    expect(audit.map((entry) => entry.dump).join('\n')).not.toContain(code);
  });

  it('is not for another doctor’s patient, an unconfirmed one, or a doctor without standing', async () => {
    const c = await running();
    const clinicId = await insertClinic(sql());
    const stranger: Actor = { kind: 'CLINICIAN', userId: await insertClinician(sql(), clinicId) };
    const input = { relationshipId: c.relationshipId, now: NOW };

    expect(await repos.caregivers.invite(stranger, input)).toEqual({ status: 'NOT_ALLOWED' });
    await expect(repos.caregivers.invite(c.patient, input)).rejects.toBeInstanceOf(ForbiddenError);

    const waiting = await insertRelationship(
      sql(),
      await insertPatient(sql()),
      c.doctorId,
      'PENDING',
    );
    expect(await repos.caregivers.invite(c.doctor, { relationshipId: waiting, now: NOW })).toEqual({
      status: 'NOT_ALLOWED',
    });

    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${c.doctorId}`;
    expect(await repos.caregivers.invite(c.doctor, input)).toEqual({ status: 'NOT_ALLOWED' });
  });

  it('is limited to a few open at a time per patient', async () => {
    const c = await running();
    for (let index = 0; index < MAX_OPEN_CAREGIVER_INVITATIONS; index += 1) {
      await link(c);
    }
    expect(
      await repos.caregivers.invite(c.doctor, { relationshipId: c.relationshipId, now: NOW }),
    ).toEqual({ status: 'LIMIT' });
    // Expired links no longer count.
    const later = new Date(NOW.getTime() + INVITATION_TTL_MS + 1);
    expect(
      (await repos.caregivers.invite(c.doctor, { relationshipId: c.relationshipId, now: later }))
        .status,
    ).toBe('CREATED');
  });
});

describe('opening the link', () => {
  it('says who is to be watched and who asks, without using the link up', async () => {
    const c = await running();
    const who = await person();
    const code = await link(c);
    const input = { telegramUserId: who.telegramUserId, codeHash: hashInviteCode(code), now: NOW };

    for (let look = 0; look < 2; look += 1) {
      expect(await repos.caregivers.inspect(who.actor, input)).toEqual({
        status: 'OK',
        patient: { firstName: 'Aziza', lastName: 'Karimova' },
        clinician: { firstName: 'Rustam', lastName: 'Tor' },
      });
    }
    expect(await relationshipsOf(c.patientId)).toEqual([]);
  });

  it('refuses a link that does not exist, has expired, or whose doctor has lost standing', async () => {
    const c = await running();
    const who = await person();
    const code = await link(c);
    const look = (codeHash: string, now = NOW) =>
      repos.caregivers.inspect(who.actor, { telegramUserId: who.telegramUserId, codeHash, now });

    expect(await look(hashInviteCode('no-such-code-anywhere-1'))).toEqual({ status: 'INVALID' });
    expect(await look(hashInviteCode(code), new Date(NOW.getTime() + INVITATION_TTL_MS))).toEqual({
      status: 'INVALID',
    });

    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${c.doctorId}`;
    expect(await look(hashInviteCode(code))).toEqual({ status: 'INVALID' });
    expect((await redeem(who, code)).status).toBe('INVALID');
    expect(await relationshipsOf(c.patientId)).toEqual([]);
  });

  it('stops answering after too many wrong links, even for a good one', async () => {
    const c = await running();
    const who = await person();
    const code = await link(c);
    for (let guess = 0; guess < MAX_FAILED_ATTEMPTS; guess += 1) {
      await repos.caregivers.inspect(who.actor, {
        telegramUserId: who.telegramUserId,
        codeHash: hashInviteCode(`wrong-guess-number-${String(guess)}---`),
        now: NOW,
      });
    }
    expect((await redeem(who, code)).status).toBe('THROTTLED');
    expect(await relationshipsOf(c.patientId)).toEqual([]);
  });

  it('is not for the patient themself', async () => {
    const c = await running();
    const code = await link(c);
    const self = { kind: 'CAREGIVER', userId: c.patientId } as const;
    expect(
      await repos.caregivers.redeem(self, {
        telegramUserId: c.patientTelegramId,
        codeHash: hashInviteCode(code),
        now: NOW,
      }),
    ).toEqual({ status: 'OWN' });
    expect(await relationshipsOf(c.patientId)).toEqual([]);
  });
});

describe('agreeing to watch', () => {
  it('uses the link up and waits for the patient: nothing is visible yet', async () => {
    const c = await running();
    const who = await person();
    const code = await link(c);

    const requested = await redeem(who, code);

    expect(requested).toMatchObject({
      status: 'REQUESTED',
      patientName: { firstName: 'Aziza' },
      caregiver: { firstName: 'Care', lastName: 'Giver' },
      patient: { telegramUserId: c.patientTelegramId, locale: 'ru' },
    });
    expect(await relationshipsOf(c.patientId)).toEqual([
      { status: 'PENDING', scope: 'SCHEDULE', added_by: c.doctorId, consent_at: null },
    ]);
    expect(await repos.caregivers.wards(who.actor)).toEqual([]);
    expect(
      await repos.caregivers.wardDay(who.actor, { patientId: c.patientId, now: NOW }),
    ).toBeNull();
    expect(await repos.plans.getPlan(who.actor, c.courseId)).toBeNull();

    // The link is spent: neither this person nor anyone else can use it again.
    expect((await redeem(await person('Second'), code)).status).toBe('INVALID');
    expect(await relationshipsOf(c.patientId)).toHaveLength(1);
  });

  it('twice by the same person changes nothing, even through a fresh link', async () => {
    const c = await running();
    const who = await person();
    await redeem(who, await link(c));

    expect(await redeem(who, await link(c))).toEqual({
      status: 'ALREADY',
      patient: { firstName: 'Aziza', lastName: 'Karimova' },
    });
    expect(await relationshipsOf(c.patientId)).toHaveLength(1);
  });

  it('by two people with the same link at the same moment works for exactly one', async () => {
    const c = await running();
    const code = await link(c);
    const first = await person('First');
    const second = await person('Second');
    const held = await holdLock(
      sql(),
      (tx) =>
        tx`select 1 from caregiver_invitations where code_hash = ${hashInviteCode(code)} for update`,
    );
    const attempts = [redeem(first, code), redeem(second, code)];
    await waitForBlocked(sql(), 2);
    await held.release();

    const results = await Promise.all(attempts);
    expect(results.map((result) => result.status).sort()).toEqual(['INVALID', 'REQUESTED']);
    expect(await relationshipsOf(c.patientId)).toHaveLength(1);
  });
});

describe('the patient’s word', () => {
  it('yes opens the schedule to the caregiver, with the moment of consent recorded', async () => {
    const c = await running();
    const who = await person();
    const requested = await redeem(who, await link(c));
    const relationshipId = requested.status === 'REQUESTED' ? requested.relationshipId : '';
    const at = local(1, '07:30');

    const decision = await repos.caregivers.decide(c.patient, {
      relationshipId,
      allow: true,
      now: at,
    });

    expect(decision).toMatchObject({
      status: 'ALLOWED',
      changed: true,
      caregiverName: { firstName: 'Care' },
      caregiver: { telegramUserId: who.telegramUserId },
    });
    expect(await relationshipsOf(c.patientId)).toMatchObject([
      { status: 'ACTIVE', consent_at: at },
    ]);
    expect(await repos.caregivers.wards(who.actor)).toEqual([
      { patientId: c.patientId, firstName: 'Aziza', lastName: 'Karimova' },
    ]);
    expect(await repos.caregivers.listForPatient(c.patient)).toEqual([
      { relationshipId, status: 'ACTIVE', firstName: 'Care', lastName: 'Giver' },
    ]);
  });

  it('no closes the request, and the caregiver sees nothing', async () => {
    const c = await running();
    const who = await person();
    const requested = await redeem(who, await link(c));
    const relationshipId = requested.status === 'REQUESTED' ? requested.relationshipId : '';

    const decision = await repos.caregivers.decide(c.patient, {
      relationshipId,
      allow: false,
      now: NOW,
    });

    expect(decision).toMatchObject({ status: 'REFUSED', changed: true });
    expect(await relationshipsOf(c.patientId)).toMatchObject([
      { status: 'REVOKED', consent_at: null },
    ]);
    expect(await repos.caregivers.wards(who.actor)).toEqual([]);
    expect(await repos.caregivers.listForPatient(c.patient)).toEqual([]);
    // Refused is final: a later "yes" on the same request does not reopen it.
    expect(
      await repos.caregivers.decide(c.patient, { relationshipId, allow: true, now: NOW }),
    ).toEqual({ status: 'NOT_AVAILABLE' });
    expect(await repos.caregivers.wards(who.actor)).toEqual([]);
  });

  it('given twice changes nothing the second time', async () => {
    const c = await running();
    const { relationshipId } = await allowed(c);
    const again = await repos.caregivers.decide(c.patient, {
      relationshipId,
      allow: true,
      now: local(1, '09:00'),
    });
    expect(again).toMatchObject({ status: 'ALLOWED', changed: false });
    expect(await relationshipsOf(c.patientId)).toMatchObject([{ consent_at: NOW }]);
  });

  it('is nobody else’s to give: not the doctor’s, not another patient’s, not the caregiver’s', async () => {
    const c = await running();
    const who = await person();
    const requested = await redeem(who, await link(c));
    const relationshipId = requested.status === 'REQUESTED' ? requested.relationshipId : '';
    const input = { relationshipId, allow: true, now: NOW };

    const other: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    expect(await repos.caregivers.decide(other, input)).toEqual({ status: 'NOT_AVAILABLE' });
    // The caregiver, in their own patient capacity, cannot allow themself.
    expect(await repos.caregivers.decide({ kind: 'PATIENT', userId: who.userId }, input)).toEqual({
      status: 'NOT_AVAILABLE',
    });
    await expect(repos.caregivers.decide(c.doctor, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.caregivers.decide(who.actor, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await relationshipsOf(c.patientId)).toMatchObject([{ status: 'PENDING' }]);
  });

  it('can be taken back at any time, and the caregiver sees nothing from that moment', async () => {
    const c = await running();
    const { who, relationshipId } = await allowed(c);
    expect(
      await repos.caregivers.wardDay(who.actor, { patientId: c.patientId, now: NOW }),
    ).not.toBeNull();

    const revoked = await repos.caregivers.revoke(c.patient, { relationshipId });

    expect(revoked).toMatchObject({
      status: 'REFUSED',
      changed: true,
      caregiver: { telegramUserId: who.telegramUserId },
    });
    expect(await repos.caregivers.wards(who.actor)).toEqual([]);
    expect(
      await repos.caregivers.wardDay(who.actor, { patientId: c.patientId, now: NOW }),
    ).toBeNull();
    expect(await repos.plans.getPlan(who.actor, c.courseId)).toBeNull();
    expect(await repos.caregivers.listForPatient(c.patient)).toEqual([]);
    expect(await repos.caregivers.revoke(c.patient, { relationshipId })).toEqual({
      status: 'NOT_AVAILABLE',
    });
    // To watch again takes a new link and a new yes.
    expect((await redeem(who, await link(c))).status).toBe('REQUESTED');
    expect(await repos.caregivers.wards(who.actor)).toEqual([]);
  });

  it('to revoke is the patient’s own', async () => {
    const c = await running();
    const { who, relationshipId } = await allowed(c);
    const other: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    expect(await repos.caregivers.revoke(other, { relationshipId })).toEqual({
      status: 'NOT_AVAILABLE',
    });
    await expect(repos.caregivers.revoke(c.doctor, { relationshipId })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await repos.caregivers.wards(who.actor)).toHaveLength(1);
  });
});

describe('what a caregiver sees', () => {
  it('is today’s doses with what became of each, and how the schedule has been followed', async () => {
    const c = await running();
    const { who } = await allowed(c);
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
    });

    const day = await repos.caregivers.wardDay(who.actor, {
      patientId: c.patientId,
      now: local(1, '12:00'),
    });

    expect(day?.patient).toEqual({ firstName: 'Aziza', lastName: 'Karimova' });
    expect(day?.courses).toHaveLength(1);
    expect(day?.courses[0]).toMatchObject({
      courseId: c.courseId,
      status: 'ACTIVE',
      timezone: 'Asia/Tashkent',
      adherence: { taken: 1, occurred: 1, percent: 100 },
    });
    expect(day?.courses[0]?.doses).toMatchObject([
      { scheduledAt: local(1, '08:00'), status: 'TAKEN', displayName: 'Testamol' },
      { scheduledAt: local(1, '20:00'), status: 'SCHEDULED' },
    ]);
    // The schedule and the outcomes: no instructions, no reasons, no free text of any kind.
    expect(Object.keys(day?.courses[0]?.doses[0] ?? {}).sort()).toEqual([
      'displayName',
      'doseDisplay',
      'doseId',
      'doseUnit',
      'doseValue',
      'foodRule',
      'scheduledAt',
      'status',
    ]);
  });

  it('follows the patient’s own calendar day', async () => {
    const c = await running();
    const { who } = await allowed(c);
    const day = await repos.caregivers.wardDay(who.actor, {
      patientId: c.patientId,
      now: local(2, '00:30'),
    });
    expect(day?.courses[0]?.doses.map((dose) => dose.scheduledAt)).toEqual([
      local(2, '08:00'),
      local(2, '20:00'),
    ]);
  });

  it('includes a paused course, without the doses taken off its schedule', async () => {
    const c = await running();
    const { who } = await allowed(c);
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(1, '07:10'),
      key: key(),
    });
    const day = await repos.caregivers.wardDay(who.actor, {
      patientId: c.patientId,
      now: local(1, '12:00'),
    });
    expect(day?.courses).toMatchObject([{ status: 'PAUSED', doses: [] }]);
  });

  it('leaves out courses that are cancelled, finished or not started', async () => {
    const c = await running();
    const { who } = await allowed(c);
    await repos.lifecycle.cancel(c.doctor, {
      courseId: c.courseId,
      now: local(1, '07:10'),
      key: key(),
    });
    expect(
      (
        await repos.caregivers.wardDay(who.actor, {
          patientId: c.patientId,
          now: local(1, '12:00'),
        })
      )?.courses,
    ).toEqual([]);
  });

  it('is one patient only: another patient’s day stays closed', async () => {
    const mine = await running();
    const other = await running();
    const { who } = await allowed(mine);

    expect(
      await repos.caregivers.wardDay(who.actor, { patientId: other.patientId, now: NOW }),
    ).toBeNull();
    expect(await repos.plans.getPlan(who.actor, other.courseId)).toBeNull();
    expect((await repos.caregivers.wards(who.actor)).map((ward) => ward.patientId)).toEqual([
      mine.patientId,
    ]);
  });

  it('does not let them answer for the patient, mark an intake, or touch the course', async () => {
    const c = await running();
    const { who } = await allowed(c);
    const now = local(1, '08:05');

    await expect(
      repos.answers.take(who.actor, { doseId: c.firstDoseId, now, key: key() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.answers.skip(who.actor, { doseId: c.firstDoseId, now, key: key(), reason: 'FORGOT' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.prn.available(who.actor, now)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.lifecycle.pause(who.actor, { courseId: c.courseId, now, key: key() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.alerts.requestPause(who.actor, { courseId: c.courseId, now }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.history.report(who.actor, c.courseId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const [dose] = await sql()<{ status: string }[]>`
      select status from scheduled_doses where id = ${c.firstDoseId}`;
    expect(dose?.status).toBe('SCHEDULED');
  });

  it('is closed to a caregiver whose own account is blocked, and for a patient whose account is', async () => {
    const c = await running();
    const { who } = await allowed(c);
    await sql()`update users set status = 'BLOCKED' where id = ${who.userId}`;
    expect(await repos.caregivers.wards(who.actor)).toEqual([]);
    expect(
      await repos.caregivers.wardDay(who.actor, { patientId: c.patientId, now: NOW }),
    ).toBeNull();

    const other = await running();
    const second = await allowed(other);
    await sql()`update users set status = 'BLOCKED' where id = ${other.patientId}`;
    expect(await repos.caregivers.wards(second.who.actor)).toEqual([]);
    expect(
      await repos.caregivers.wardDay(second.who.actor, { patientId: other.patientId, now: NOW }),
    ).toBeNull();
  });

  it('is for caregivers: other capacities are refused outright', async () => {
    const c = await running();
    await expect(repos.caregivers.wards(c.patient)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.caregivers.wards(system)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.caregivers.wardDay(c.doctor, { patientId: c.patientId, now: NOW }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.caregivers.listForPatient(c.doctor)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
