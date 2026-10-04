import { randomBytes } from 'node:crypto';
import { createRepositories, createRepositoryDeps, hashInviteCode } from '@medcourse/db';
import {
  createTestDatabase,
  insertClinic,
  insertClinician,
  insertPatient,
  insertRelationship,
  type TestDatabase,
} from '@medcourse/db/testing';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAINTENANCE_INTERVAL_MS,
  START_WINDOW_SWEEP_INTERVAL_MS,
  maintenanceDue,
  runMaintenance,
  runStartWindowSweep,
  startWindowSweepDue,
} from './maintenance';

let testDatabase: TestDatabase;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
const logger = createLogger({ service: 'maintenance-test', level: 'silent' });
const NOW = new Date('2026-10-10T12:00:00Z');

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.drop();
});

describe('runMaintenance', () => {
  it('forgets updates older than a week and conversations that have expired, and nothing else', async () => {
    const { sql, orm } = testDatabase.db;
    const repos = createRepositories(orm, repositoryDeps);

    await sql`insert into tg_updates (update_id, received_at) values
      (1, '2026-09-30T11:59:59Z'), (2, '2026-10-03T12:00:01Z'), (3, '2026-10-10T11:00:00Z')`;
    await repos.telegram.setConversation(
      11,
      { flow: 'ONBOARDING', step: 'LANGUAGE', data: {} },
      new Date('2026-10-01T00:00:00Z'),
      3_600_000,
    );
    await repos.telegram.setConversation(
      12,
      { flow: 'ONBOARDING', step: 'LANGUAGE', data: {} },
      NOW,
      3_600_000,
    );

    const result = await runMaintenance({ orm, repositoryDeps, now: NOW, logger });

    expect(result).toEqual({
      updatesPruned: 1,
      conversationsPurged: 1,
      attemptsPruned: 0,
      invitationsPruned: 0,
      panelPruned: 0,
    });
    const remainingUpdates = await sql<
      { update_id: string }[]
    >`select update_id from tg_updates order by update_id`;
    expect(remainingUpdates.map((row) => Number(row.update_id))).toEqual([2, 3]);
    expect(await repos.telegram.getConversation(12, NOW)).not.toBeNull();
  });

  it('forgets old failed attempts and invitations that died unused, and keeps what is still needed', async () => {
    const { sql, orm } = testDatabase.db;
    const clinic = await insertClinic(sql);
    const doctor = await insertClinician(sql, clinic);
    const patient = await insertPatient(sql);
    const relationship = await insertRelationship(sql, patient, doctor, 'PENDING');

    await sql`insert into invitation_attempts (telegram_user_id, at) values
      (21, '2026-10-08T00:00:00Z'), (22, '2026-10-10T11:00:00Z')`;
    await sql`
      insert into invitations (clinician_id, code_hash, created_at, expires_at, used_at, used_by, care_relationship_id)
      values
        (${doctor}, ${hashInviteCode('dead')}, '2026-07-28T00:00:00Z', '2026-07-31T00:00:00Z', null, null, null),
        (${doctor}, ${hashInviteCode('recent')}, '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', null, null, null),
        (${doctor}, ${hashInviteCode('used')}, '2026-07-28T00:00:00Z', '2026-07-31T00:00:00Z',
         '2026-07-29T00:00:00Z', ${patient}, ${relationship})`;

    const result = await runMaintenance({ orm, repositoryDeps, now: NOW, logger });

    expect(result).toMatchObject({ attemptsPruned: 1, invitationsPruned: 1 });
    const kept = await sql<{ code_hash: string }[]>`
      select code_hash from invitations where clinician_id = ${doctor} order by created_at`;
    expect(kept.map((row) => row.code_hash).sort()).toEqual(
      [hashInviteCode('recent'), hashInviteCode('used')].sort(),
    );
    const attempts = await sql<{ telegram_user_id: string }[]>`
      select telegram_user_id from invitation_attempts where telegram_user_id in (21, 22)`;
    expect(attempts.map((row) => Number(row.telegram_user_id))).toEqual([22]);
  });

  it('can run twice in a row, and on an empty database', async () => {
    const { orm } = testDatabase.db;
    await runMaintenance({ orm, repositoryDeps, now: NOW, logger });
    expect(await runMaintenance({ orm, repositoryDeps, now: NOW, logger })).toEqual({
      updatesPruned: 0,
      conversationsPurged: 0,
      attemptsPruned: 0,
      invitationsPruned: 0,
      panelPruned: 0,
    });
  });

  it('forgets panel sign-in links and sessions a day after they ran out, and keeps live ones', async () => {
    const { sql, orm } = testDatabase.db;
    const staff = await insertPatient(sql);
    await sql`insert into platform_staff (user_id, role) values (${staff}, 'TECH_ADMIN')`;
    const hash = (label: string) => hashInviteCode(label);
    await sql`
      insert into panel_logins (user_id, token_hash, created_at, expires_at) values
        (${staff}, ${hash('old link')}, '2026-10-09T11:00:00Z', '2026-10-09T11:59:59Z'),
        (${staff}, ${hash('recent link')}, '2026-10-09T12:00:00Z', '2026-10-09T12:05:00Z')`;
    await sql`
      insert into panel_sessions (user_id, token_hash, csrf_token, created_at, expires_at) values
        (${staff}, ${hash('old session')}, ${'a'.repeat(43)}, '2026-10-08T23:00:00Z', '2026-10-09T11:00:00Z'),
        (${staff}, ${hash('live session')}, ${'b'.repeat(43)}, '2026-10-10T08:00:00Z', '2026-10-10T20:00:00Z')`;

    const result = await runMaintenance({ orm, repositoryDeps, now: NOW, logger });

    expect(result.panelPruned).toBe(2);
    const left = await sql<{ token_hash: string }[]>`
      select token_hash from panel_logins where user_id = ${staff}
      union all select token_hash from panel_sessions where user_id = ${staff}`;
    expect(left.map((row) => row.token_hash).sort()).toEqual(
      [hash('recent link'), hash('live session')].sort(),
    );
  });
});

