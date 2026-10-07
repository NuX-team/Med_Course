import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertClinicStaff,
  insertClinic,
  insertPatient,
  insertRelationship,
  insertTechAdmin,
} from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { ForbiddenError } from './access/errors';
import { systemActor, type Actor } from './access/actor';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('clinician test');
const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
const clinician = (userId: string): Actor => ({ kind: 'CLINICIAN', userId });
const admin = (userId: string): Actor => ({ kind: 'TECH_ADMIN', userId });
const NOTE = 'Pediatrician, City Clinic No. 5, licence UZ-12345';
const NOW = new Date('2026-10-02T10:00:00Z');

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

let telegramId = 3_000_000;
const nextTelegramId = (): number => (telegramId += 1);

/** A registered person who has applied to be a doctor. */
async function applicant(
  names: { firstName?: string; lastName?: string } = {},
): Promise<{ userId: string; telegramId: number }> {
  const id = nextTelegramId();
  const userId = await insertPatient(sql(), { telegramId: id, ...names });
  const result = await repos.clinicians.register(patient(userId), { userId, note: NOTE });
  expect(result?.created).toBe(true);
  return { userId, telegramId: id };
}

async function verifiedDoctor(): Promise<string> {
  const { userId } = await applicant();
  const by = await insertTechAdmin(sql());
  const done = await repos.clinicians.verify(admin(by), { clinicianId: userId, reference: 'ok' });
  expect(done?.clinician.verificationStatus).toBe('VERIFIED');
  return userId;
}

describe('applying to be a doctor', () => {
  it('opens a private practice and an unverified profile under the name already given', async () => {
    const { userId } = await applicant({ firstName: 'Dilnoza', lastName: 'Yusupova' });

    const profile = await repos.clinicians.getOwn(patient(userId), userId);
    expect(profile).toMatchObject({
      userId,
      firstName: 'Dilnoza',
      lastName: 'Yusupova',
      verificationStatus: 'PENDING',
      clinicStatus: 'ACTIVE',
    });
    const [row] = await sql()<{ note: string; clinic: string }[]>`
      select p.applicant_note as note, c.name as clinic
      from clinician_profiles p join clinics c on c.id = p.clinic_id where p.user_id = ${userId}`;
    expect(row?.note).toBe(NOTE);
    expect(row?.clinic).toBe('Private practice: Yusupova Dilnoza');
  });

  it('is idempotent: asking again changes nothing and opens no second practice', async () => {
    const { userId } = await applicant();
    const again = await repos.clinicians.register(patient(userId), {
      userId,
      note: 'another note',
    });

    expect(again?.created).toBe(false);
    const [counts] = await sql()<{ profiles: number; note: string }[]>`
      select count(*)::int as profiles, max(applicant_note) as note
      from clinician_profiles where user_id = ${userId}`;
    expect(counts).toEqual({ profiles: 1, note: NOTE });
  });

  it('opens exactly one practice when the same person applies many times at once', async () => {
    const id = nextTelegramId();
    const userId = await insertPatient(sql(), { telegramId: id, lastName: 'Racer' });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repos.clinicians.register(patient(userId), { userId, note: NOTE }),
      ),
    );

    expect(results.filter((result) => result?.created === true)).toHaveLength(1);
    const [row] = await sql()<{ clinics: number }[]>`
      select count(*)::int as clinics from clinics where name like 'Private practice: Racer%'`;
    expect(row?.clinics).toBe(1);
  });

  it('needs an active account that already has a name', async () => {
    const nameless = await sql()<{ id: string }[]>`
      insert into users (telegram_user_id) values (${nextTelegramId()}) returning id`;
    const namelessId = nameless[0]?.id ?? '';
    expect(await repos.clinicians.register(system, { userId: namelessId, note: NOTE })).toBeNull();

    const blocked = await insertPatient(sql(), { userStatus: 'BLOCKED' });
    expect(await repos.clinicians.register(system, { userId: blocked, note: NOTE })).toBeNull();
  });

  it('can only be done by the person themselves (or the system)', async () => {
    const userId = await insertPatient(sql());
    const other = await insertPatient(sql());
    const staff = await insertClinicStaff(sql(), await insertClinic(sql()));

    for (const actor of [
      patient(other),
      clinician(other),
      admin(other),
      {
        kind: 'CLINIC_STAFF',
        userId: staff,
        clinicId: await insertClinic(sql()),
        role: 'CLINIC_ADMIN',
      } as const,
    ]) {
      await expect(repos.clinicians.register(actor, { userId, note: NOTE })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await repos.clinicians.register(system, { userId, note: NOTE })).not.toBeNull();
  });

  it('keeps the note to a sensible size and trims it', async () => {
    const userId = await insertPatient(sql());
    for (const bad of ['', '   ', 'x'.repeat(501)]) {
      await expect(repos.clinicians.register(system, { userId, note: bad })).rejects.toThrow(
        RangeError,
      );
    }
    const done = await repos.clinicians.register(system, { userId, note: `  ${NOTE}  ` });
    expect(done?.created).toBe(true);
    const [row] = await sql()<{ note: string }[]>`
      select applicant_note as note from clinician_profiles where user_id = ${userId}`;
    expect(row?.note).toBe(NOTE);
  });

  it('is audited without writing the note into the log', async () => {
    const { userId } = await applicant();
    const rows = await sql()<
      { entity_type: string; action: string; changes: string[]; text: string }[]
    >`
      select entity_type, action, changes, a::text as text from audit_log a
      where entity_id = ${userId} or entity_id in (select clinic_id::text from clinician_profiles where user_id = ${userId})
      order by at, id`;

    expect(rows.map((row) => `${row.entity_type}:${row.action}`).sort()).toEqual([
      'clinician_profiles:CREATE',
      'clinics:CREATE',
    ]);
    for (const row of rows) {
      expect(row.text).not.toContain('licence');
    }
  });
});

