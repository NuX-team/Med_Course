import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SKIP_REASON_TEXT,
  confirmRevision,
  insertCaregiver,
  insertClinic,
  insertClinicStaff,
  insertClinician,
  insertCourse,
  insertDose,
  insertMedicationWithRule,
  insertPatient,
  insertRelationship,
  insertSkippedEvent,
  insertUser,
  seedWorld,
  type World,
} from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { resolveActors, systemActor, type Actor } from './access/actor';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

/**
 * Stage 2 acceptance: a wrong person, a wrong clinic, or an expired link must not reach data
 * through any repository. The map of the world (see test/fixtures.ts seedWorld):
 *
 *   Clinic A: doctorA1, doctorA2, receptionA        Clinic B: doctorB1, receptionB
 *   patient1  <- A1 (ACTIVE)   caregivers: schedule-only, with-reasons, pending
 *   patient2  <- A2 (ACTIVE), B1 (ACTIVE)
 *   patient3  <- A1 (ENDED)    patient4 <- A1 (PENDING)    stranger: no links
 *   course1 (patient1, A1, has a skipped dose with a free-text reason)
 *   course2 (patient2, A2)   course3 (patient2, B1)   course4 (patient3, A1, link ended)
 *
 * Describes are ordered: read-only ones first, then the ones that add rows to this shared
 * world. Anything that damages data (revocations) builds a private world instead.
 */

let testDatabase: TestDatabase;
let world: World;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const keys = [{ id: 't1', key: randomBytes(32) }];

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  const deps = createRepositoryDeps(keys);
  repos = createRepositories(testDatabase.db.orm, deps);
  world = await seedWorld(testDatabase.db.sql, deps.cipher);
});

afterAll(async () => {
  await testDatabase.drop();
});

const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
const clinician = (userId: string): Actor => ({ kind: 'CLINICIAN', userId });
const caregiver = (userId: string): Actor => ({ kind: 'CAREGIVER', userId });
const staff = (userId: string, clinicId: string): Actor => ({
  kind: 'CLINIC_STAFF',
  userId,
  clinicId,
  role: 'RECEPTION',
});
const techAdmin = (userId: string): Actor => ({ kind: 'TECH_ADMIN', userId });
const system = systemActor('access test');

interface Case {
  label: string;
  actor: (w: World) => Actor;
  /** Course ids (from the world) this actor may read. */
  sees: (w: World) => string[];
}

const everyCourse = (w: World) => [
  w.course1.courseId,
  w.course2.courseId,
  w.course3.courseId,
  w.course4EndedLink.courseId,
];

const COURSE_CASES: Case[] = [
  {
    label: 'a patient sees only their own course',
    actor: (w) => patient(w.patient1),
    sees: (w) => [w.course1.courseId],
  },
  {
    label: 'a patient with two doctors sees both of their own courses',
    actor: (w) => patient(w.patient2),
    sees: (w) => [w.course2.courseId, w.course3.courseId],
  },
  {
    label: 'a stranger patient sees nothing',
    actor: (w) => patient(w.strangerPatient),
    sees: () => [],
  },
  {
    label: 'a doctor sees their own patient but not a patient whose link ended',
    actor: (w) => clinician(w.doctorA1),
    sees: (w) => [w.course1.courseId],
  },
  {
    label: 'a doctor does not see a colleague’s course in the same clinic',
    actor: (w) => clinician(w.doctorA2),
    sees: (w) => [w.course2.courseId],
  },
  {
    label: 'a doctor of another clinic does not see the other clinic’s course for the same patient',
    actor: (w) => clinician(w.doctorB1),
    sees: (w) => [w.course3.courseId],
  },
  {
    label: 'reception sees no medical content',
    actor: (w) => staff(w.receptionA, w.clinicA),
    sees: () => [],
  },
  {
    label: 'a tech admin sees no medical content',
    actor: (w) => techAdmin(w.techAdmin),
    sees: () => [],
  },
  {
    label: 'an active caregiver sees the course they were added to',
    actor: (w) => caregiver(w.caregiverSchedule),
    sees: (w) => [w.course1.courseId],
  },
  {
    label: 'a pending caregiver sees nothing',
    actor: (w) => caregiver(w.caregiverPending),
    sees: () => [],
  },
  { label: 'the system sees everything', actor: () => system, sees: everyCourse },
];

