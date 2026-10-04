import { randomBytes } from 'node:crypto';
import { createRepositories, createRepositoryDeps, type Repositories } from '@medcourse/db';
import {
  afterFirstDose,
  createTestDatabase,
  startRunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECONCILE_INTERVAL_MS, reconcileDue, runReconciliation } from './reconcile';

let testDatabase: TestDatabase;
let repos: Repositories;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
});

afterAll(async () => {
  await testDatabase.drop();
});

describe('runReconciliation', () => {
  it('opens an incident once the queue is ten minutes behind, says so in the log, and does not repeat itself', async () => {
    const { sql, orm } = testDatabase.db;
    await startRunningCourse(sql, repos);
    const lines: string[] = [];
    const logger = createLogger({
      service: 'reconcile-test',
      level: 'info',
      stream: { write: (line) => lines.push(line) },
    });
    const run = (now: Date) => runReconciliation({ orm, repositoryDeps, now, logger });

    // Nine minutes after the first reminder was due: late, but not yet an incident.
    expect(await run(afterFirstDose(9))).toBe(0);
    expect(lines).toEqual([]);

    // 45 minutes: three reminders are waiting and the dose is past its deadline unrecorded.
    expect(await run(afterFirstDose(45))).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'warn', incidentsOpened: 2 });

    expect(await run(afterFirstDose(60))).toBe(0);
    expect(lines).toHaveLength(1);
    const incidents = await sql<{ kind: string; type: string; course_id: string | null }[]>`
      select kind, type, course_id from incidents order by type`;
    expect(incidents).toEqual([
      { kind: 'TECHNICAL', type: 'QUEUE_LATE', course_id: null },
      { kind: 'TECHNICAL', type: 'SWEEP_LATE', course_id: null },
    ]);
  });
});

describe('reconcileDue', () => {
  it('is due the first time, then every five minutes', () => {
    const now = new Date('2026-10-03T04:00:00Z');
    expect(reconcileDue(null, now)).toBe(true);
    expect(reconcileDue(now, new Date(now.getTime() + RECONCILE_INTERVAL_MS - 1))).toBe(false);
    expect(reconcileDue(now, new Date(now.getTime() + RECONCILE_INTERVAL_MS))).toBe(true);
  });
});
