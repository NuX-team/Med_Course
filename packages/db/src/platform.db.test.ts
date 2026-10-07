import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { insertCaregiver, insertPatient, insertTechAdmin } from '../test/fixtures';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

/**
 * Who may make and unmake administrators (stage 16, ARCHITECTURE D-128): the system from the
 * command line, and an administrator who is still one from the bot. Nobody else; nobody who has
 * lost the rights meanwhile; and never leaving the service with nobody to run it.
 */

let testDatabase: TestDatabase;
let repos: Repositories;
const sql = () => testDatabase.db.sql;
const system = systemActor('platform test');
const admin = (userId: string): Actor => ({ kind: 'TECH_ADMIN', userId });
const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });

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

// Every test counts administrators, so each starts with none.
beforeEach(async () => {
  await sql()`update platform_staff set status = 'REVOKED'`;
});

const activeCount = async (): Promise<number> =>
  (
    await sql()<{ n: number }[]>`
      select count(*)::int as n from platform_staff where status = 'ACTIVE'`
  )[0]?.n ?? -1;

describe('isTechAdmin', () => {
  it('is true for an active administrator only, and false at once when they are revoked or blocked', async () => {
    const id = await insertTechAdmin(sql());
    const person = await insertPatient(sql());
    expect(await repos.platform.isTechAdmin(id)).toBe(true);
    expect(await repos.platform.isTechAdmin(person)).toBe(false);
    expect(await repos.platform.isTechAdmin('00000000-0000-4000-8000-000000000000')).toBe(false);

    await sql()`update users set status = 'BLOCKED' where id = ${id}`;
    expect(await repos.platform.isTechAdmin(id)).toBe(false);
    await sql()`update users set status = 'ACTIVE' where id = ${id}`;
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${id}`;
    expect(await repos.platform.isTechAdmin(id)).toBe(false);
  });
});

describe('the menu flags', () => {
  const flags = (userId: string) => repos.users.menuFlags(system, userId);

  it('say in one query whether a person watches over somebody and whether they run the service', async () => {
    const nobody = await insertPatient(sql());
    expect(await flags(nobody)).toEqual({ watching: false, admin: false });

    const runs = await insertTechAdmin(sql());
    expect(await flags(runs)).toEqual({ watching: false, admin: true });

    const ward = await insertPatient(sql());
    const watcher = await insertCaregiver(sql(), ward, { addedBy: runs });
    expect(await flags(watcher)).toEqual({ watching: true, admin: false });
    expect(await flags(ward)).toEqual({ watching: false, admin: false });
  });

  it('stop saying "watching" when the relationship, the patient or the person is no longer active', async () => {
    const by = await insertTechAdmin(sql());
    const ward = await insertPatient(sql());
    const pending = await insertCaregiver(sql(), ward, { addedBy: by, status: 'PENDING' });
    const revoked = await insertCaregiver(sql(), ward, { addedBy: by, status: 'REVOKED' });
    const watcher = await insertCaregiver(sql(), ward, { addedBy: by });
    expect((await flags(pending)).watching).toBe(false);
    expect((await flags(revoked)).watching).toBe(false);
    expect((await flags(watcher)).watching).toBe(true);

    await sql()`update users set status = 'BLOCKED' where id = ${ward}`;
    expect((await flags(watcher)).watching).toBe(false);
    await sql()`update users set status = 'ACTIVE' where id = ${ward}`;
    await sql()`update users set status = 'BLOCKED' where id = ${watcher}`;
    expect((await flags(watcher)).watching).toBe(false);
  });

  it('stop saying "admin" the moment the rights are taken away', async () => {
    const runs = await insertTechAdmin(sql());
    expect((await flags(runs)).admin).toBe(true);
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${runs}`;
    expect((await flags(runs)).admin).toBe(false);
  });

  it('are read by the system or the person themself, and by nobody else', async () => {
    const person = await insertPatient(sql());
    const other = await insertPatient(sql());
    expect(await repos.users.menuFlags(patient(person), person)).toEqual({
      watching: false,
      admin: false,
    });
    await expect(repos.users.menuFlags(patient(other), person)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('granting', () => {
  it('lets an active administrator make another, and records who did it', async () => {
    const maker = await insertTechAdmin(sql());
    const person = await insertPatient(sql());

    expect(await repos.platform.grantTechAdmin(admin(maker), person)).toBe('GRANTED');

    expect(await repos.platform.isTechAdmin(person)).toBe(true);
    const [row] = await sql()<{ actor_kind: string; actor_user_id: string | null }[]>`
      select actor_kind, actor_user_id from audit_log
      where entity_type = 'platform_staff' and entity_id = ${person} and action = 'CREATE'`;
    expect(row).toMatchObject({ actor_kind: 'TECH_ADMIN', actor_user_id: maker });
  });

  it('restores a revoked administrator, and leaves one who is already active alone', async () => {
    const maker = await insertTechAdmin(sql());
    const person = await insertPatient(sql());
    await repos.platform.grantTechAdmin(admin(maker), person);
    await repos.platform.revokeTechAdmin(admin(maker), person);
    expect(await repos.platform.isTechAdmin(person)).toBe(false);

    expect(await repos.platform.grantTechAdmin(admin(maker), person)).toBe('GRANTED');
    expect(await repos.platform.isTechAdmin(person)).toBe(true);
    const [before] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log where entity_id = ${person}`;
    expect(await repos.platform.grantTechAdmin(admin(maker), person)).toBe('ALREADY');
    const [after] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log where entity_id = ${person}`;
    expect(after?.n).toBe(before?.n);
  });

  it('refuses a patient, a doctor-less stranger, and an administrator who has lost the rights', async () => {
    const person = await insertPatient(sql());
    const target = await insertPatient(sql());
    await expect(repos.platform.grantTechAdmin(patient(person), target)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const former = await insertTechAdmin(sql());
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${former}`;
    await expect(repos.platform.grantTechAdmin(admin(former), target)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const blocked = await insertTechAdmin(sql());
    await sql()`update users set status = 'BLOCKED' where id = ${blocked}`;
    await expect(repos.platform.grantTechAdmin(admin(blocked), target)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await repos.platform.isTechAdmin(target)).toBe(false);
  });

  it('says false for an account that does not exist or is not active', async () => {
    const maker = await insertTechAdmin(sql());
    const blocked = await insertPatient(sql(), { userStatus: 'BLOCKED' });
    expect(
      await repos.platform.grantTechAdmin(admin(maker), '00000000-0000-4000-8000-000000000000'),
    ).toBe('NO_ACCOUNT');
    expect(await repos.platform.grantTechAdmin(admin(maker), blocked)).toBe('NO_ACCOUNT');
  });
});

describe('the list', () => {
  it('shows active administrators with their names and language, oldest first, to an administrator only', async () => {
    const first = await insertTechAdmin(sql());
    const second = await insertPatient(sql(), { firstName: 'Aziza', lastName: 'Karimova' });
    await repos.platform.grantTechAdmin(admin(first), second);
    const gone = await insertPatient(sql());
    await repos.platform.grantTechAdmin(admin(first), gone);
    await repos.platform.revokeTechAdmin(admin(first), gone);

    const list = await repos.platform.listTechAdmins(admin(first));

    expect(list.map((row) => row.userId)).toEqual([first, second]);

    // The order is the order in which they were made, whatever their ids happen to be.
    const made: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = await insertTechAdmin(sql());
      await sql()`
        update platform_staff set created_at = ${new Date(Date.UTC(2020, index, 1))}
        where user_id = ${id}`;
      made.push(id);
    }
    await sql()`update platform_staff set created_at = ${new Date(Date.UTC(2019, 0, 1))} where user_id = ${first}`;
    await sql()`update platform_staff set created_at = ${new Date(Date.UTC(2019, 0, 2))} where user_id = ${second}`;
    expect((await repos.platform.listTechAdmins(admin(first))).map((row) => row.userId)).toEqual([
      first,
      second,
      ...made,
    ]);
    expect(list[1]).toMatchObject({ firstName: 'Aziza', lastName: 'Karimova', locale: 'ru' });
    expect(list[0]?.firstName).toBeNull();
    expect(typeof list[0]?.telegramUserId).toBe('number');
    await expect(repos.platform.listTechAdmins(patient(second))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(repos.platform.listTechAdmins(system)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('revoking', () => {
  it('takes the rights away, records it, and says what happened', async () => {
    const maker = await insertTechAdmin(sql());
    const other = await insertTechAdmin(sql());

    expect(await repos.platform.revokeTechAdmin(admin(maker), other)).toBe('REVOKED');

    expect(await repos.platform.isTechAdmin(other)).toBe(false);
    expect(await repos.platform.isTechAdmin(maker)).toBe(true);
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_type = 'platform_staff' and entity_id = ${other} and action = 'REVOKE'`;
    expect(row?.n).toBe(1);
    expect(await repos.platform.revokeTechAdmin(admin(maker), other)).toBe('NOT_ADMIN');
    expect(await repos.platform.revokeTechAdmin(admin(maker), await insertPatient(sql()))).toBe(
      'NOT_ADMIN',
    );
  });

  it('never takes one’s own rights away: somebody else does that', async () => {
    const maker = await insertTechAdmin(sql());
    await insertTechAdmin(sql());

    expect(await repos.platform.revokeTechAdmin(admin(maker), maker)).toBe('SELF');

    expect(await repos.platform.isTechAdmin(maker)).toBe(true);
    expect(await activeCount()).toBe(2);
  });

  it('refuses a patient, the system, and an administrator who has lost the rights', async () => {
    const maker = await insertTechAdmin(sql());
    const other = await insertTechAdmin(sql());
    const person = await insertPatient(sql());
    await expect(repos.platform.revokeTechAdmin(patient(person), other)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(repos.platform.revokeTechAdmin(system, other)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${maker}`;
    await expect(repos.platform.revokeTechAdmin(admin(maker), other)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await repos.platform.isTechAdmin(other)).toBe(true);
  });

  it('leaves somebody to run the service when two administrators remove each other at once', async () => {
    const a = await insertTechAdmin(sql());
    const b = await insertTechAdmin(sql());

    const results = await Promise.allSettled([
      repos.platform.revokeTechAdmin(admin(a), b),
      repos.platform.revokeTechAdmin(admin(b), a),
    ]);

    // One wins. The other is told it is too late: either it was already revoked when it asked
    // (refused), or it asked at the same moment and found itself the last one.
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === 'REVOKED')).toHaveLength(
      1,
    );
    const late = results.filter((r) => !(r.status === 'fulfilled' && r.value === 'REVOKED'));
    expect(late).toHaveLength(1);
    const [other] = late;
    expect(
      other?.status === 'rejected'
        ? other.reason instanceof ForbiddenError
        : other?.value === 'LAST' || other?.value === 'NOT_ADMIN',
    ).toBe(true);
    expect(await activeCount()).toBe(1);
  });

  it('holds the second of two removals until the first is done, however they arrive', async () => {
    const a = await insertTechAdmin(sql());
    const b = await insertTechAdmin(sql());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Somebody else holds every active administrator, so both removals start and wait.
    const holder = sql().begin(async (tx) => {
      await tx`select user_id from platform_staff where status = 'ACTIVE' for update`;
      locked();
      await gate;
    });
    await holding;

    const first = repos.platform.revokeTechAdmin(admin(a), b);
    const second = repos.platform.revokeTechAdmin(admin(b), a);
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await holder;
    const results = await Promise.allSettled([first, second]);

    expect(await activeCount()).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === 'REVOKED')).toHaveLength(
      1,
    );
  });
});