describe('courses: who can read what', () => {
  it.each(COURSE_CASES)('$label (get)', async ({ actor, sees }) => {
    const who = actor(world);
    const allowed = new Set(sees(world));

    for (const courseId of everyCourse(world)) {
      const found = await repos.courses.get(who, courseId);
      expect(found !== null, `course ${courseId}`).toBe(allowed.has(courseId));
    }
  });

  it.each(COURSE_CASES)('$label (list)', async ({ actor, sees }) => {
    const who = actor(world);
    const ids = (await repos.courses.list(who)).map((course) => course.id).sort();
    if (who.kind === 'SYSTEM') {
      // The system's list also contains rows other tests add; it must at least have these.
      expect(ids).toEqual(expect.arrayContaining(sees(world)));
    } else {
      expect(ids).toEqual([...sees(world)].sort());
    }
  });

  it('answers an unknown id exactly like a forbidden one', async () => {
    const forbidden = await repos.courses.get(patient(world.patient1), world.course2.courseId);
    const unknown = await repos.courses.get(
      patient(world.patient1),
      '00000000-0000-4000-8000-000000000000',
    );
    expect(forbidden).toBeNull();
    expect(unknown).toBeNull();
  });

  it('lets a patient narrow their own list but never widen it', async () => {
    const own = await repos.courses.list(patient(world.patient2), {
      statuses: ['PENDING_PATIENT'],
    });
    expect(own).toHaveLength(2);

    const asked = await repos.courses.list(patient(world.patient2), { patientId: world.patient1 });
    expect(asked).toEqual([]);
  });
});

