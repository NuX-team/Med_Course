import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '@medcourse/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIRECTORY, createTestDatabase, type TestDatabase } from '../test/helpers';
import { startRunningCourse } from '../test/running-course';
import { inspectBackup } from './backup';
import { loadMigrations, type Migration } from './migrate';
import { createRepositories, createRepositoryDeps } from './repositories';
import { runBackupCommand, runMigrateCommand } from './ops';

/**
 * The operator's commands (stage 15): the ones the server image runs as `node ops.cjs …` and a
 * developer as `pnpm db:*`. Each is run on a real database and what it says is read, because what
 * it says is what a person at a server at night acts on.
 */

const KEY = (n: number): string => Buffer.alloc(32, n).toString('base64');
const FIELD_KEYS = `t:${KEY(7)}`;
const BACKUP_KEY = `ops-backup:${KEY(9)}`;

let source: TestDatabase;
let directory: string;
let migrations: Migration[];
const scratch: TestDatabase[] = [];

const configFor = (url: string, change: Record<string, string | undefined> = {}): Config =>
  loadConfig(
    {
      DATABASE_URL: url,
      ENCRYPTION_KEYS: FIELD_KEYS,
      BACKUP_KEY,
      ...change,
    },
    { defaultHttpPort: 3000, receivesUpdates: false },
  );

const PRODUCTION = {
  APP_ENV: 'production',
  ENCRYPTION_KEYS: `prod1:${KEY(7)}`,
  BACKUP_KEY: `ops-backup:${KEY(9)}`,
};

/** Runs a command, returning what it said and its exit code. */
async function say(
  run: (
    argv: readonly string[],
    context: Parameters<typeof runMigrateCommand>[1],
  ) => Promise<number>,
  argv: readonly string[],
  config: Config,
): Promise<{ code: number; lines: string[]; text: string }> {
  const lines: string[] = [];
  const code = await run(argv, {
    config,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    out: (line) => lines.push(line),
  });
  return { code, lines, text: lines.join('\n') };
}
const migrate = (argv: string[], config: Config) => say(runMigrateCommand, argv, config);
const backup = (argv: string[], config: Config) => say(runBackupCommand, argv, config);

async function emptyDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrate: false });
  scratch.push(database);
  return database;
}

const tableCount = async (database: TestDatabase): Promise<number> => {
  const [row] = await database.db.sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
  return row?.n ?? 0;
};

beforeAll(async () => {
  source = await createTestDatabase();
  migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
  directory = await mkdtemp(join(tmpdir(), 'medcourse-ops-'));
  // Something with an encrypted field in it, so that "can the backup be read" has an answer.
  const repos = createRepositories(
    source.db.orm,
    createRepositoryDeps([{ id: 't', key: Buffer.alloc(32, 7) }]),
  );
  await startRunningCourse(source.db.sql, repos, {
    medications: [{ instructions: 'запивать тёплой водой' }],
  });
});

afterAll(async () => {
  for (const database of [source, ...scratch]) {
    await database.drop();
  }
  await rm(directory, { recursive: true, force: true });
});

describe('migrate', () => {
  it('lists every migration, marked applied or waiting, and status is what no word means', async () => {
    const database = await emptyDatabase();
    const config = configFor(database.url);

    const before = await migrate(['status'], config);
    expect(before.code).toBe(0);
    expect(before.lines).toEqual(migrations.map(({ id }) => `[ ] ${id}`));

    expect((await migrate([], config)).lines).toEqual(before.lines);
  });

  it('applies what is waiting, says which, and says "nothing" the second time', async () => {
    const database = await emptyDatabase();
    const config = configFor(database.url);

    const first = await migrate(['up'], config);
    expect(first.code).toBe(0);
    expect(first.text).toBe(`applied: ${migrations.map(({ id }) => id).join(', ')}`);
    expect(await tableCount(database)).toBeGreaterThan(30);

    const second = await migrate(['up'], config);
    expect(second.code).toBe(0);
    expect(second.text).toBe('nothing to apply');
    expect((await migrate(['status'], config)).lines.every((line) => line.startsWith('[x] '))).toBe(
      true,
    );
  });

  it('rolls back the steps asked for, one by default, and says which', async () => {
    const database = await emptyDatabase();
    const config = configFor(database.url);
    await migrate(['up'], config);
    const ids = migrations.map(({ id }) => id);

    const one = await migrate(['down'], config);
    expect(one).toMatchObject({ code: 0, text: `reverted: ${ids.at(-1) ?? ''}` });

    const two = await migrate(['down', '2'], config);
    expect(two.text).toBe(`reverted: ${ids.slice(-3, -1).reverse().join(', ')}`);
    expect(
      (await migrate(['status'], config)).lines.filter((line) => line.startsWith('[ ] ')),
    ).toHaveLength(3);

    await migrate(['up'], config);
    for (const bad of ['0', '-1', '1.5', 'all']) {
      expect(await migrate(['down', bad], config), bad).toMatchObject({
        code: 2,
        text: 'down takes a whole number of migrations to roll back, at least 1',
      });
    }
    expect((await migrate(['status'], config)).lines.every((line) => line.startsWith('[x] '))).toBe(
      true,
    );
  });

  it('never rolls back with APP_ENV=production: the data is not given back by a down script', async () => {
    const database = await emptyDatabase();
    await migrate(['up'], configFor(database.url));
    const production = configFor(database.url, PRODUCTION);

    const refused = await migrate(['down'], production);

    expect(refused.code).toBe(1);
    expect(refused.text).toContain('production only moves forward');
    expect(
      (await migrate(['status'], production)).lines.every((line) => line.startsWith('[x] ')),
    ).toBe(true);
  });

  it('refuses a word it does not know, and still goes forward in production', async () => {
    const database = await emptyDatabase();
    const config = configFor(database.url);
    expect(await migrate(['sideways'], config)).toMatchObject({
      code: 1,
      text: 'unknown command "sideways". Use: up | down [steps] | status',
    });
    expect((await migrate(['up'], configFor(database.url, PRODUCTION))).code).toBe(0);
  });
});

