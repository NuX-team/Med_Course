import { randomBytes } from 'node:crypto';
import {
  DELETION_GRACE_MS,
  createRepositories,
  createRepositoryDeps,
  type Repositories,
} from '@medcourse/db';
import { createTestDatabase, startRunningCourse, type TestDatabase } from '@medcourse/db/testing';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVACY_SWEEP_INTERVAL_MS, privacySweepDue, runPrivacySweep } from './privacy';

let testDatabase: TestDatabase;
let repos: Repositories;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
const DAY = 86_400_000;
const NOW = new Date('2026-10-04T02:00:00Z');

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
});

afterAll(async () => {
  await testDatabase.drop();
});

describe('runPrivacySweep', () => {
  it('carries out deletions that are due and draws up summaries that are due, and logs ids only', async () => {
    const { sql, orm } = testDatabase.db;
    const leaving = await startRunningCourse(sql, repos);
    const staying = await startRunningCourse(sql, repos);
    await repos.lifecycle.cancel(staying.doctor, {
      courseId: staying.courseId,
      now: NOW,
      key: 'k1',
    });
    await repos.privacy.requestDeletion(leaving.patient, { now: NOW, key: 'k2' });
    const lines: string[] = [];
    const logger = createLogger({
      service: 'privacy-test',
      level: 'info',
      stream: { write: (line) => lines.push(line) },
    });
    const run = (now: Date) => runPrivacySweep({ orm, repositoryDeps, now, logger });

    // Three days on: the cancelled course gets its summary; the deletion is not due yet.
    expect(await run(new Date(NOW.getTime() + 3 * DAY))).toEqual({
      accountsErased: 0,
      summariesWritten: 1,
    });
    expect(await run(new Date(NOW.getTime() + 4 * DAY))).toEqual({
      accountsErased: 0,
      summariesWritten: 0,
    });

    // Thirty days on: the request is carried out.
    expect(await run(new Date(NOW.getTime() + DELETION_GRACE_MS))).toEqual({
      accountsErased: 1,
      summariesWritten: 0,
    });
    const [person] = await sql<{ status: string }[]>`
      select status from users where id = ${leaving.patientId}`;
    expect(person?.status).toBe('DELETED');

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((entry) => entry.msg)).toEqual([
      'course summaries drawn up',
      'deletion request carried out',
    ]);
    expect(entries[1]).toMatchObject({ userId: leaving.patientId });
    const dump = lines.join('');
    for (const secret of ['Aziza', 'Karimova', 'Testamol', String(leaving.patientTelegramId)]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe('privacySweepDue', () => {
  it('is due the first time, then once an hour', () => {
    expect(privacySweepDue(null, NOW)).toBe(true);
    expect(privacySweepDue(NOW, new Date(NOW.getTime() + PRIVACY_SWEEP_INTERVAL_MS - 1))).toBe(
      false,
    );
    expect(privacySweepDue(NOW, new Date(NOW.getTime() + PRIVACY_SWEEP_INTERVAL_MS))).toBe(true);
  });
});
