import { randomBytes } from 'node:crypto';
import { createRepositories, createRepositoryDeps, type Repositories } from '@medcourse/db';
import { createTestDatabase, insertPatient, type TestDatabase } from '@medcourse/db/testing';
import { t } from '@medcourse/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTelegram } from '../telegram/test-harness';
import { USAGE, runAdminCommand } from './commands';

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;

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

let telegramId = 6_000_000;
const nextTelegramId = (): number => (telegramId += 1);

interface Run {
  readonly code: number;
  readonly output: string;
  readonly telegram: FakeTelegram;
}

async function run(argv: string[], options: { api?: FakeTelegram | null } = {}): Promise<Run> {
  const lines: string[] = [];
  const telegram = options.api ?? new FakeTelegram();
  const code = await runAdminCommand(argv, {
    repos,
    api: options.api === null ? null : telegram,
    out: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n'), telegram };
}

/** An administrator who is a real account, as the owner will be. */
async function administrator(): Promise<number> {
  const id = nextTelegramId();
  const userId = await insertPatient(sql(), { telegramId: id });
  const granted = await run(['grant-admin', String(id)]);
  expect(granted.code).toBe(0);
  expect(userId).not.toBe('');
  return id;
}

/** Someone who has applied to be a doctor. */
async function applicant(
  options: { last?: string; locale?: 'ru' | 'uz'; note?: string } = {},
): Promise<{ userId: string; telegramId: number }> {
  const id = nextTelegramId();
  const userId = await insertPatient(sql(), {
    telegramId: id,
    lastName: options.last ?? 'Applicant',
  });
  if (options.locale !== undefined) {
    await sql()`update users set locale = ${options.locale} where id = ${userId}`;
  }
  await repos.clinicians.register(
    { kind: 'PATIENT', userId },
    { userId, note: options.note ?? 'Pediatrician, licence UZ-1' },
  );
  return { userId, telegramId: id };
}

async function statusOf(userId: string): Promise<string | undefined> {
  const [row] = await sql()<{ verification_status: string }[]>`
    select verification_status from clinician_profiles where user_id = ${userId}`;
  return row?.verification_status;
}

describe('grant-admin', () => {
  it('makes an existing account an administrator, and says so', async () => {
    const id = nextTelegramId();
    const userId = await insertPatient(sql(), { telegramId: id });

    const result = await run(['grant-admin', String(id)]);

    expect(result.code).toBe(0);
    expect(result.output).toContain(userId);
    const [row] = await sql()<{ status: string }[]>`
      select status from platform_staff where user_id = ${userId}`;
    expect(row?.status).toBe('ACTIVE');
  });

  it('refuses someone who has never started the bot', async () => {
    const result = await run(['grant-admin', String(nextTelegramId())]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('must start the bot first');
  });

  it('refuses a blocked account', async () => {
    const id = nextTelegramId();
    await insertPatient(sql(), { telegramId: id, userStatus: 'BLOCKED' });
    expect((await run(['grant-admin', String(id)])).code).toBe(1);
  });

  it.each([
    [['grant-admin']],
    [['grant-admin', 'abc']],
    [['grant-admin', '0']],
    [['grant-admin', '12.5']],
    [['grant-admin', '1', '2']],
    [['grant-admin', '1', '--by', '2']],
  ])('is a usage mistake: %j', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.output).toContain('Usage');
  });
});

describe('list-doctors', () => {
  it('shows who applied, what they wrote, and how to reach them, oldest first', async () => {
    const by = await administrator();
    const first = await applicant({ last: 'Aaa', note: 'Cardiologist, Heart Centre' });
    const second = await applicant({ last: 'Bbb' });

    const result = await run(['list-doctors', '--by', String(by)]);

    expect(result.code).toBe(0);
    const lines = result.output.split('\n');
    const at = (userId: string) => lines.findIndex((line) => line.startsWith(userId));
    expect(at(first.userId)).toBeGreaterThanOrEqual(0);
    expect(at(first.userId)).toBeLessThan(at(second.userId));
    expect(result.output).toContain(`telegram:${String(first.telegramId)}`);
    expect(result.output).toContain('wrote: Cardiologist, Heart Centre');
    expect(result.output).toContain('PENDING');
  });

  it('can show another state, and says when there is nobody', async () => {
    const by = await administrator();
    expect(
      (await run(['list-doctors', '--by', String(by), '--status', 'revoked'])).output,
    ).toContain('no doctors with status REVOKED');
    expect((await run(['list-doctors', '--by', String(by), '--status', 'nonsense'])).code).toBe(2);
  });

  it('needs an administrator named by --by, and an active one', async () => {
    expect((await run(['list-doctors'])).code).toBe(2);
    expect((await run(['list-doctors', '--by', 'me'])).code).toBe(2);
    expect((await run(['list-doctors', '--by', String(nextTelegramId())])).code).toBe(1);

    const notAdmin = nextTelegramId();
    await insertPatient(sql(), { telegramId: notAdmin });
    const refused = await run(['list-doctors', '--by', String(notAdmin)]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('grant-admin');

    const withdrawn = nextTelegramId();
    const userId = await insertPatient(sql(), { telegramId: withdrawn });
    await sql()`insert into platform_staff (user_id, role, status) values (${userId}, 'TECH_ADMIN', 'REVOKED')`;
    expect((await run(['list-doctors', '--by', String(withdrawn)])).code).toBe(1);
  });
});

describe('verify-doctor', () => {
  it('accepts a doctor, records what was checked, and tells them in their own language', async () => {
    const by = await administrator();
    const doctor = await applicant({ locale: 'uz' });

    const result = await run([
      'verify-doctor',
      doctor.userId,
      '--by',
      String(by),
      '--reference',
      'licence UZ-1 seen on 2026-10-02',
    ]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('is now verified');
    expect(result.output).toContain('the doctor was told');
    expect(await statusOf(doctor.userId)).toBe('VERIFIED');
    expect(result.telegram.lastTo(doctor.telegramId)?.text).toBe(t('uz', 'doctor.verified'));
    const [row] = await sql()<{ verification_reference: string }[]>`
      select verification_reference from clinician_profiles where user_id = ${doctor.userId}`;
    expect(row?.verification_reference).toBe('licence UZ-1 seen on 2026-10-02');
  });

  it('does not tell the doctor twice', async () => {
    const by = await administrator();
    const doctor = await applicant();
    const telegram = new FakeTelegram();
    const argv = ['verify-doctor', doctor.userId, '--by', String(by), '--reference', 'ok'];

    await run(argv, { api: telegram });
    const again = await run(argv, { api: telegram });

    expect(again.code).toBe(0);
    expect(again.output).toContain('nothing changed');
    expect(telegram.messagesTo(doctor.telegramId)).toHaveLength(1);
  });

  it('says so when it cannot tell the doctor, and still verifies', async () => {
    const by = await administrator();
    const quiet = await applicant();
    const noToken = await run(
      ['verify-doctor', quiet.userId, '--by', String(by), '--reference', 'ok'],
      { api: null },
    );
    expect(noToken.code).toBe(0);
    expect(noToken.output).toContain('no TELEGRAM_BOT_TOKEN');
    expect(await statusOf(quiet.userId)).toBe('VERIFIED');

    const blocked = await applicant();
    const telegram = new FakeTelegram();
    telegram.failNext.sendMessage = new Error('Forbidden: bot was blocked by the user');
    const failed = await run(
      ['verify-doctor', blocked.userId, '--by', String(by), '--reference', 'ok'],
      { api: telegram },
    );
    expect(failed.code).toBe(0);
    expect(failed.output).toContain('could not be told');
    expect(failed.output).not.toContain('blocked by the user');
    expect(await statusOf(blocked.userId)).toBe('VERIFIED');
  });

  it('insists on a reference, a real user id, and a doctor that exists', async () => {
    const by = await administrator();
    const doctor = await applicant();

    expect((await run(['verify-doctor', doctor.userId, '--by', String(by)])).code).toBe(2);
    expect(
      (await run(['verify-doctor', 'not-an-id', '--by', String(by), '--reference', 'x'])).code,
    ).toBe(2);
    expect(
      (await run(['verify-doctor', doctor.userId, '--by', String(by), '--reference', '  '])).code,
    ).toBe(2);
    const missing = await run([
      'verify-doctor',
      '00000000-0000-4000-8000-000000000000',
      '--by',
      String(by),
      '--reference',
      'x',
    ]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain('no doctor has that user id');
    expect(await statusOf(doctor.userId)).toBe('PENDING');
  });

  it('refuses someone who is not an administrator, including an applicant verifying themselves', async () => {
    const doctor = await applicant();
    const result = await run([
      'verify-doctor',
      doctor.userId,
      '--by',
      String(doctor.telegramId),
      '--reference',
      'self-approved',
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('refused');
    expect(await statusOf(doctor.userId)).toBe('PENDING');
  });

  it('rejects odd command lines without touching anything', async () => {
    const by = await administrator();
    const doctor = await applicant();
    for (const argv of [
      ['verify-doctor', doctor.userId, '--by'],
      ['verify-doctor', doctor.userId, '--by', String(by), '--by', String(by), '--reference', 'x'],
      ['verify-doctor', doctor.userId, '--by', String(by), '--reference', 'x', '--force', 'yes'],
      ['verify-doctor', doctor.userId, doctor.userId, '--by', String(by), '--reference', 'x'],
      ['verify-doctors'],
    ]) {
      expect((await run(argv)).code, argv.join(' ')).toBe(2);
    }
    expect(await statusOf(doctor.userId)).toBe('PENDING');
  });
});

describe('revoke-doctor', () => {
  it('withdraws a doctor’s standing at once, quietly', async () => {
    const by = await administrator();
    const doctor = await applicant();
    await run(['verify-doctor', doctor.userId, '--by', String(by), '--reference', 'ok']);
    const telegram = new FakeTelegram();

    const result = await run(
      ['revoke-doctor', doctor.userId, '--by', String(by), '--reference', 'licence lapsed'],
      { api: telegram },
    );

    expect(result.code).toBe(0);
    expect(result.output).toContain('is now revoked');
    expect(await statusOf(doctor.userId)).toBe('REVOKED');
    expect(telegram.messagesTo(doctor.telegramId)).toEqual([]);
    expect(
      await repos.invitations.create(
        { kind: 'CLINICIAN', userId: doctor.userId },
        { now: new Date('2026-10-02T10:00:00Z') },
      ),
    ).toEqual({ status: 'NOT_ALLOWED' });
  });

  it('can be done without a reason, is idempotent, and can be reversed by verifying again', async () => {
    const by = await administrator();
    const doctor = await applicant();
    expect((await run(['revoke-doctor', doctor.userId, '--by', String(by)])).output).toContain(
      'is now revoked',
    );
    expect((await run(['revoke-doctor', doctor.userId, '--by', String(by)])).output).toContain(
      'nothing changed',
    );
    expect(
      (await run(['verify-doctor', doctor.userId, '--by', String(by), '--reference', 'renewed']))
        .code,
    ).toBe(0);
    expect(await statusOf(doctor.userId)).toBe('VERIFIED');
  });
});

describe('help', () => {
  it('prints the usage and fails when there is no command at all', async () => {
    expect(await run([])).toMatchObject({ code: 2, output: USAGE });
    expect(await run(['help'])).toMatchObject({ code: 0, output: USAGE });
    expect((await run(['--help'])).code).toBe(0);
  });
});

describe('clinic staff', () => {
  /** A doctor's practice: the only way a clinic comes to exist in the MVP. */
  async function clinic(): Promise<string> {
    const doctor = await applicant({ last: 'Practice' });
    const [row] = await sql()<{ clinic_id: string }[]>`
      select clinic_id from clinician_profiles where user_id = ${doctor.userId}`;
    return row?.clinic_id ?? '';
  }

  async function registered(): Promise<{ userId: string; telegramId: number }> {
    const id = nextTelegramId();
    return {
      userId: await insertPatient(sql(), { telegramId: id, lastName: 'Desk' }),
      telegramId: id,
    };
  }

  const system = { kind: 'SYSTEM', reason: 'test' } as const;
  const now = new Date('2026-10-03T04:00:00Z');

  it('are appointed by Telegram id, listed with their clinic, and can be revoked', async () => {
    const by = await administrator();
    const clinicId = await clinic();
    const desk = await registered();
    const add = (role: string) =>
      run(['add-staff', clinicId, String(desk.telegramId), '--role', role, '--by', String(by)]);

    const added = await add('reception');
    expect(added.code).toBe(0);
    expect(added.output).toContain('added as RECEPTION');

    const changed = await add('CLINIC_ADMIN');
    expect(changed.code).toBe(0);
    expect(changed.output).toContain('the role is now CLINIC_ADMIN');

    const listed = await run(['list-clinics', '--by', String(by)]);
    expect(listed.code).toBe(0);
    const lines = listed.output.split('\n');
    const at = lines.findIndex((line) => line.startsWith(clinicId));
    expect(lines[at]).toContain('Private practice: Practice');
    expect(lines[at]).toContain('ACTIVE');
    expect(lines[at + 1]).toMatch(
      /^ {4}staff:[0-9a-f-]{36} {2}Desk \S+ {2}CLINIC_ADMIN {2}ACTIVE$/,
    );
    const staffId = /staff:([0-9a-f-]{36})/.exec(lines[at + 1] ?? '')?.[1] ?? '';

    // Staff can ask the bot for a panel link; a revoked one cannot.
    expect((await repos.panel.issueLogin(system, { userId: desk.userId, now })).status).toBe(
      'ISSUED',
    );

    const revoked = await run(['revoke-staff', staffId, '--by', String(by)]);
    expect(revoked.code).toBe(0);
    expect((await repos.panel.issueLogin(system, { userId: desk.userId, now })).status).toBe(
      'NOT_STAFF',
    );
    const again = await run(['revoke-staff', staffId, '--by', String(by)]);
    expect(again.code).toBe(1);
    expect(again.output).toContain('no active staff membership');
  });

  it('need a real clinic and a person who has started the bot', async () => {
    const by = await administrator();
    const clinicId = await clinic();
    const desk = await registered();

    const stranger = await run([
      'add-staff',
      clinicId,
      String(nextTelegramId()),
      '--role',
      'RECEPTION',
      '--by',
      String(by),
    ]);
    expect(stranger.code).toBe(1);
    expect(stranger.output).toContain('has not registered');
    const nowhere = await run([
      'add-staff',
      '00000000-0000-4000-8000-000000000000',
      String(desk.telegramId),
      '--role',
      'RECEPTION',
      '--by',
      String(by),
    ]);
    expect(nowhere.code).toBe(1);
  });

  it('are not for anyone but an administrator to appoint, list or revoke', async () => {
    const clinicId = await clinic();
    const desk = await registered();
    const nobody = await registered();

    for (const argv of [
      ['add-staff', clinicId, String(desk.telegramId), '--role', 'RECEPTION'],
      ['list-clinics'],
      ['revoke-staff', '00000000-0000-4000-8000-000000000000'],
    ]) {
      const result = await run([...argv, '--by', String(nobody.telegramId)]);
      expect(result.code, argv[0]).toBe(1);
      expect(result.output).toContain('refused');
    }
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from clinic_staff where clinic_id = ${clinicId}`;
    expect(row?.n).toBe(0);
  });

  const NOWHERE = '00000000-0000-4000-8000-000000000000';
  it.each([
    [['add-staff']],
    [['add-staff', 'not-an-id', '5', '--role', 'RECEPTION', '--by', '1']],
    [['add-staff', NOWHERE, 'abc', '--role', 'RECEPTION', '--by', '1']],
    [['add-staff', NOWHERE, '5', '--by', '1']],
    [['add-staff', NOWHERE, '5', '--role', 'TECH_ADMIN', '--by', '1']],
    [['add-staff', NOWHERE, '5', '6', '--role', 'RECEPTION', '--by', '1']],
    [['list-clinics', 'extra', '--by', '1']],
    [['list-clinics']],
    [['revoke-staff', '--by', '1']],
    [['revoke-staff', 'not-an-id', '--by', '1']],
    [['revoke-staff', NOWHERE, NOWHERE, '--by', '1']],
  ])('is a usage mistake: %j', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
  });
});