describe('backup', () => {
  it('writes a file that opens with the key, says what is in it, and leaves the database as it was', async () => {
    const target = join(directory, 'first');
    const before = await tableCount(source);

    const result = await backup(['backup', target], configFor(source.url));

    expect(result.code).toBe(0);
    const files = await readdir(target);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^medcourse-\d{8}-\d{6}\.mcbk$/);
    expect(result.text).toMatch(
      new RegExp(
        `^written: .*${files[0] ?? ''} \\(\\d+ bytes, \\d+ tables, \\d+ rows, key "ops-backup"\\)$`,
      ),
    );
    const manifest = await inspectBackup(join(target, files[0] ?? ''), [
      { id: 'ops-backup', key: Buffer.alloc(32, 9) },
    ]);
    expect(Object.keys(manifest.tables).length).toBeGreaterThan(30);
    expect(await tableCount(source)).toBe(before);
  });

  it('keeps the newest n and removes the older ones, and no other file', async () => {
    const target = join(directory, 'kept');
    await mkdir(target);
    for (const name of [
      'medcourse-20200101-000000.mcbk',
      'medcourse-20200102-000000.mcbk',
      'medcourse-20200103-000000.mcbk',
    ]) {
      await writeFile(join(target, name), 'old');
    }
    await writeFile(join(target, 'notes.txt'), 'not a backup');

    const result = await backup(['backup', target, '--keep', '2'], configFor(source.url));

    expect(result.lines.at(-1)).toBe('removed 2 older backup(s)');
    const left = await readdir(target);
    expect(left).toHaveLength(3);
    expect(left).toContain('notes.txt');
    expect(left).toContain('medcourse-20200103-000000.mcbk');
    expect(left.filter((name) => name.startsWith('medcourse-2026'))).toHaveLength(1);
  });

  it('refuses a number of files to keep that is not a whole number of at least 1, before writing anything', async () => {
    for (const bad of ['0', '-1', '1.5', 'many']) {
      const target = join(directory, `bad-${bad}`);
      const result = await backup(['backup', target, '--keep', bad], configFor(source.url));
      expect(result, bad).toMatchObject({
        code: 2,
        text: '--keep takes a whole number of files, at least 1',
      });
      await expect(readdir(target)).rejects.toThrow();
    }
  });

  it('asks for the key when there is none, and tells what is missing without a value', async () => {
    const result = await backup(
      ['backup', join(directory, 'nokey')],
      configFor(source.url, { BACKUP_KEY: undefined }),
    );
    expect(result.code).toBe(1);
    expect(result.text).toContain('BACKUP_KEY: required for backups');
    await expect(readdir(join(directory, 'nokey'))).rejects.toThrow();
  });

  it('says how to use it when it is not told what to do, or what to do it with', async () => {
    const config = configFor(source.url);
    for (const argv of [[], ['backup']]) {
      expect(await backup(argv, config)).toMatchObject({
        code: 2,
        text: 'usage: backup <directory> [--keep <n>] | restore <file> | drill <file>',
      });
    }
    expect(await backup(['rewind', 'x'], config)).toMatchObject({
      code: 2,
      text: 'unknown command "rewind". Use: backup | restore | drill',
    });
  });
});

