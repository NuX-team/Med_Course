import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician, insertPatient, insertRelationship } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  ATTEMPT_WINDOW_MS,
  INVITATION_TTL_MS,
  MAX_FAILED_ATTEMPTS,
  MAX_OPEN_INVITATIONS,
  createRepositories,
  createRepositoryDeps,
  hashInviteCode,
  looksLikeInviteCode,
  type Repositories,
} from './repositories';

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('invitation test');
const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
const clinician = (userId: string): Actor => ({ kind: 'CLINICIAN', userId });
const NOW = new Date('2026-10-02T10:00:00Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000;

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

let telegramId = 4_000_000;
const nextTelegramId = (): number => (telegramId += 1);

interface Person {
  readonly userId: string;
  readonly telegramId: number;
}

async function newPatient(lastName = 'Patient'): Promise<Person> {
  const id = nextTelegramId();
  return { userId: await insertPatient(sql(), { telegramId: id, lastName }), telegramId: id };
}

async function newDoctor(lastName = 'Doctor'): Promise<Person> {
  const id = nextTelegramId();
  const clinicId = await insertClinic(sql());
  const userId = await insertClinician(sql(), clinicId, { telegramId: id, firstName: lastName });
  return { userId, telegramId: id };
}

async function invite(doctor: Person, label?: string, now = NOW): Promise<string> {
  const created = await repos.invitations.create(clinician(doctor.userId), {
    ...(label === undefined ? {} : { label }),
    now,
  });
  if (created.status !== 'CREATED') {
    throw new Error(`expected an invitation, got ${created.status}`);
  }
  return created.code;
}

const redeem = (who: Person, code: string, now = NOW) =>
  repos.invitations.redeem(patient(who.userId), {
    telegramUserId: who.telegramId,
    codeHash: hashInviteCode(code),
    now,
  });

const inspect = (who: Person | null, code: string, asTelegramId: number, now = NOW) =>
  repos.invitations.inspect(system, {
    telegramUserId: asTelegramId,
    codeHash: hashInviteCode(code),
    patientUserId: who?.userId ?? null,
    now,
  });

async function violation(statement: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return error.constraint_name ?? error.code;
    }
    throw error;
  }
  return undefined;
}