describe('verifying a doctor', () => {
  it('lets an administrator accept an applicant and records who and what was checked', async () => {
    const { userId, telegramId: doctorTelegram } = await applicant();
    const by = await insertTechAdmin(sql());

    const done = await repos.clinicians.verify(admin(by), {
      clinicianId: userId,
      reference: '  licence UZ-12345 seen 2026-10-02  ',
    });

    expect(done).toMatchObject({
      changed: true,
      telegramUserId: doctorTelegram,
      locale: 'ru',
      clinician: { userId, verificationStatus: 'VERIFIED' },
    });
    const [row] = await sql()<
      { verified_by: string; verified_at: Date | null; verification_reference: string }[]
    >`select verified_by, verified_at, verification_reference from clinician_profiles where user_id = ${userId}`;
    expect(row?.verified_by).toBe(by);
    expect(row?.verified_at).toBeInstanceOf(Date);
    expect(row?.verification_reference).toBe('licence UZ-12345 seen 2026-10-02');
  });

  it('is idempotent: a second verification writes nothing and keeps the first reference', async () => {
    const { userId } = await applicant();
    const by = await insertTechAdmin(sql());
    await repos.clinicians.verify(admin(by), { clinicianId: userId, reference: 'first' });
    const [before] = await sql()<{ n: number }[]>`select count(*)::int as n from audit_log`;

    const again = await repos.clinicians.verify(admin(by), {
      clinicianId: userId,
      reference: 'second',
    });

    expect(again?.changed).toBe(false);
    const [after] = await sql()<{ n: number; reference: string }[]>`
      select (select count(*)::int from audit_log) as n,
             (select verification_reference from clinician_profiles where user_id = ${userId}) as reference`;
    expect(after).toEqual({ n: before?.n, reference: 'first' });
  });

  it('refuses everyone who is not an administrator, including the system', async () => {
    const { userId } = await applicant();
    const other = await insertPatient(sql());
    const staff = await insertClinicStaff(sql(), await insertClinic(sql()), {
      role: 'CLINIC_ADMIN',
    });

    for (const actor of [
      patient(userId),
      clinician(userId),
      patient(other),
      system,
      {
        kind: 'CLINIC_STAFF',
        userId: staff,
        clinicId: await insertClinic(sql()),
        role: 'CLINIC_ADMIN',
      } as const,
    ]) {
      await expect(
        repos.clinicians.verify(actor, { clinicianId: userId, reference: 'self-approved' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    const [row] = await sql()<{ verification_status: string }[]>`
      select verification_status from clinician_profiles where user_id = ${userId}`;
    expect(row?.verification_status).toBe('PENDING');
  });

  it('refuses an administrator whose rights or account were withdrawn, even with an old actor value', async () => {
    const { userId } = await applicant();
    const revoked = await insertTechAdmin(sql());
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${revoked}`;
    const blocked = await insertTechAdmin(sql());
    await sql()`update users set status = 'BLOCKED' where id = ${blocked}`;

    for (const by of [revoked, blocked]) {
      await expect(
        repos.clinicians.verify(admin(by), { clinicianId: userId, reference: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('answers null for a doctor that does not exist and insists on a reference', async () => {
    const by = await insertTechAdmin(sql());
    const { userId } = await applicant();
    expect(
      await repos.clinicians.verify(admin(by), {
        clinicianId: '00000000-0000-4000-8000-000000000000',
        reference: 'x',
      }),
    ).toBeNull();
    for (const bad of ['', '   ', 'x'.repeat(501)]) {
      await expect(
        repos.clinicians.verify(admin(by), { clinicianId: userId, reference: bad }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('cuts off a revoked doctor immediately and restores them on re-verification', async () => {
    const doctor = await verifiedDoctor();
    const person = await insertPatient(sql(), { lastName: 'Visible' });
    await insertRelationship(sql(), person, doctor, 'ACTIVE');
    const by = await insertTechAdmin(sql());

    expect(await repos.patients.getSummary(clinician(doctor), person)).not.toBeNull();
    expect((await repos.invitations.create(clinician(doctor), { now: NOW })).status).toBe(
      'CREATED',
    );

    const revoked = await repos.clinicians.revoke(admin(by), {
      clinicianId: doctor,
      reference: 'licence lapsed',
    });
    expect(revoked).toMatchObject({ changed: true, clinician: { verificationStatus: 'REVOKED' } });
    expect(await repos.patients.getSummary(clinician(doctor), person)).toBeNull();
    expect((await repos.invitations.create(clinician(doctor), { now: NOW })).status).toBe(
      'NOT_ALLOWED',
    );
    expect(await repos.care.listForClinician(clinician(doctor))).toEqual([]);

    await repos.clinicians.verify(admin(by), { clinicianId: doctor, reference: 'licence renewed' });
    expect(await repos.patients.getSummary(clinician(doctor), person)).not.toBeNull();
  });

  it('cuts off a doctor whose practice is suspended', async () => {
    const doctor = await verifiedDoctor();
    expect((await repos.invitations.create(clinician(doctor), { now: NOW })).status).toBe(
      'CREATED',
    );
    await sql()`
      update clinics set status = 'SUSPENDED'
      where id = (select clinic_id from clinician_profiles where user_id = ${doctor})`;
    expect((await repos.invitations.create(clinician(doctor), { now: NOW })).status).toBe(
      'NOT_ALLOWED',
    );
  });

  it('can be undone: revoking twice is a no-op', async () => {
    const doctor = await verifiedDoctor();
    const by = await insertTechAdmin(sql());
    expect((await repos.clinicians.revoke(admin(by), { clinicianId: doctor }))?.changed).toBe(true);
    expect((await repos.clinicians.revoke(admin(by), { clinicianId: doctor }))?.changed).toBe(
      false,
    );
  });
});

describe('reviewing applicants', () => {
  it('shows an administrator the waiting applicants, oldest first, with what they wrote', async () => {
    const by = await insertTechAdmin(sql());
    const first = await applicant({ lastName: 'Aaa' });
    const second = await applicant({ lastName: 'Bbb' });

    const waiting = await repos.clinicians.listByStatus(admin(by), 'PENDING');
    const ids = waiting.map((row) => row.userId);
    expect(ids.indexOf(first.userId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(first.userId)).toBeLessThan(ids.indexOf(second.userId));
    expect(waiting.find((row) => row.userId === first.userId)).toMatchObject({
      telegramUserId: first.telegramId,
      note: NOTE,
      lastName: 'Aaa',
    });
  });

  it('is for administrators only: everyone else is refused, including a withdrawn administrator', async () => {
    const { userId } = await applicant();
    await expect(repos.clinicians.listByStatus(patient(userId), 'PENDING')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(repos.clinicians.listByStatus(system, 'PENDING')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const gone = await insertTechAdmin(sql());
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${gone}`;
    await expect(repos.clinicians.listByStatus(admin(gone), 'PENDING')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('does not let a doctor read their own record as somebody else', async () => {
    const { userId } = await applicant();
    const stranger = await insertPatient(sql());
    expect(await repos.clinicians.getOwn(patient(stranger), userId)).toBeNull();
    expect(await repos.clinicians.getOwn(clinician(stranger), userId)).toBeNull();
    expect(await repos.clinicians.getOwn(clinician(userId), userId)).not.toBeNull();
  });

  it('opens one applicant in any state, to an administrator who is still one', async () => {
    const by = await insertTechAdmin(sql());
    const { userId, telegramId } = await applicant({ lastName: 'Opened' });

    expect(await repos.clinicians.getApplication(admin(by), userId)).toMatchObject({
      userId,
      telegramUserId: telegramId,
      lastName: 'Opened',
      verificationStatus: 'PENDING',
      note: NOTE,
      verificationReference: null,
    });

    await repos.clinicians.verify(admin(by), { clinicianId: userId, reference: 'seen' });
    await repos.clinicians.revoke(admin(by), { clinicianId: userId });
    expect(await repos.clinicians.getApplication(admin(by), userId)).toMatchObject({
      verificationStatus: 'REVOKED',
      verificationReference: 'seen',
    });
    expect(
      await repos.clinicians.getApplication(admin(by), '00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
    expect(await repos.clinicians.getApplication(admin(by), await insertPatient(sql()))).toBeNull();

    await expect(repos.clinicians.getApplication(patient(by), userId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${by}`;
    await expect(repos.clinicians.getApplication(admin(by), userId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('administrator rights', () => {
  it('are granted by the system to an existing active account, and only then', async () => {
    const userId = await insertPatient(sql());
    expect(await repos.platform.grantTechAdmin(system, userId)).toBe('GRANTED');
    expect(await repos.platform.grantTechAdmin(system, userId)).toBe('ALREADY');
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from platform_staff where user_id = ${userId} and status = 'ACTIVE'`;
    expect(row?.n).toBe(1);

    expect(
      await repos.platform.grantTechAdmin(system, '00000000-0000-4000-8000-000000000000'),
    ).toBe('NO_ACCOUNT');
    const blocked = await insertPatient(sql(), { userStatus: 'BLOCKED' });
    expect(await repos.platform.grantTechAdmin(system, blocked)).toBe('NO_ACCOUNT');
  });

  it('cannot be granted by anyone else, and a granted administrator can verify', async () => {
    const userId = await insertPatient(sql());
    await expect(repos.platform.grantTechAdmin(patient(userId), userId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await repos.platform.grantTechAdmin(system, userId);
    const { userId: applicantId } = await applicant();
    const done = await repos.clinicians.verify(admin(userId), {
      clinicianId: applicantId,
      reference: 'ok',
    });
    expect(done?.changed).toBe(true);
  });

  it('are restored for a previously withdrawn administrator', async () => {
    const userId = await insertTechAdmin(sql());
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${userId}`;
    expect(await repos.platform.grantTechAdmin(system, userId)).toBe('GRANTED');
    const [row] = await sql()<{ status: string }[]>`
      select status from platform_staff where user_id = ${userId}`;
    expect(row?.status).toBe('ACTIVE');
  });
});