describe('courses: the administrative view for clinic staff', () => {
  it('lists their own clinic’s courses and nothing from another clinic', async () => {
    const a = await repos.courses.listForAdministration(staff(world.receptionA, world.clinicA));
    const b = await repos.courses.listForAdministration(staff(world.receptionB, world.clinicB));

    expect(a.map((c) => c.id).sort()).toEqual(
      [world.course1.courseId, world.course2.courseId, world.course4EndedLink.courseId].sort(),
    );
    expect(b.map((c) => c.id)).toEqual([world.course3.courseId]);
  });

  it('carries state and dates, never the plan, the timezone or the revision', async () => {
    const [view] = await repos.courses.listForAdministration(
      staff(world.receptionB, world.clinicB),
    );
    expect(Object.keys(view ?? {}).sort()).toEqual(
      [
        'clinicId',
        'clinicianId',
        'durationDays',
        'endedAt',
        'id',
        'patientId',
        'plannedStartAt',
        'startAt',
        'status',
      ].sort(),
    );
  });

  it('cannot be borrowed by a staff actor claiming another clinic', async () => {
    const lying = staff(world.receptionB, world.clinicA);
    expect(await repos.courses.listForAdministration(lying)).toEqual([]);
  });

  it('keeps a staff member of two clinics inside the clinic they act for', async () => {
    const both = await insertClinicStaff(sql(), world.clinicA);
    await sql()`insert into clinic_staff (user_id, clinic_id, role) values (${both}, ${world.clinicB}, 'RECEPTION')`;

    const actors = await resolveActors(testDatabase.db.orm, both);
    expect(actors.filter((actor) => actor.kind === 'CLINIC_STAFF')).toHaveLength(2);

    const asA = await repos.courses.listForAdministration(staff(both, world.clinicA));
    const asB = await repos.courses.listForAdministration(staff(both, world.clinicB));
    expect(asA.every((course) => course.clinicId === world.clinicA)).toBe(true);
    expect(asA.map((course) => course.id)).toContain(world.course1.courseId);
    expect(asB.map((course) => course.id)).toEqual([world.course3.courseId]);
  });

  it.each([
    ['a patient', (w: World) => patient(w.patient1)],
    ['a doctor', (w: World) => clinician(w.doctorA1)],
    ['a caregiver', (w: World) => caregiver(w.caregiverSchedule)],
    ['a tech admin', (w: World) => techAdmin(w.techAdmin)],
  ])('is empty for %s', async (_label, actor) => {
    expect(await repos.courses.listForAdministration(actor(world))).toEqual([]);
  });

  it('is complete for the system', async () => {
    expect((await repos.courses.listForAdministration(system)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('doses and events follow their course', () => {
  it.each(COURSE_CASES)('$label (doses)', async ({ actor, sees }) => {
    const who = actor(world);
    const allowed = new Set(sees(world));
    const courses = [world.course1, world.course2, world.course3, world.course4EndedLink];

    for (const course of courses) {
      const dose = await repos.doses.get(who, course.doseId);
      const list = await repos.doses.listForCourse(who, course.courseId);
      expect(dose !== null, `dose of ${course.courseId}`).toBe(allowed.has(course.courseId));
      expect(list.length > 0, `list of ${course.courseId}`).toBe(allowed.has(course.courseId));
    }
  });

  it('shows the free-text skip reason to the patient, the doctor and a caregiver granted reasons', async () => {
    for (const actor of [
      patient(world.patient1),
      clinician(world.doctorA1),
      caregiver(world.caregiverReasons),
      system,
    ]) {
      const [event] = await repos.doses.listEvents(actor, world.course1.doseId);
      expect(event?.reasonText, actor.kind).toBe(SKIP_REASON_TEXT);
      expect(event?.reasonTextHidden).toBe(false);
    }
  });

  it('withholds the free text, and says so, from a schedule-only caregiver', async () => {
    const [event] = await repos.doses.listEvents(
      caregiver(world.caregiverSchedule),
      world.course1.doseId,
    );

    expect(event?.eventType).toBe('SKIPPED');
    expect(event?.reasonCode).toBe('OTHER');
    expect(event?.reasonText).toBeNull();
    expect(event?.reasonTextHidden).toBe(true);
    expect(JSON.stringify(event)).not.toContain(SKIP_REASON_TEXT);
  });

  it.each([
    ['another patient', (w: World) => patient(w.patient2)],
    ['a colleague', (w: World) => clinician(w.doctorA2)],
    ['reception', (w: World) => staff(w.receptionA, w.clinicA)],
    ['a tech admin', (w: World) => techAdmin(w.techAdmin)],
    ['a pending caregiver', (w: World) => caregiver(w.caregiverPending)],
  ])('returns no events to %s', async (_label, actor) => {
    expect(await repos.doses.listEvents(actor(world), world.course1.doseId)).toEqual([]);
  });
});

describe('patients: names and personal data', () => {
  interface PatientCase {
    label: string;
    actor: (w: World) => Actor;
    name: (w: World) => string;
    visible: boolean;
  }
  const summaryCases: PatientCase[] = [
    {
      label: 'the patient themselves',
      actor: (w) => patient(w.patient1),
      name: (w) => w.patient1,
      visible: true,
    },
    {
      label: 'their doctor',
      actor: (w) => clinician(w.doctorA1),
      name: (w) => w.patient1,
      visible: true,
    },
    {
      label: 'another patient',
      actor: (w) => patient(w.patient2),
      name: (w) => w.patient1,
      visible: false,
    },
    {
      label: 'a colleague with no link',
      actor: (w) => clinician(w.doctorA2),
      name: (w) => w.patient1,
      visible: false,
    },
    {
      label: 'a doctor after the link ended',
      actor: (w) => clinician(w.doctorA1),
      name: (w) => w.patient3EndedWithA1,
      visible: false,
    },
    {
      label: 'a doctor with a pending link',
      actor: (w) => clinician(w.doctorA1),
      name: (w) => w.patient4PendingWithA1,
      visible: false,
    },
    {
      label: 'a doctor with a stranger',
      actor: (w) => clinician(w.doctorA1),
      name: (w) => w.strangerPatient,
      visible: false,
    },
    {
      label: 'an active caregiver',
      actor: (w) => caregiver(w.caregiverSchedule),
      name: (w) => w.patient1,
      visible: true,
    },
    {
      label: 'a pending caregiver',
      actor: (w) => caregiver(w.caregiverPending),
      name: (w) => w.patient1,
      visible: false,
    },
    {
      label: 'reception of a clinic treating the patient',
      actor: (w) => staff(w.receptionA, w.clinicA),
      name: (w) => w.patient1,
      visible: true,
    },
    {
      label: 'reception of a clinic that treats the patient through another doctor',
      actor: (w) => staff(w.receptionB, w.clinicB),
      name: (w) => w.patient2,
      visible: true,
    },
    {
      label: 'reception of a clinic that does not treat the patient',
      actor: (w) => staff(w.receptionB, w.clinicB),
      name: (w) => w.patient1,
      visible: false,
    },
    {
      label: 'reception when the link ended',
      actor: (w) => staff(w.receptionA, w.clinicA),
      name: (w) => w.patient3EndedWithA1,
      visible: false,
    },
    {
      label: 'a tech admin',
      actor: (w) => techAdmin(w.techAdmin),
      name: (w) => w.patient1,
      visible: false,
    },
  ];

  it.each(summaryCases)('name is visible to $label: $visible', async ({ actor, name, visible }) => {
    const summary = await repos.patients.getSummary(actor(world), name(world));
    expect(summary !== null).toBe(visible);
  });

  it('exposes nothing but names in the summary', async () => {
    const summary = await repos.patients.getSummary(clinician(world.doctorA1), world.patient1);
    expect(Object.keys(summary ?? {}).sort()).toEqual(['firstName', 'lastName', 'userId']);
  });
});

describe('patients: encrypted personal data and its audit trail', () => {
  const PHONE = '+998901234567';
  const BIRTH = '1984-03-09';

  async function auditFor(entityId: string): Promise<
    {
      action: string;
      actor_kind: string;
      changes: string[];
      before_hash: string | null;
      after_hash: string | null;
    }[]
  > {
    return sql()`
      select action, actor_kind, changes, before_hash, after_hash from audit_log
      where entity_type = 'patient_profiles' and entity_id = ${entityId} order by id`;
  }

  it('stores phone and birth date only as ciphertext and reads them back for the patient', async () => {
    const user = await insertPatient(sql());
    await repos.patients.upsertProfile(patient(user), {
      userId: user,
      firstName: 'Aziza',
      lastName: 'Karimova',
      phone: PHONE,
      dateOfBirth: BIRTH,
    });

    const [row] = await sql()<{ phone_enc: string; date_of_birth_enc: string }[]>`
      select phone_enc, date_of_birth_enc from patient_profiles where user_id = ${user}`;
    expect(row?.phone_enc).not.toContain('998901234567');
    expect(row?.phone_enc.startsWith('v1.t1.')).toBe(true);
    expect(row?.date_of_birth_enc).not.toContain('1984');

    expect(await repos.patients.getPii(patient(user), user)).toEqual({
      userId: user,
      phone: PHONE,
      dateOfBirth: BIRTH,
    });
  });

  it('refuses a value copied into another patient’s row', async () => {
    const victim = await insertPatient(sql());
    const donor = await insertPatient(sql());
    await repos.patients.upsertProfile(patient(donor), {
      userId: donor,
      firstName: 'D',
      lastName: 'D',
      phone: PHONE,
    });
    await repos.patients.upsertProfile(patient(victim), {
      userId: victim,
      firstName: 'V',
      lastName: 'V',
      phone: '+998900000000',
    });

    await sql()`update patient_profiles
                set phone_enc = (select phone_enc from patient_profiles where user_id = ${donor})
                where user_id = ${victim}`;

    await expect(repos.patients.getPii(patient(victim), victim)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });

  it('keeps stored values when a field is omitted and clears them on null', async () => {
    const user = await insertPatient(sql());
    const self = patient(user);
    await repos.patients.upsertProfile(self, {
      userId: user,
      firstName: 'A',
      lastName: 'B',
      phone: PHONE,
      dateOfBirth: BIRTH,
    });

    await repos.patients.upsertProfile(self, { userId: user, firstName: 'A2', lastName: 'B' });
    expect(await repos.patients.getPii(self, user)).toMatchObject({
      phone: PHONE,
      dateOfBirth: BIRTH,
    });

    await repos.patients.upsertProfile(self, {
      userId: user,
      firstName: 'A2',
      lastName: 'B',
      phone: null,
    });
    expect(await repos.patients.getPii(self, user)).toMatchObject({
      phone: null,
      dateOfBirth: BIRTH,
    });
  });

  it('lets only the patient or the system write a profile', async () => {
    const user = await insertPatient(sql());
    const input = { userId: user, firstName: 'X', lastName: 'Y' };

    for (const actor of [
      patient(world.patient2),
      clinician(world.doctorA1),
      caregiver(world.caregiverSchedule),
      staff(world.receptionA, world.clinicA),
      techAdmin(world.techAdmin),
    ]) {
      await expect(repos.patients.upsertProfile(actor, input), actor.kind).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    await expect(repos.patients.upsertProfile(system, input)).resolves.toMatchObject({
      userId: user,
    });
  });

  it('shows phone and birth date to the patient’s own doctor, and the system, and no one else', async () => {
    const user = world.patient1;
    await repos.patients.upsertProfile(patient(user), {
      userId: user,
      firstName: 'Patient',
      lastName: 'One',
      phone: PHONE,
    });

    expect(await repos.patients.getPii(clinician(world.doctorA1), user)).toMatchObject({
      phone: PHONE,
    });
    expect(await repos.patients.getPii(system, user)).toMatchObject({ phone: PHONE });

    for (const actor of [
      patient(world.patient2),
      clinician(world.doctorA2),
      clinician(world.doctorB1),
      caregiver(world.caregiverReasons),
      staff(world.receptionA, world.clinicA),
      techAdmin(world.techAdmin),
    ]) {
      expect(await repos.patients.getPii(actor, user), actor.kind).toBeNull();
    }
    expect(
      await repos.patients.getPii(clinician(world.doctorA1), world.patient3EndedWithA1),
    ).toBeNull();
  });

  it('writes an audit row for every change and for every read by someone other than the patient', async () => {
    const user = await insertUser(sql());
    await repos.patients.upsertProfile(patient(user), {
      userId: user,
      firstName: 'A',
      lastName: 'B',
      phone: PHONE,
    });
    const doctorClinic = await insertClinic(sql());
    const doctor = await insertClinician(sql(), doctorClinic);
    await insertRelationship(sql(), user, doctor);

    await repos.patients.upsertProfile(patient(user), {
      userId: user,
      firstName: 'A',
      lastName: 'B',
      phone: PHONE,
    });
    await repos.patients.upsertProfile(patient(user), {
      userId: user,
      firstName: 'Anna',
      lastName: 'B',
      phone: PHONE,
    });
    await repos.patients.getPii(patient(user), user); // the patient reading their own data: no row
    await repos.patients.getPii(clinician(doctor), user);
    await repos.patients.getPii(system, user);

    const rows = await auditFor(user);
    expect(rows.map((row) => [row.action, row.actor_kind, row.changes])).toEqual([
      ['CREATE', 'PATIENT', ['first_name', 'last_name', 'phone']],
      ['UPDATE', 'PATIENT', []],
      ['UPDATE', 'PATIENT', ['first_name']],
      ['READ_PII', 'CLINICIAN', []],
      ['READ_PII', 'SYSTEM', []],
    ]);
  });

  it('never writes the data itself into the audit log, only keyed hashes', async () => {
    const user = await insertUser(sql());
    await repos.patients.upsertProfile(patient(user), {
      userId: user,
      firstName: 'Zarina',
      lastName: 'Usmanova',
      phone: '+998911112233',
      dateOfBirth: '1990-01-02',
    });

    const rows = await sql()<
      { blob: string; before_hash: string | null; after_hash: string | null }[]
    >`
      select audit_log::text as blob, before_hash, after_hash from audit_log where entity_id = ${user}`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.blob).not.toContain('998911112233');
      expect(row.blob).not.toContain('1990-01-02');
      expect(row.blob).not.toContain('Zarina');
    }
    expect(rows[0]?.after_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.before_hash).toBeNull();
  });

  it('leaves neither a row nor an audit entry when the surrounding transaction fails', async () => {
    const user = await insertUser(sql());
    await sql()`insert into patient_profiles (user_id, first_name, last_name) values (${user}, 'Old', 'Name')`;
    const deps = createRepositoryDeps(keys);

    await expect(
      testDatabase.db.orm.transaction(async (tx) => {
        const inTx = createRepositories(tx, deps);
        await inTx.patients.upsertProfile(patient(user), {
          userId: user,
          firstName: 'New',
          lastName: 'Name',
          phone: PHONE,
        });
        throw new Error('something later in the use case failed');
      }),
    ).rejects.toThrow('something later');

    const [row] = await sql()<{ first_name: string; phone_enc: string | null }[]>`
      select first_name, phone_enc from patient_profiles where user_id = ${user}`;
    expect(row).toEqual({ first_name: 'Old', phone_enc: null });
    expect(await auditFor(user)).toEqual([]);
  });
});

describe('opening a course', () => {
  async function counts(): Promise<{ courses: number; revisions: number; audits: number }> {
    const [row] = await sql()<{ courses: number; revisions: number; audits: number }[]>`
      select (select count(*) from treatment_courses)::int as courses,
             (select count(*) from course_revisions)::int as revisions,
             (select count(*) from audit_log where entity_type = 'treatment_courses')::int as audits`;
    return row ?? { courses: 0, revisions: 0, audits: 0 };
  }

  const input = (patientId: string) => ({ patientId, durationDays: 7, timezone: 'Asia/Tashkent' });

  it('creates the course, first revision, policy, history row and audit entry together', async () => {
    const course = await repos.courses.createDraft(
      clinician(world.doctorA1),
      input(world.patient1),
    );

    expect(course).toMatchObject({
      status: 'DRAFT',
      patientId: world.patient1,
      clinicianId: world.doctorA1,
      clinicId: world.clinicA,
    });
    const [revision] = await sql()<{ rev_no: number; status: string; created_by: string }[]>`
      select rev_no, status, created_by from course_revisions where id = ${course.currentRevisionId}`;
    expect(revision).toEqual({ rev_no: 1, status: 'DRAFT', created_by: world.doctorA1 });

    const [policy] = await sql()<
      { attempts: number }[]
    >`select attempts from reminder_policies where course_id = ${course.id}`;
    expect(policy?.attempts).toBe(3);
    const history =
      await sql()`select from_status, to_status, actor_kind from course_transitions where course_id = ${course.id}`;
    expect(history).toEqual([{ from_status: null, to_status: 'DRAFT', actor_kind: 'CLINICIAN' }]);
    const audit =
      await sql()`select action, actor_user_id from audit_log where entity_id = ${course.id}`;
    expect(audit).toEqual([{ action: 'CREATE', actor_user_id: world.doctorA1 }]);

    // A draft is the doctor's working paper: the patient does not see it until it is sent.
    expect(await repos.courses.get(patient(world.patient1), course.id)).toBeNull();
    expect(await repos.courses.get(clinician(world.doctorA1), course.id)).not.toBeNull();
  });

  it.each([
    [
      'a colleague without a link to the patient',
      (w: World) => clinician(w.doctorA2),
      (w: World) => w.patient1,
    ],
    ['a doctor of another clinic', (w: World) => clinician(w.doctorB1), (w: World) => w.patient1],
    [
      'a doctor whose link ended',
      (w: World) => clinician(w.doctorA1),
      (w: World) => w.patient3EndedWithA1,
    ],
    [
      'a doctor whose link is still pending',
      (w: World) => clinician(w.doctorA1),
      (w: World) => w.patient4PendingWithA1,
    ],
    [
      'a doctor with a stranger',
      (w: World) => clinician(w.doctorA1),
      (w: World) => w.strangerPatient,
    ],
  ])('refuses %s', async (_label, actor, target) => {
    const before = await counts();
    await expect(
      repos.courses.createDraft(actor(world), input(target(world))),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await counts()).toEqual(before);
  });

  it.each([
    ['a patient', (w: World) => patient(w.patient1)],
    ['a caregiver', (w: World) => caregiver(w.caregiverSchedule)],
    ['reception', (w: World) => staff(w.receptionA, w.clinicA)],
    ['a tech admin', (w: World) => techAdmin(w.techAdmin)],
    ['the system', () => system],
  ])('refuses %s: only a clinician opens courses', async (_label, actor) => {
    await expect(
      repos.courses.createDraft(actor(world), input(world.patient1)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is all or nothing: a bad value leaves no half-built course behind', async () => {
    const before = await counts();
    await expect(
      repos.courses.createDraft(clinician(world.doctorA1), {
        ...input(world.patient1),
        durationDays: 0,
      }),
    ).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });
});

describe('access ends the moment its basis does', () => {
  /** A private clinic, doctor, patient, link, course, dose: free to damage without hurting other tests. */
  async function miniWorld() {
    const clinicId = await insertClinic(sql());
    const doctorId = await insertClinician(sql(), clinicId);
    const receptionId = await insertClinicStaff(sql(), clinicId);
    const patientId = await insertPatient(sql());
    const caregiverId = await insertCaregiver(sql(), patientId, { addedBy: doctorId });
    const relationshipId = await insertRelationship(sql(), patientId, doctorId);
    const course = await insertCourse(sql(), {
      patientId,
      clinicianId: doctorId,
      clinicId,
      relationshipId,
    });
    const medication = await insertMedicationWithRule(sql(), course.revisionId);
    const doseId = await insertDose(sql(), { ...course, medication });
    await confirmRevision(sql(), course.revisionId, doctorId);
    await insertSkippedEvent(
      sql(),
      createRepositoryDeps(keys).cipher,
      { doseId, courseId: course.courseId, patientId },
      'reason',
    );
    return {
      clinicId,
      doctorId,
      receptionId,
      patientId,
      caregiverId,
      relationshipId,
      courseId: course.courseId,
      doseId,
    };
  }

  type Mini = Awaited<ReturnType<typeof miniWorld>>;

  const REVOCATIONS: {
    label: string;
    revoke: (m: Mini) => Promise<unknown>;
    lost: (m: Mini) => Actor;
  }[] = [
    {
      label: 'the care relationship ends: the doctor',
      revoke: (m) =>
        sql()`update care_relationships set status = 'ENDED', ended_at = now() where id = ${m.relationshipId}`,
      lost: (m) => clinician(m.doctorId),
    },
    {
      label: 'the doctor’s verification is revoked: the doctor',
      revoke: (m) =>
        sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${m.doctorId}`,
      lost: (m) => clinician(m.doctorId),
    },
    {
      label: 'the clinic is suspended: the doctor',
      revoke: (m) => sql()`update clinics set status = 'SUSPENDED' where id = ${m.clinicId}`,
      lost: (m) => clinician(m.doctorId),
    },
    {
      label: 'the doctor’s account is blocked: the doctor',
      revoke: (m) => sql()`update users set status = 'BLOCKED' where id = ${m.doctorId}`,
      lost: (m) => clinician(m.doctorId),
    },
    {
      label: 'the patient’s account is blocked: the patient',
      revoke: (m) => sql()`update users set status = 'BLOCKED' where id = ${m.patientId}`,
      lost: (m) => patient(m.patientId),
    },
    {
      label: 'the caregiver is revoked: the caregiver',
      revoke: (m) =>
        sql()`update caregiver_relationships set status = 'REVOKED' where caregiver_user_id = ${m.caregiverId}`,
      lost: (m) => caregiver(m.caregiverId),
    },
  ];

  it.each(REVOCATIONS)(
    'when $label loses the course, its doses and its events',
    async ({ revoke, lost }) => {
      const m = await miniWorld();
      const actor = lost(m);

      expect(await repos.courses.get(actor, m.courseId), 'before').not.toBeNull();
      expect(await repos.doses.listEvents(actor, m.doseId), 'before').toHaveLength(1);

      await revoke(m);

      expect(await repos.courses.get(actor, m.courseId)).toBeNull();
      expect(await repos.doses.get(actor, m.doseId)).toBeNull();
      expect(await repos.doses.listForCourse(actor, m.courseId)).toEqual([]);
      expect(await repos.doses.listEvents(actor, m.doseId)).toEqual([]);
    },
  );

  it('when the clinic is suspended or the staff member revoked, reception loses the administrative list', async () => {
    const suspended = await miniWorld();
    const revoked = await miniWorld();
    const actorOf = (m: Mini) => staff(m.receptionId, m.clinicId);

    expect(await repos.courses.listForAdministration(actorOf(suspended))).toHaveLength(1);
    await sql()`update clinics set status = 'SUSPENDED' where id = ${suspended.clinicId}`;
    expect(await repos.courses.listForAdministration(actorOf(suspended))).toEqual([]);

    expect(await repos.courses.listForAdministration(actorOf(revoked))).toHaveLength(1);
    await sql()`update clinic_staff set status = 'REVOKED' where user_id = ${revoked.receptionId}`;
    expect(await repos.courses.listForAdministration(actorOf(revoked))).toEqual([]);
  });

  it('leaves the other doctors, patients and clinics untouched', async () => {
    const m = await miniWorld();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${m.doctorId}`;

    expect(
      await repos.courses.get(clinician(world.doctorA1), world.course1.courseId),
    ).not.toBeNull();
    expect(await repos.courses.get(patient(m.patientId), m.courseId)).not.toBeNull();
  });
});

describe('appending to the event log', () => {
  const baseEvent = (suffix: string) => ({
    scheduledDoseId: world.course1.doseId,
    occurredAt: new Date('2026-10-02T03:05:00Z'),
    source: 'TELEGRAM' as const,
    idempotencyKey: `access-test-${suffix}`,
  });

  it('lets the patient answer, and a repeated callback adds nothing', async () => {
    const first = await repos.doses.appendEvent(patient(world.patient1), {
      ...baseEvent('replay'),
      eventType: 'SNOOZED',
    });
    const again = await repos.doses.appendEvent(patient(world.patient1), {
      ...baseEvent('replay'),
      eventType: 'SNOOZED',
    });

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(first.event.id);
    const rows =
      await sql()`select 1 from dose_events where idempotency_key = 'access-test-replay'`;
    expect(rows).toHaveLength(1);
  });

  it('rejects a key reused for a different event', async () => {
    await repos.doses.appendEvent(patient(world.patient1), {
      ...baseEvent('reuse'),
      eventType: 'SNOOZED',
    });
    await expect(
      repos.doses.appendEvent(patient(world.patient1), {
        ...baseEvent('reuse'),
        eventType: 'TAKEN',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('stores a free-text reason encrypted and gives it back only to those allowed to read it', async () => {
    const text = 'went to the pharmacy, they were closed';
    const { event } = await repos.doses.appendEvent(patient(world.patient1), {
      ...baseEvent('reason'),
      eventType: 'SKIPPED',
      reasonCode: 'OTHER',
      reasonText: text,
    });
    expect(event.reasonText).toBe(text);

    const [row] = await sql()<
      { reason_text_enc: string }[]
    >`select reason_text_enc from dose_events where id = ${event.id}`;
    expect(row?.reason_text_enc).not.toContain('pharmacy');

    const events = await repos.doses.listEvents(
      caregiver(world.caregiverSchedule),
      world.course1.doseId,
    );
    expect(JSON.stringify(events)).not.toContain('pharmacy');
    const asDoctor = await repos.doses.listEvents(clinician(world.doctorA1), world.course1.doseId);
    expect(asDoctor.find((e) => e.id === event.id)?.reasonText).toBe(text);
  });

  it('treats another patient’s dose as nonexistent', async () => {
    await expect(
      repos.doses.appendEvent(patient(world.patient2), {
        ...baseEvent('other'),
        eventType: 'TAKEN',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      repos.doses.appendEvent(clinician(world.doctorA2), {
        ...baseEvent('other2'),
        eventType: 'CORRECTION',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['a patient writing a MISSED event', (w: World) => patient(w.patient1), 'MISSED'],
    ['a patient writing a CORRECTION', (w: World) => patient(w.patient1), 'CORRECTION'],
    ['a doctor answering as the patient', (w: World) => clinician(w.doctorA1), 'TAKEN'],
    ['a caregiver answering for the patient', (w: World) => caregiver(w.caregiverReasons), 'TAKEN'],
    ['reception', (w: World) => staff(w.receptionA, w.clinicA), 'TAKEN'],
    ['a tech admin', (w: World) => techAdmin(w.techAdmin), 'TAKEN'],
    ['the system answering as the patient', () => system, 'TAKEN'],
  ] as const)('forbids %s', async (_label, actor, eventType) => {
    await expect(
      repos.doses.appendEvent(actor(world), {
        ...baseEvent(`forbid-${eventType}-${_label}`),
        eventType,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets a doctor correct and the system record what it does itself', async () => {
    await repos.doses.appendEvent(clinician(world.doctorA1), {
      ...baseEvent('correct'),
      eventType: 'CORRECTION',
      details: { from: 'SKIPPED', to: 'TAKEN' },
    });
    await repos.doses.appendEvent(system, {
      ...baseEvent('sys'),
      eventType: 'MISSED',
      source: 'SYSTEM',
    });
  });

  it('refuses a patient event labelled as coming from the system', async () => {
    await expect(
      repos.doses.appendEvent(patient(world.patient1), {
        ...baseEvent('lying'),
        eventType: 'TAKEN',
        source: 'SYSTEM',
      }),
    ).rejects.toThrow();
  });
});

describe('which capacities a user can act in', () => {
  it('derives roles from profiles, so one person can hold several', async () => {
    const user = await insertPatient(sql());
    const clinicId = await insertClinic(sql());
    await sql()`insert into clinician_profiles (user_id, clinic_id, first_name, last_name) values (${user}, ${clinicId}, 'Dual', 'Role')`;
    await sql()`insert into clinic_staff (user_id, clinic_id, role) values (${user}, ${clinicId}, 'CLINIC_ADMIN')`;

    const actors = await resolveActors(testDatabase.db.orm, user);
    expect(actors.map((actor) => actor.kind).sort()).toEqual([
      'CLINICIAN',
      'CLINIC_STAFF',
      'PATIENT',
    ]);
    expect(actors.find((actor) => actor.kind === 'CLINIC_STAFF')).toMatchObject({
      clinicId,
      role: 'CLINIC_ADMIN',
    });
  });

  it('gives a blocked or deleted user none', async () => {
    const blocked = await insertPatient(sql(), { userStatus: 'BLOCKED' });
    const deleted = await insertPatient(sql(), { userStatus: 'DELETED' });
    expect(await resolveActors(testDatabase.db.orm, blocked)).toEqual([]);
    expect(await resolveActors(testDatabase.db.orm, deleted)).toEqual([]);
  });

  it('counts an unverified clinician as a clinician who can see nothing', async () => {
    const clinicId = await insertClinic(sql());
    const pending = await insertClinician(sql(), clinicId, { verification: 'PENDING' });
    const patientId = await insertPatient(sql());
    const relationshipId = await insertRelationship(sql(), patientId, pending);
    await insertCourse(sql(), { patientId, clinicianId: pending, clinicId, relationshipId });

    const actors = await resolveActors(testDatabase.db.orm, pending);
    expect(actors.map((actor) => actor.kind)).toEqual(['CLINICIAN']);
    expect(await repos.courses.list(clinician(pending))).toEqual([]);
  });

  it('ignores revoked staff and caregivers that are not active yet', async () => {
    const clinicId = await insertClinic(sql());
    const revokedStaff = await insertClinicStaff(sql(), clinicId, { status: 'REVOKED' });
    expect(await resolveActors(testDatabase.db.orm, revokedStaff)).toEqual([]);
    expect(await resolveActors(testDatabase.db.orm, world.caregiverPending)).toEqual([]);
    expect(
      (await resolveActors(testDatabase.db.orm, world.caregiverSchedule)).map((a) => a.kind),
    ).toEqual(['CAREGIVER']);
    expect((await resolveActors(testDatabase.db.orm, world.techAdmin)).map((a) => a.kind)).toEqual([
      'TECH_ADMIN',
    ]);
  });

  it('returns nothing for an unknown user', async () => {
    expect(
      await resolveActors(testDatabase.db.orm, '00000000-0000-4000-8000-000000000000'),
    ).toEqual([]);
  });
});