async function failuresOf(id: number): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    select count(*)::int as n from invitation_attempts where telegram_user_id = ${id}`;
  return row?.n ?? 0;
}

async function relationshipsBetween(doctor: Person, person: Person) {
  return sql()<{ id: string; status: string; consent_at: Date | null }[]>`
    select id, status, consent_at from care_relationships
    where clinician_id = ${doctor.userId} and patient_id = ${person.userId} order by created_at`;
}

describe('creating an invitation', () => {
  it('hands the doctor a 22-character code and stores only its hash', async () => {
    const doctor = await newDoctor();
    const created = await repos.invitations.create(clinician(doctor.userId), {
      label: '  Mrs Karimova  ',
      now: NOW,
    });
    if (created.status !== 'CREATED') {
      throw new Error('expected CREATED');
    }

    expect(created.code).toHaveLength(22);
    expect(created.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(looksLikeInviteCode(created.code)).toBe(true);
    expect(created.invitation.label).toBe('Mrs Karimova');
    expect(created.invitation.expiresAt).toEqual(later(INVITATION_TTL_MS));

    const [row] = await sql()<{ code_hash: string; everything: string }[]>`
      select code_hash, i::text as everything from invitations i where i.id = ${created.invitation.id}`;
    expect(row?.code_hash).toBe(hashInviteCode(created.code));
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    // Neither the invitation row nor the audit log can be turned into a working link.
    expect(row?.everything).not.toContain(created.code);
    const [audit] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log a where a::text like ${`%${created.code}%`}`;
    expect(audit?.n).toBe(0);
  });

  it('is valid for exactly 72 hours', () => {
    expect(INVITATION_TTL_MS).toBe(72 * HOUR);
  });

  it('gives every invitation a different code', async () => {
    const doctor = await newDoctor();
    const codes = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      codes.add(await invite(doctor));
    }
    expect(codes.size).toBe(10);
  });

  it('is audited without the code', async () => {
    const doctor = await newDoctor();
    await invite(doctor, 'Someone');
    const [row] = await sql()<{ action: string; changes: string[] }[]>`
      select action, changes from audit_log
      where entity_type = 'invitations' and actor_user_id = ${doctor.userId}`;
    expect(row?.action).toBe('CREATE');
    expect(row?.changes).toContain('code_hash');
  });

  it('is only for a doctor in good standing', async () => {
    const pending = await newDoctor();
    await sql()`update clinician_profiles set verification_status = 'PENDING', verified_by = null, verified_at = null where user_id = ${pending.userId}`;
    const revoked = await newDoctor();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${revoked.userId}`;
    const suspended = await newDoctor();
    await sql()`update clinics set status = 'SUSPENDED' where id = (select clinic_id from clinician_profiles where user_id = ${suspended.userId})`;
    const blocked = await newDoctor();
    await sql()`update users set status = 'BLOCKED' where id = ${blocked.userId}`;

    for (const doctor of [pending, revoked, suspended, blocked]) {
      expect(await repos.invitations.create(clinician(doctor.userId), { now: NOW })).toEqual({
        status: 'NOT_ALLOWED',
      });
    }
  });

  it('is only for doctors: every other kind of actor is refused', async () => {
    const person = await newPatient();
    for (const actor of [
      patient(person.userId),
      system,
      { kind: 'TECH_ADMIN', userId: person.userId } as const,
    ]) {
      await expect(repos.invitations.create(actor, { now: NOW })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it('keeps the label to a sensible size', async () => {
    const doctor = await newDoctor();
    for (const bad of ['', '   ', 'x'.repeat(101)]) {
      await expect(
        repos.invitations.create(clinician(doctor.userId), { label: bad, now: NOW }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('stops at the limit of unused invitations, and a withdrawn one frees a place', async () => {
    const doctor = await newDoctor();
    for (let index = 0; index < MAX_OPEN_INVITATIONS; index += 1) {
      await invite(doctor, `n${String(index)}`);
    }
    expect(await repos.invitations.create(clinician(doctor.userId), { now: NOW })).toEqual({
      status: 'LIMIT',
    });

    const [first] = await repos.invitations.listOpen(clinician(doctor.userId), NOW);
    expect(await repos.invitations.revoke(clinician(doctor.userId), first?.id ?? '', NOW)).toBe(
      true,
    );
    expect((await repos.invitations.create(clinician(doctor.userId), { now: NOW })).status).toBe(
      'CREATED',
    );
  });

  it('cannot be pushed past the limit by many requests at once', async () => {
    const doctor = await newDoctor();
    const results = await Promise.all(
      Array.from({ length: MAX_OPEN_INVITATIONS + 8 }, () =>
        repos.invitations.create(clinician(doctor.userId), { now: NOW }),
      ),
    );
    expect(results.filter((result) => result.status === 'CREATED')).toHaveLength(
      MAX_OPEN_INVITATIONS,
    );
    expect(results.filter((result) => result.status === 'LIMIT')).toHaveLength(8);
  });

  it('does not count used, withdrawn or expired invitations against the limit', async () => {
    const doctor = await newDoctor();
    for (let index = 0; index < MAX_OPEN_INVITATIONS; index += 1) {
      await invite(doctor, undefined, new Date('2026-09-01T00:00:00Z'));
    }
    // All of those ran out long ago.
    expect((await repos.invitations.create(clinician(doctor.userId), { now: NOW })).status).toBe(
      'CREATED',
    );
  });
});

describe("a doctor's open invitations", () => {
  it('lists the unused, unexpired ones, newest first, and nobody elses', async () => {
    const doctor = await newDoctor();
    const other = await newDoctor();
    await invite(doctor, 'first', NOW);
    await invite(doctor, 'second', later(HOUR));
    await invite(other, 'not mine', NOW);
    const used = await invite(doctor, 'used', later(2 * HOUR));
    const person = await newPatient();
    await redeem(person, used, later(2 * HOUR));
    await invite(doctor, 'too old', new Date('2026-08-01T00:00:00Z'));

    const open = await repos.invitations.listOpen(clinician(doctor.userId), later(3 * HOUR));
    expect(open.map((entry) => entry.label)).toEqual(['second', 'first']);
    expect(await repos.invitations.listOpen(clinician(other.userId), later(3 * HOUR))).toHaveLength(
      1,
    );
  });

  it('can be withdrawn by its doctor only, once, and then stops working', async () => {
    const doctor = await newDoctor();
    const other = await newDoctor();
    const code = await invite(doctor);
    const [entry] = await repos.invitations.listOpen(clinician(doctor.userId), NOW);

    expect(await repos.invitations.revoke(clinician(other.userId), entry?.id ?? '', NOW)).toBe(
      false,
    );
    expect(await repos.invitations.revoke(clinician(doctor.userId), entry?.id ?? '', NOW)).toBe(
      true,
    );
    expect(await repos.invitations.revoke(clinician(doctor.userId), entry?.id ?? '', NOW)).toBe(
      false,
    );
    expect(await repos.invitations.listOpen(clinician(doctor.userId), NOW)).toEqual([]);

    const person = await newPatient();
    expect((await redeem(person, code)).result).toBe('INVALID');
  });

  it('cannot withdraw one that was already used, or one that does not exist', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const [entry] = await repos.invitations.listOpen(clinician(doctor.userId), NOW);
    await redeem(await newPatient(), code);

    expect(await repos.invitations.revoke(clinician(doctor.userId), entry?.id ?? '', NOW)).toBe(
      false,
    );
    expect(
      await repos.invitations.revoke(
        clinician(doctor.userId),
        '00000000-0000-4000-8000-000000000000',
        NOW,
      ),
    ).toBe(false);
  });

  it('is private to doctors', async () => {
    const person = await newPatient();
    await expect(repos.invitations.listOpen(patient(person.userId), NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      repos.invitations.revoke(patient(person.userId), '00000000-0000-4000-8000-000000000000', NOW),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('looking at a code without using it', () => {
  it('says who is inviting, and leaves the code usable', async () => {
    const doctor = await newDoctor('Rahimov');
    const code = await invite(doctor, 'for Aziza');
    const person = await newPatient();

    const first = await inspect(person, code, person.telegramId);
    expect(first).toMatchObject({
      result: 'OPEN',
      label: 'for Aziza',
      doctor: { userId: doctor.userId, lastName: 'Tor', firstName: 'Rahimov' },
    });
    expect(await inspect(person, code, person.telegramId)).toMatchObject({ result: 'OPEN' });
    expect((await redeem(person, code)).result).toBe('ACCEPTED');
  });

  it('works before the person has an account', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    expect((await inspect(null, code, nextTelegramId())).result).toBe('OPEN');
  });

  it('treats unknown, expired, withdrawn, used and abandoned codes alike, and counts each as a guess', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const watcher = nextTelegramId();

    const expired = await invite(doctor, undefined, new Date('2026-09-01T00:00:00Z'));
    const withdrawn = await invite(doctor);
    const [entry] = await repos.invitations.listOpen(clinician(doctor.userId), NOW);
    await repos.invitations.revoke(clinician(doctor.userId), entry?.id ?? '', NOW);
    const used = await invite(doctor);
    await redeem(await newPatient(), used);
    const gone = await newDoctor();
    const orphaned = await invite(gone);
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${gone.userId}`;

    const cases = ['no-such-code-at-all-xx', expired, withdrawn, used, orphaned];
    for (const code of cases) {
      expect((await inspect(person, code, watcher)).result, code).toBe('INVALID');
    }
    expect(await failuresOf(watcher)).toBe(cases.length);
  });

  it('sends a doctor who opens their own link away without counting it as a guess', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    expect(await inspect(doctor, code, doctor.telegramId)).toEqual({ result: 'SELF' });
    expect(await failuresOf(doctor.telegramId)).toBe(0);
    const outcome = await repos.invitations.redeem(patient(doctor.userId), {
      telegramUserId: doctor.telegramId,
      codeHash: hashInviteCode(code),
      now: NOW,
    });
    expect(outcome).toEqual({ result: 'SELF' });
    expect((await repos.invitations.listOpen(clinician(doctor.userId), NOW)).length).toBe(1);
  });

  it('is for the system only', async () => {
    const person = await newPatient();
    await expect(
      repos.invitations.inspect(patient(person.userId), {
        telegramUserId: person.telegramId,
        codeHash: hashInviteCode('x'),
        patientUserId: person.userId,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('accepting an invitation', () => {
  it('connects the patient to the doctor, unconfirmed, with their agreement stamped', async () => {
    const doctor = await newDoctor('Karimov');
    const person = await newPatient('Aliyeva');
    const code = await invite(doctor, 'Aliyeva A.');

    const outcome = await redeem(person, code);

    if (outcome.result !== 'ACCEPTED') {
      throw new Error(`expected ACCEPTED, got ${outcome.result}`);
    }
    expect(outcome).toMatchObject({
      label: 'Aliyeva A.',
      doctor: { userId: doctor.userId, telegramUserId: doctor.telegramId, locale: 'ru' },
      patient: { lastName: 'Aliyeva' },
    });
    const links = await relationshipsBetween(doctor, person);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: outcome.relationshipId, status: 'PENDING' });
    expect(links[0]?.consent_at).toEqual(NOW);

    const [row] = await sql()<
      { used_at: Date; used_by: string; care_relationship_id: string }[]
    >`select used_at, used_by, care_relationship_id from invitations where code_hash = ${hashInviteCode(code)}`;
    expect(row).toEqual({
      used_at: NOW,
      used_by: person.userId,
      care_relationship_id: outcome.relationshipId,
    });
  });

  it('does not yet let the doctor see the patient in any clinical way', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    await redeem(person, await invite(doctor));

    expect(await repos.patients.getSummary(clinician(doctor.userId), person.userId)).toBeNull();
    expect(await repos.patients.getPii(clinician(doctor.userId), person.userId)).toBeNull();
    // Only the name, so the doctor can say whether this is the person they meant.
    const waiting = await repos.care.listForClinician(clinician(doctor.userId));
    expect(waiting).toHaveLength(1);
    expect(Object.keys(waiting[0] ?? {}).sort()).toEqual([
      'firstName',
      'lastName',
      'relationshipId',
      // Whether the patient lets this doctor see earlier courses: a yes or no, nothing clinical.
      'sharesHistory',
      'since',
      'status',
    ]);
  });

  it('is audited for both the relationship and the invitation', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    await redeem(person, await invite(doctor));
    const rows = await sql()<{ entity_type: string; action: string }[]>`
      select entity_type, action from audit_log
      where actor_user_id = ${person.userId} order by at, id`;
    expect(rows).toEqual([
      { entity_type: 'care_relationships', action: 'CREATE' },
      { entity_type: 'invitations', action: 'USE' },
    ]);
  });

  it('works once: a second person with the same code gets nothing', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const first = await newPatient();
    const second = await newPatient();

    expect((await redeem(first, code)).result).toBe('ACCEPTED');
    expect((await redeem(second, code)).result).toBe('INVALID');
    expect(await relationshipsBetween(doctor, second)).toEqual([]);
  });

  it('lets exactly one of many people win a race for one code', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const racers = await Promise.all(Array.from({ length: 10 }, () => newPatient()));

    const results = await Promise.all(racers.map((racer) => redeem(racer, code)));

    expect(results.filter((result) => result.result === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((result) => result.result === 'INVALID')).toHaveLength(9);
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from care_relationships where clinician_id = ${doctor.userId}`;
    expect(row?.n).toBe(1);
  });

  it('treats a double tap by the same person as the connection they just made', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const code = await invite(doctor);

    expect((await redeem(person, code)).result).toBe('ACCEPTED');
    expect(await redeem(person, code)).toEqual({ result: 'CONNECTED', status: 'PENDING' });
    expect(await failuresOf(person.telegramId)).toBe(0);
    expect(await relationshipsBetween(doctor, person)).toHaveLength(1);
  });

  it('survives the same person accepting twice at the same moment', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const code = await invite(doctor);

    const results = await Promise.all([
      redeem(person, code),
      redeem(person, code),
      redeem(person, code),
    ]);

    expect(results.filter((result) => result.result === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((result) => result.result === 'CONNECTED')).toHaveLength(2);
    expect(await relationshipsBetween(doctor, person)).toHaveLength(1);
  });

  it('does not make a second relationship from a second link of the same doctor', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const [one, two] = [await invite(doctor), await invite(doctor)];

    const results = await Promise.all([redeem(person, one), redeem(person, two)]);

    expect(results.map((result) => result.result).sort()).toEqual(['ACCEPTED', 'CONNECTED']);
    expect(await relationshipsBetween(doctor, person)).toHaveLength(1);
  });

  it('tells a patient who is already connected, and leaves the link unused', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    await insertRelationship(sql(), person.userId, doctor.userId, 'ACTIVE');
    const code = await invite(doctor);

    expect(await redeem(person, code)).toEqual({ result: 'CONNECTED', status: 'ACTIVE' });
    expect(await inspect(person, code, person.telegramId)).toEqual({
      result: 'CONNECTED',
      status: 'ACTIVE',
    });
    expect(await repos.invitations.listOpen(clinician(doctor.userId), NOW)).toHaveLength(1);
  });

  it('allows a fresh connection after an earlier one ended', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    await insertRelationship(sql(), person.userId, doctor.userId, 'ENDED');

    expect((await redeem(person, await invite(doctor))).result).toBe('ACCEPTED');
    expect(await relationshipsBetween(doctor, person)).toHaveLength(2);
  });

  it('stops working the instant it expires, not before', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const expiresAt = later(INVITATION_TTL_MS);

    const early = await newPatient();
    expect(
      (await inspect(early, code, early.telegramId, new Date(expiresAt.getTime() - 1))).result,
    ).toBe('OPEN');
    expect((await redeem(early, code, new Date(expiresAt.getTime() - 1))).result).toBe('ACCEPTED');

    const second = await invite(doctor);
    const late = await newPatient();
    expect((await redeem(late, second, later(INVITATION_TTL_MS))).result).toBe('INVALID');
  });

  it('stops working when the doctor loses standing after sending it', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${doctor.userId}`;
    const person = await newPatient();
    expect((await redeem(person, code)).result).toBe('INVALID');
    expect(await relationshipsBetween(doctor, person)).toEqual([]);
  });

  it('needs a patient with a name and an active account', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const nameless = nextTelegramId();
    const [row] = await sql()<{ id: string }[]>`
      insert into users (telegram_user_id) values (${nameless}) returning id`;
    const blockedPerson = await newPatient();
    await sql()`update users set status = 'BLOCKED' where id = ${blockedPerson.userId}`;

    for (const who of [{ userId: row?.id ?? '', telegramId: nameless }, blockedPerson]) {
      expect((await redeem(who, code)).result).toBe('INVALID');
    }
    expect((await repos.invitations.listOpen(clinician(doctor.userId), NOW)).length).toBe(1);
  });

  it('is only for patients', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    for (const actor of [system, clinician(doctor.userId)]) {
      await expect(
        repos.invitations.redeem(actor, {
          telegramUserId: 1,
          codeHash: hashInviteCode(code),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe('guessing codes', () => {
  it('locks a Telegram user out after five wrong tries, even for the right code', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const person = await newPatient();

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect((await redeem(person, `wrong-code-number-${String(attempt)}`)).result).toBe('INVALID');
    }
    expect(await redeem(person, code)).toEqual({ result: 'THROTTLED' });
    expect(await inspect(person, code, person.telegramId)).toEqual({ result: 'THROTTLED' });
    expect(await repos.invitations.throttled(system, person.telegramId, NOW)).toBe(true);
    expect(await relationshipsBetween(doctor, person)).toEqual([]);
  });

  it('lets four wrong tries be followed by the right code', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const person = await newPatient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await redeem(person, `wrong-${String(attempt)}`);
    }
    expect((await redeem(person, code)).result).toBe('ACCEPTED');
  });

  it('counts per Telegram user, so one person cannot lock out another', async () => {
    const doctor = await newDoctor();
    const code = await invite(doctor);
    const guesser = await newPatient();
    const honest = await newPatient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await redeem(guesser, `wrong-${String(attempt)}`);
    }
    expect((await redeem(honest, code)).result).toBe('ACCEPTED');
  });

  it('forgives after the window has passed, one try at a time', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await redeem(person, `wrong-${String(attempt)}`, later(attempt * 60_000));
    }
    const code = await invite(doctor);

    expect(await repos.invitations.throttled(system, person.telegramId, later(30 * 60_000))).toBe(
      true,
    );
    expect((await redeem(person, code, later(30 * 60_000))).result).toBe('THROTTLED');
    // One hour after the first wrong try only that one has aged out.
    expect((await redeem(person, code, later(ATTEMPT_WINDOW_MS + 1))).result).toBe('ACCEPTED');
  });

  it('does not extend the lockout by answering during it', async () => {
    const person = await newPatient();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await redeem(person, `wrong-${String(attempt)}`);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await redeem(person, 'still-wrong');
    }
    expect(await failuresOf(person.telegramId)).toBe(MAX_FAILED_ATTEMPTS);
  });

  it('counts a link of the wrong shape as a guess too', async () => {
    const id = nextTelegramId();
    await repos.invitations.noteFailure(system, id, NOW);
    expect(await failuresOf(id)).toBe(1);
    expect(looksLikeInviteCode('short')).toBe(false);
    expect(looksLikeInviteCode(`${'a'.repeat(21)}!`)).toBe(false);
    expect(looksLikeInviteCode('a'.repeat(23))).toBe(false);
    await expect(
      repos.invitations.noteFailure(patient('00000000-0000-4000-8000-000000000000'), id, NOW),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.invitations.throttled(patient('00000000-0000-4000-8000-000000000000'), id, NOW),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('what the database itself refuses', () => {
  it('rejects a code hash that is not a SHA-256 hex string', async () => {
    const doctor = await newDoctor();
    for (const bad of ['', 'abc', 'G'.repeat(64), 'A'.repeat(64)]) {
      expect(
        await violation(sql()`
          insert into invitations (clinician_id, code_hash, expires_at)
          values (${doctor.userId}, ${bad}, now() + interval '1 day')`),
      ).toBe('invitations_code_hash_chk');
    }
  });

  it('rejects a duplicate code hash and an expiry before creation', async () => {
    const doctor = await newDoctor();
    const hash = hashInviteCode('database-duplicate');
    await sql()`insert into invitations (clinician_id, code_hash, expires_at) values (${doctor.userId}, ${hash}, now() + interval '1 day')`;
    expect(
      await violation(
        sql()`insert into invitations (clinician_id, code_hash, expires_at) values (${doctor.userId}, ${hash}, now() + interval '1 day')`,
      ),
    ).toBe('invitations_code_hash_key');
    expect(
      await violation(
        sql()`insert into invitations (clinician_id, code_hash, expires_at) values (${doctor.userId}, ${hashInviteCode('b')}, now() - interval '1 day')`,
      ),
    ).toBe('invitations_expiry_chk');
  });

  it('rejects a half-used invitation, and one both used and withdrawn', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const relationship = await insertRelationship(sql(), person.userId, doctor.userId, 'PENDING');
    expect(
      await violation(sql()`
        insert into invitations (clinician_id, code_hash, expires_at, used_at)
        values (${doctor.userId}, ${hashInviteCode('half')}, now() + interval '1 day', now())`),
    ).toBe('invitations_used_chk');
    expect(
      await violation(sql()`
        insert into invitations (clinician_id, code_hash, expires_at, used_at, used_by, care_relationship_id, revoked_at)
        values (${doctor.userId}, ${hashInviteCode('both')}, now() + interval '1 day', now(), ${person.userId}, ${relationship}, now())`),
    ).toBe('invitations_final_chk');
  });

  it('rejects an invitation that claims a relationship between other people', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const stranger = await newPatient();
    const otherDoctor = await newDoctor();
    const relationship = await insertRelationship(sql(), person.userId, doctor.userId, 'PENDING');

    // Right relationship, wrong patient.
    expect(
      await violation(sql()`
        insert into invitations (clinician_id, code_hash, expires_at, used_at, used_by, care_relationship_id)
        values (${doctor.userId}, ${hashInviteCode('wrong-patient')}, now() + interval '1 day', now(), ${stranger.userId}, ${relationship})`),
    ).toBe('invitations_relationship_fk');
    // Right relationship, wrong doctor.
    expect(
      await violation(sql()`
        insert into invitations (clinician_id, code_hash, expires_at, used_at, used_by, care_relationship_id)
        values (${otherDoctor.userId}, ${hashInviteCode('wrong-doctor')}, now() + interval '1 day', now(), ${person.userId}, ${relationship})`),
    ).toBe('invitations_relationship_fk');
  });

  it('rejects an attempt record for an impossible Telegram id', async () => {
    expect(
      await violation(sql()`insert into invitation_attempts (telegram_user_id) values (0)`),
    ).toBe('invitation_attempts_telegram_user_id_chk');
  });
});

describe("the doctor's answer", () => {
  async function waiting(): Promise<{
    doctor: Person;
    person: Person;
    relationshipId: string;
  }> {
    const doctor = await newDoctor();
    const person = await newPatient();
    const outcome = await redeem(person, await invite(doctor));
    if (outcome.result !== 'ACCEPTED') {
      throw new Error('setup failed');
    }
    return { doctor, person, relationshipId: outcome.relationshipId };
  }

  const decide = (doctor: Person, relationshipId: string, accept: boolean, now = NOW) =>
    repos.care.decide(clinician(doctor.userId), { relationshipId, accept, now });

  it('confirming makes the patient visible to the doctor and tells how to reach them', async () => {
    const { doctor, person, relationshipId } = await waiting();

    const result = await decide(doctor, relationshipId, true);

    expect(result).toMatchObject({
      status: 'ACTIVE',
      changed: true,
      patient: { userId: person.userId, telegramUserId: person.telegramId, locale: 'ru' },
    });
    expect(await repos.patients.getSummary(clinician(doctor.userId), person.userId)).not.toBeNull();
    const [row] = await sql()<{ status: string; ended_at: Date | null; consent_at: Date }[]>`
      select status, ended_at, consent_at from care_relationships where id = ${relationshipId}`;
    expect(row).toEqual({ status: 'ACTIVE', ended_at: null, consent_at: NOW });
  });

  it('declining ends it, keeps the doctor out, and allows a new invitation later', async () => {
    const { doctor, person, relationshipId } = await waiting();

    const result = await decide(doctor, relationshipId, false, later(HOUR));

    expect(result).toMatchObject({ status: 'ENDED', changed: true });
    expect(await repos.patients.getSummary(clinician(doctor.userId), person.userId)).toBeNull();
    const [row] = await sql()<{ ended_at: Date }[]>`
      select ended_at from care_relationships where id = ${relationshipId}`;
    expect(row?.ended_at).toEqual(later(HOUR));
    expect((await redeem(person, await invite(doctor), later(2 * HOUR))).result).toBe('ACCEPTED');
  });

  it('is final: pressing again, or the opposite button, changes nothing', async () => {
    const { doctor, relationshipId } = await waiting();
    await decide(doctor, relationshipId, true);

    expect(await decide(doctor, relationshipId, true)).toMatchObject({
      status: 'ACTIVE',
      changed: false,
    });
    expect(await decide(doctor, relationshipId, false)).toMatchObject({
      status: 'ACTIVE',
      changed: false,
    });

    const second = await waiting();
    await decide(second.doctor, second.relationshipId, false);
    expect(await decide(second.doctor, second.relationshipId, true)).toMatchObject({
      status: 'ENDED',
      changed: false,
    });
  });

  it('is written to the audit log once, not once per press', async () => {
    const { doctor, relationshipId } = await waiting();
    await Promise.all([
      decide(doctor, relationshipId, true),
      decide(doctor, relationshipId, true),
      decide(doctor, relationshipId, true),
    ]);
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_id = ${relationshipId} and action = 'CONFIRM'`;
    expect(row?.n).toBe(1);
  });

  it('belongs to that doctor alone', async () => {
    const { relationshipId, person } = await waiting();
    const intruder = await newDoctor();

    expect(await decide(intruder, relationshipId, true)).toBeNull();
    expect(await repos.patients.getSummary(clinician(intruder.userId), person.userId)).toBeNull();
    const [row] = await sql()<{ status: string }[]>`
      select status from care_relationships where id = ${relationshipId}`;
    expect(row?.status).toBe('PENDING');
  });

  it('is refused to a doctor who has lost standing, and to anyone not a doctor', async () => {
    const { doctor, person, relationshipId } = await waiting();
    await expect(
      repos.care.decide(patient(person.userId), { relationshipId, accept: true, now: NOW }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.care.decide(system, { relationshipId, accept: true, now: NOW }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${doctor.userId}`;
    expect(await decide(doctor, relationshipId, true)).toBeNull();
    expect(await decide(doctor, '00000000-0000-4000-8000-000000000000', true)).toBeNull();
  });

  it('lists the doctor their own people, those waiting first, names only', async () => {
    const doctor = await newDoctor();
    const confirmed = await newPatient('Aaa');
    const pending = await newPatient('Zzz');
    const ended = await newPatient('Mmm');
    await insertRelationship(sql(), confirmed.userId, doctor.userId, 'ACTIVE');
    await insertRelationship(sql(), pending.userId, doctor.userId, 'PENDING');
    await insertRelationship(sql(), ended.userId, doctor.userId, 'ENDED');
    const other = await newDoctor();
    await insertRelationship(sql(), (await newPatient('Other')).userId, other.userId, 'ACTIVE');

    const list = await repos.care.listForClinician(clinician(doctor.userId));

    expect(list.map((entry) => `${entry.lastName}:${entry.status}`)).toEqual([
      'Zzz:PENDING',
      'Aaa:ACTIVE',
    ]);
    await expect(repos.care.listForClinician(patient(confirmed.userId))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("lists the patient's own doctors, and only the ones still in good standing", async () => {
    const person = await newPatient();
    const good = await newDoctor('Good');
    const waitingDoctor = await newDoctor('Waiting');
    const lapsed = await newDoctor('Lapsed');
    const gone = await newDoctor('Gone');
    await insertRelationship(sql(), person.userId, good.userId, 'ACTIVE');
    await insertRelationship(sql(), person.userId, waitingDoctor.userId, 'PENDING');
    await insertRelationship(sql(), person.userId, lapsed.userId, 'ACTIVE');
    await insertRelationship(sql(), person.userId, gone.userId, 'ENDED');
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${lapsed.userId}`;
    await insertRelationship(sql(), (await newPatient()).userId, good.userId, 'ACTIVE');

    const list = await repos.care.listForPatient(patient(person.userId));

    expect(list.map((entry) => `${entry.firstName}:${entry.status}`)).toEqual([
      'Good:ACTIVE',
      'Waiting:PENDING',
    ]);
    await expect(repos.care.listForPatient(clinician(good.userId))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('clean-up', () => {
  it('forgets old failed attempts and dead unused invitations, and keeps everything else', async () => {
    const doctor = await newDoctor();
    const person = await newPatient();
    const oldId = nextTelegramId();
    await sql()`insert into invitation_attempts (telegram_user_id, at) values (${oldId}, '2026-07-01T00:00:00Z')`;
    await repos.invitations.noteFailure(system, oldId, NOW);

    await invite(doctor, 'dead', new Date('2026-07-01T00:00:00Z'));
    const used = await invite(doctor, 'used', new Date('2026-07-01T00:00:00Z'));
    await redeem(person, used, new Date('2026-07-01T01:00:00Z'));
    const live = await invite(doctor, 'live', NOW);

    const pruned = await repos.invitations.prune(system, {
      attemptsBefore: new Date('2026-07-15T00:00:00Z'),
      invitationsBefore: new Date('2026-07-15T00:00:00Z'),
    });

    expect(pruned).toEqual({ attempts: 1, invitations: 1 });
    expect(await failuresOf(oldId)).toBe(1);
    const [counts] = await sql()<{ n: number }[]>`
      select count(*)::int as n from invitations where code_hash in (${hashInviteCode(used)}, ${hashInviteCode(live)})`;
    expect(counts?.n).toBe(2);
    await expect(
      repos.invitations.prune(patient(person.userId), {
        attemptsBefore: NOW,
        invitationsBefore: NOW,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
