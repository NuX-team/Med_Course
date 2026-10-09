import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIRECTORY, createTestDatabase, type TestDatabase } from '../test/helpers';
import { startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor } from './access/actor';
import {
  BackupError,
  backupFileName,
  inspectBackup,
  pruneBackups,
  restoreBackup,
  verifyAgainst,
  writeBackup,
  type BackupKey,
} from './backup';
import { loadMigrations, type Migration } from './migrate';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

/**
 * Backups and the restore drill (TZ §12, §18.1): a database with a lived course in it is backed
 * up, restored into a second, empty database, and the two are compared. The course is
 * "Testamol", prescribed by "Rustam Tor" to "Aziza Karimova".
 */

let source: TestDatabase;
let repos: Repositories;
let course: RunningCourse;
let directory: string;
let migrations: Migration[];
const fieldKeys = [{ id: 't', key: randomBytes(32) }];
const key: BackupKey = { id: 'backup-test', key: randomBytes(32) };
const NOW = new Date('2026-10-04T03:15:30Z');
const system = systemActor('backup test');
const scratch: TestDatabase[] = [];

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

async function empty(): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrate: false });
  scratch.push(database);
  return database;
}

beforeAll(async () => {
  source = await createTestDatabase();
  repos = createRepositories(source.db.orm, createRepositoryDeps(fieldKeys));
  migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
  directory = await mkdtemp(join(tmpdir(), 'medcourse-backup-'));

  // A little of everything: a course with answers, a skip in the patient's words, an export,
  // a summary, a deletion request, and an account already anonymised.
  course = await startRunningCourse(source.db.sql, repos, {
    medications: [{ instructions: 'запивать тёплой водой' }],
  });
  const doses = await source.db.sql<{ id: string }[]>`
    select id from scheduled_doses where course_id = ${course.courseId}
    order by scheduled_at limit 2`;
  await repos.answers.take(course.patient, {
    doseId: doses[0]?.id ?? '',
    now: local(1, '08:05'),
    key: 'k1',
  });
  await repos.answers.skip(course.patient, {
    doseId: doses[1]?.id ?? '',
    now: local(1, '20:10'),
    key: 'k2',
    reason: 'OTHER',
    text: 'была в дороге 🚗',
  });
  await repos.history.exportCourse(course.doctor, {
    courseId: course.courseId,
    format: 'PDF',
    now: local(2, '07:00'),
  });
  const gone = await startRunningCourse(source.db.sql, repos);
  await repos.privacy.requestDeletion(gone.patient, { now: local(2, '07:00'), key: 'k3' });
  await repos.privacy.eraseDue(system, local(40, '07:00'));
  const leaving = await startRunningCourse(source.db.sql, repos);
  await repos.privacy.requestDeletion(leaving.patient, { now: local(2, '08:00'), key: 'k4' });
});

afterAll(async () => {
  for (const database of [source, ...scratch]) {
    await database.drop();
  }
  await rm(directory, { recursive: true, force: true });
});

const fresh = (name: string): string =>
  join(directory, `${name}-${randomBytes(3).toString('hex')}`);