describe('maintenanceDue', () => {
  it('is due the first time, then once an hour has passed', () => {
    expect(maintenanceDue(null, NOW)).toBe(true);
    expect(maintenanceDue(NOW, new Date(NOW.getTime() + MAINTENANCE_INTERVAL_MS - 1))).toBe(false);
    expect(maintenanceDue(NOW, new Date(NOW.getTime() + MAINTENANCE_INTERVAL_MS))).toBe(true);
  });
});

describe('runStartWindowSweep', () => {
  it('closes courses whose start window has ended, however many, and no others', async () => {
    const { sql, orm } = testDatabase.db;
    const clinic = await insertClinic(sql);
    const doctor = await insertClinician(sql, clinic);
    const insertPending = async (windowEnd: string): Promise<string> => {
      const patient = await insertPatient(sql);
      const relationship = await insertRelationship(sql, patient, doctor, 'ACTIVE');
      const [row] = await sql<{ id: string }[]>`
        insert into treatment_courses
          (care_relationship_id, patient_id, clinician_id, clinic_id, status, duration_days, timezone,
           start_window_from, start_window_to)
        values (${relationship}, ${patient}, ${doctor}, ${clinic}, 'PENDING_PATIENT', 7, 'Asia/Tashkent',
                '2026-10-01T00:00:00Z', ${windowEnd})
        returning id`;
      return row?.id ?? '';
    };
    const expired: string[] = [];
    // More than one batch, to prove the sweep keeps going until it is done.
    for (let index = 0; index < 205; index += 1) {
      expired.push(await insertPending('2026-10-05T00:00:00Z'));
    }
    const open = await insertPending('2026-10-20T00:00:00Z');

    const closed = await runStartWindowSweep({ orm, repositoryDeps, now: NOW, logger });

    expect(closed).toBe(205);
    const [counts] = await sql<{ expired: number; open: string }[]>`
      select (select count(*) from treatment_courses
              where id in ${sql(expired)} and status = 'EXPIRED_NOT_STARTED')::int as expired,
             (select status from treatment_courses where id = ${open}) as open`;
    expect(counts).toEqual({ expired: 205, open: 'PENDING_PATIENT' });
    expect(await runStartWindowSweep({ orm, repositoryDeps, now: NOW, logger })).toBe(0);
  });

  it('is due the first time, then every five minutes', () => {
    expect(startWindowSweepDue(null, NOW)).toBe(true);
    expect(
      startWindowSweepDue(NOW, new Date(NOW.getTime() + START_WINDOW_SWEEP_INTERVAL_MS - 1)),
    ).toBe(false);
    expect(startWindowSweepDue(NOW, new Date(NOW.getTime() + START_WINDOW_SWEEP_INTERVAL_MS))).toBe(
      true,
    );
  });
});