describe('restore', () => {
  let file: string;
  beforeAll(async () => {
    const target = join(directory, 'for-restore');
    await backup(['backup', target], configFor(source.url));
    file = join(target, (await readdir(target))[0] ?? '');
  });

  it('fills an empty database, and says every table matches', async () => {
    const database = await emptyDatabase();

    const result = await backup(['restore', file], configFor(database.url));

    expect(result.code).toBe(0);
    expect(result.lines.at(-1)).toMatch(/^restored the backup of 20\d\d-.*: every table matches$/);
    expect(await tableCount(database)).toBe(await tableCount(source));
  });

  it('refuses a database that already has something in it, and says so', async () => {
    const result = await backup(['restore', file], configFor(source.url));
    expect(result.code).toBe(1);
    expect(result.text).toMatch(/^refused: /);
  });

  it('wants to be told twice in production, and then does it', async () => {
    const database = await emptyDatabase();
    const production = configFor(database.url, PRODUCTION);

    const refused = await backup(['restore', file], production);
    expect(refused).toMatchObject({
      code: 1,
      text: 'refusing to restore with APP_ENV=production without --yes-this-is-production',
    });
    expect(await tableCount(database)).toBe(0);

    const done = await backup(['restore', file, '--yes-this-is-production'], production);
    expect(done.code).toBe(0);
    expect(await tableCount(database)).toBeGreaterThan(30);
  });

  it('says there are problems, shows them and fails when what came back is not what went in', async () => {
    const database = await emptyDatabase();
    // A database that quietly swallows what is put into one table (a trigger that fires even in a restore):
    // the restore runs, the rows do not arrive.
    await database.db.sql.unsafe(`
      create function swallow() returns trigger language plpgsql as $$ begin return null; end $$`);
    await database.db.sql.unsafe(`
      create function swallow_clinics() returns event_trigger language plpgsql as $$
      begin
        if exists (select 1 from pg_event_trigger_ddl_commands() where object_identity = 'public.clinics') then
          execute 'create trigger swallow before insert on public.clinics for each row execute function swallow()';
          -- ALWAYS: it fires even when the restore switches ordinary triggers off.
          execute 'alter table public.clinics enable always trigger swallow';
        end if;
      end $$`);
    await database.db.sql.unsafe(
      `create event trigger swallow on ddl_command_end when tag in ('CREATE TABLE') execute function swallow_clinics()`,
    );

    const result = await backup(['restore', file], configFor(database.url));

    expect(result.code).toBe(1);
    expect(result.lines.some((line) => line.startsWith('PROBLEM: clinics'))).toBe(true);
    expect(result.lines.at(-1)).toBe(
      'the restore finished with problems: do not use this database',
    );
  });

  it('refuses a backup sealed with another key', async () => {
    const database = await emptyDatabase();
    const result = await backup(
      ['restore', file],
      configFor(database.url, { BACKUP_KEY: `other:${KEY(3)}` }),
    );
    expect(result.code).toBe(1);
    expect(result.text).toMatch(/^refused: /);
    expect(await tableCount(database)).toBe(0);
  });
});

describe('drill', () => {
  let file: string;
  beforeAll(async () => {
    const target = join(directory, 'for-drill');
    await backup(['backup', target], configFor(source.url));
    file = join(target, (await readdir(target))[0] ?? '');
  });

  const scratchDatabases = async (): Promise<string[]> =>
    (
      await source.db.sql<{ datname: string }[]>`
        select datname from pg_database where datname like 'medcourse_drill_%'`
    ).map(({ datname }) => datname);

  it('restores into a scratch database, compares, reads an encrypted field, and drops it', async () => {
    const result = await backup(['drill', file], configFor(source.url));

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/^backup of 20\d\d-.*: \d+ tables, \d+ rows$/);
    expect(result.lines).toContain(
      'restored into a scratch database and compared: every table matches',
    );
    expect(result.lines).toContain(
      'encrypted fields readable with the current ENCRYPTION_KEYS: ok',
    );
    expect(result.lines.at(-1)).toBe('the scratch database was dropped');
    expect(await scratchDatabases()).toEqual([]);
  });

  it('fails, and says so, when the keys in hand do not open the data in the backup', async () => {
    const result = await backup(
      ['drill', file],
      configFor(source.url, { ENCRYPTION_KEYS: `wrong:${KEY(5)}` }),
    );

    expect(result.code).toBe(1);
    expect(result.lines).toContain(
      'encrypted fields readable with the current ENCRYPTION_KEYS: CANNOT DECRYPT',
    );
    expect(await scratchDatabases()).toEqual([]);
  });

  it('is refused before a database is made, when the file is not ours or the key is wrong', async () => {
    const wrong = await backup(
      ['drill', file],
      configFor(source.url, { BACKUP_KEY: `other:${KEY(3)}` }),
    );
    expect(wrong.code).toBe(1);
    expect(wrong.text).toMatch(/^refused: /);

    const junk = join(directory, 'junk.mcbk');
    await writeFile(junk, 'this is not a backup');
    expect((await backup(['drill', junk], configFor(source.url))).code).toBe(1);

    expect(await scratchDatabases()).toEqual([]);
  });
});