describe('a backup', () => {
  it('holds every table, says how many rows and of which schema, and shows nothing in the clear', async () => {
    const path = fresh('whole');

    const manifest = await writeBackup(source.db.sql, key, path, NOW);

    expect(manifest.createdAt).toBe('2026-10-04T03:15:30.000Z');
    expect(manifest.migrations.map(({ id }) => id)).toEqual(migrations.map(({ id }) => id));
    expect(Object.keys(manifest.tables)).toHaveLength(35);
    expect(manifest.tables).not.toHaveProperty('schema_migrations');
    expect(manifest.tables.treatment_courses?.rows).toBe(3);
    expect(manifest.tables.scheduled_doses?.rows).toBe(42);
    expect(manifest.tables.deletion_requests?.rows).toBe(2);
    expect(manifest.sequences.erased_users_seq).toBe(1);
    expect(await inspectBackup(path, [key])).toEqual(manifest);

    const bytes = await readFile(path);
    expect(bytes.subarray(0, 6).toString()).toBe('MCBK1\n');
    for (const secret of ['Aziza', 'Karimova', 'Testamol', 'treatment_courses', course.courseId]) {
      expect(bytes.includes(secret), secret).toBe(false);
    }
  });

  it('does not overwrite a file that is already there', async () => {
    const path = fresh('once');
    await writeBackup(source.db.sql, key, path, NOW);
    await expect(writeBackup(source.db.sql, key, path, NOW)).rejects.toThrow(/EEXIST/);
  });

  it('opens only with the key it was sealed with', async () => {
    const path = fresh('keyed');
    await writeBackup(source.db.sql, key, path, NOW);

    await expect(
      inspectBackup(path, [{ id: 'backup-test', key: randomBytes(32) }]),
    ).rejects.toThrow(BackupError);
    await expect(inspectBackup(path, [{ id: 'another', key: key.key }])).rejects.toThrow(
      /key "backup-test", which is not configured/,
    );
    // An old key kept beside the new one still opens old backups.
    await expect(
      inspectBackup(path, [{ id: 'newer', key: randomBytes(32) }, key]),
    ).resolves.toMatchObject({ createdAt: NOW.toISOString() });
  });

  it('is refused when cut short, changed, extended, or not a backup at all', async () => {
    const path = fresh('damaged');
    await writeBackup(source.db.sql, key, path, NOW);
    const bytes = await readFile(path);
    const variant = async (name: string, content: Buffer): Promise<string> => {
      const file = fresh(name);
      await writeFile(file, content);
      return file;
    };
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(bytes.length / 2)] = (flipped[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;

    for (const file of [
      await variant('cut', bytes.subarray(0, bytes.length - 40)),
      await variant('cut-early', bytes.subarray(0, 200)),
      await variant('flipped', flipped),
      await variant('extended', Buffer.concat([bytes, Buffer.from([0, 0, 0, 0, 16])])),
      await variant('foreign', Buffer.from('this is just some text, long enough to be read')),
      await variant('nothing', Buffer.alloc(0)),
    ]) {
      await expect(inspectBackup(file, [key]), file).rejects.toThrow(BackupError);
    }
  });
});

describe('restoring a backup', () => {
  it('brings back every row, the sequences and the guards, in a database that can be used', async () => {
    const path = fresh('restore');
    const manifest = await writeBackup(source.db.sql, key, path, NOW);
    const target = await empty();

    const report = await restoreBackup(target.db.sql, [key], path, migrations);

    expect(report.problems).toEqual([]);
    expect(report.manifest).toEqual(manifest);
    expect(await verifyAgainst(target.db.sql, manifest)).toEqual([]);

    // The restored data is the same data: readable with the same field keys...
    const restored = createRepositories(target.db.orm, createRepositoryDeps(fieldKeys));
    const summary = await restored.history.report(course.patient, course.courseId);
    expect(summary?.adherence).toMatchObject({ taken: 1, skipped: 1 });
    expect(summary?.otherReasons).toMatchObject([{ text: 'была в дороге 🚗' }]);
    expect(summary?.plan.medications[0]?.instructions).toBe('запивать тёплой водой');
    // ...the database goes on working where the old one stopped...
    const taken = await restored.history.exportCourse(course.patient, {
      courseId: course.courseId,
      format: 'CSV',
      now: local(3, '09:00'),
    });
    expect(taken?.status).toBe('READY');
    const [audit] = await target.db.sql<
      { max: string }[]
    >`select max(id)::text as max from audit_log`;
    const [was] = await source.db.sql<
      { max: string }[]
    >`select max(id)::text as max from audit_log`;
    expect(Number(audit?.max)).toBe(Number(was?.max) + 1);
    // ...and its guards are back on: the journal is still append-only.
    await expect(target.db.sql`delete from dose_events`).rejects.toThrow(/append-only/);
    await expect(
      target.db.sql`update course_medications set display_name = 'Other'`,
    ).rejects.toThrow(/can no longer change/);
    // A request for deletion made before the backup is still waiting, and still falls due.
    expect(await restored.privacy.eraseDue(system, local(40, '09:00'))).toHaveLength(1);
  });

  it('notices a database that differs from the backup by a single row or a single value', async () => {
    const path = fresh('compare');
    const manifest = await writeBackup(source.db.sql, key, path, NOW);
    const target = await empty();
    await restoreBackup(target.db.sql, [key], path, migrations);

    await target.db
      .sql`update patient_profiles set first_name = 'Azida' where first_name = 'Aziza'`;
    expect(await verifyAgainst(target.db.sql, manifest)).toEqual([
      'patient_profiles: the content differs from the backup',
    ]);

    await target.db.sql`delete from panel_logins`;
    await target.db.sql`insert into clinics (name) values ('Extra')`;
    await target.db.sql`select setval('erased_users_seq', 500)`;
    expect(await verifyAgainst(target.db.sql, manifest)).toEqual([
      expect.stringMatching(/^clinics: \d+ rows, the backup has \d+$/),
      'patient_profiles: the content differs from the backup',
      'sequence erased_users_seq: 500, the backup has 1',
    ]);
  });

  it('refuses a database that is not empty, and leaves it as it was', async () => {
    const path = fresh('occupied');
    await writeBackup(source.db.sql, key, path, NOW);
    const target = await empty();
    await target.db.sql`create table keep_me (id int)`;

    await expect(restoreBackup(target.db.sql, [key], path, migrations)).rejects.toThrow(
      /not empty/,
    );
    const tables = await target.db.sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'`;
    expect(tables.map((row) => row.tablename)).toEqual(['keep_me']);
  });

  it('refuses a backup made by another version of the schema, before creating anything', async () => {
    const path = fresh('version');
    await writeBackup(source.db.sql, key, path, NOW);
    const target = await empty();
    const changed = migrations.map((migration, index) =>
      index === 3 ? { ...migration, checksum: 'f'.repeat(64) } : migration,
    );

    await expect(restoreBackup(target.db.sql, [key], path, changed)).rejects.toThrow(
      /another version of the schema/,
    );
    await expect(
      restoreBackup(target.db.sql, [key], path, migrations.slice(0, -1)),
    ).rejects.toThrow(/another version of the schema/);
    // The same number of migrations, but one the backup knows is not among them.
    const renamed = migrations.map((migration, index) =>
      index === migrations.length - 1 ? { ...migration, id: '9999_something_else' } : migration,
    );
    await expect(restoreBackup(target.db.sql, [key], path, renamed)).rejects.toThrow(
      /another version of the schema/,
    );
    const [tables] = await target.db.sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'public'`;
    expect(tables?.n).toBe(0);
  });

  it('refuses a damaged file before creating anything', async () => {
    const path = fresh('broken');
    await writeBackup(source.db.sql, key, path, NOW);
    const bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, bytes.length - 10));
    const target = await empty();

    await expect(restoreBackup(target.db.sql, [key], path, migrations)).rejects.toThrow(
      BackupError,
    );
    const [tables] = await target.db.sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'public'`;
    expect(tables?.n).toBe(0);
  });
});

describe('keeping backups', () => {
  it('names each file by the moment it was made, so that names sort by time', () => {
    expect(backupFileName(NOW)).toBe('medcourse-20261004-031530.mcbk');
    expect(backupFileName(new Date('2026-12-31T23:59:59.999Z'))).toBe(
      'medcourse-20261231-235959.mcbk',
    );
  });

  it('removes all but the newest few, and touches nothing that is not a backup', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'medcourse-keep-'));
    const names = [
      'medcourse-20261001-000000.mcbk',
      'medcourse-20261002-000000.mcbk',
      'medcourse-20261003-000000.mcbk',
      'medcourse-20261004-000000.mcbk',
      'notes.txt',
      'medcourse-20261001-000000.mcbk.partial',
    ];
    for (const name of names) {
      await writeFile(join(folder, name), 'x');
    }

    expect(await pruneBackups(folder, 2)).toEqual([
      'medcourse-20261001-000000.mcbk',
      'medcourse-20261002-000000.mcbk',
    ]);
    expect((await readdir(folder)).sort()).toEqual([
      'medcourse-20261001-000000.mcbk.partial',
      'medcourse-20261003-000000.mcbk',
      'medcourse-20261004-000000.mcbk',
      'notes.txt',
    ]);
    expect(await pruneBackups(folder, 5)).toEqual([]);
    await rm(folder, { recursive: true, force: true });
  });
});
