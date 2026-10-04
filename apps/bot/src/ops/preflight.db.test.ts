import { randomBytes } from 'node:crypto';
import { loadConfig, type Config } from '@medcourse/config';
import {
  createRepositories,
  createRepositoryDeps,
  loadMigrations,
  systemActor,
  type Migration,
} from '@medcourse/db';
import {
  MIGRATIONS_DIRECTORY,
  createTestDatabase,
  insertClinic,
  insertClinician,
  insertPatient,
  startRunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webhookPath } from '../telegram/webhook';
import {
  BACKUP_MAX_AGE_MS,
  MAX_PENDING_UPDATES,
  backupChecks,
  configChecks,
  formatCheck,
  preflightExitCode,
  runPreflight,
  telegramChecks,
  type Check,
  type PreflightApi,
} from './preflight';

/**
 * "Is this installation ready for patients?" (stage 15): each thing that must be true before a
 * patient is let in, checked on a real database and a Telegram that can be made to say anything.
 */

const KEY = (n: number): string => Buffer.alloc(32, n).toString('base64');
const TOKEN = `123456789:${'A'.repeat(35)}`;
const SECRET = 'webhook-secret-0123456789';
const PUBLIC = 'https://bot.clinic.example';
const PANEL = 'https://panel.clinic.example';
const NOW = new Date('2026-10-10T12:00:00Z');

/** A configuration as it should be on a server; each test spoils one thing. */
const GOOD_ENV: Record<string, string> = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://medcourse:x@db:5432/medcourse',
  ENCRYPTION_KEYS: `prod1:${KEY(1)}`,
  BACKUP_KEY: `backup1:${KEY(2)}`,
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_MODE: 'webhook',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  PUBLIC_BASE_URL: PUBLIC,
  PANEL_BASE_URL: PANEL,
  PANEL_TRUST_PROXY: 'true',
  METRICS_TOKEN: 'metrics-token-0123456789abcdef',
};
const configOf = (change: Record<string, string | undefined> = {}): Config =>
  loadConfig({ ...GOOD_ENV, ...change }, { defaultHttpPort: 3000 });

const of = (checks: readonly Check[], name: string): Check => {
  const found = checks.find((check) => check.name === name);
  if (found === undefined) {
    throw new Error(`no check named "${name}": ${checks.map((check) => check.name).join(', ')}`);
  }
  return found;
};

class Telegram implements PreflightApi {
  username: string | undefined = 'clinic_bot';
  url: string | undefined = `${PUBLIC}${webhookPath(SECRET)}`;
  pending = 0;
  lastError: string | undefined;
  down = false;
  webhookDown = false;
  getMe(): Promise<{ username?: string }> {
    if (this.down) {
      return Promise.reject(new Error(`https://api.telegram.org/bot${TOKEN}/getMe`));
    }
    return Promise.resolve(this.username === undefined ? {} : { username: this.username });
  }
  getWebhookInfo() {
    if (this.webhookDown) {
      return Promise.reject(new Error('timeout'));
    }
    return Promise.resolve({
      url: this.url,
      pending_update_count: this.pending,
      last_error_message: this.lastError,
    });
  }
}

describe('the settings', () => {
  it('are all in order on a server that is set up as it should be', () => {
    const checks = configChecks(configOf());
    expect(checks.map((check) => check.status)).toEqual(Array(checks.length).fill('ok'));
    expect(of(checks, 'telegram mode').detail).toBe('webhook at bot.clinic.example');
    expect(of(checks, 'backup key').detail).toContain('"backup1"');
  });

  it('fail on a developer’s machine: a throwaway key and plain http are not for patients', () => {
    const local = configChecks(
      loadConfig(
        {
          DATABASE_URL: GOOD_ENV.DATABASE_URL,
          ENCRYPTION_KEYS: `dev1:${KEY(1)}`,
          BACKUP_KEY: `devbackup:${KEY(2)}`,
          TELEGRAM_BOT_TOKEN: TOKEN,
          PANEL_BASE_URL: 'http://localhost:3002',
        },
        { defaultHttpPort: 3000 },
      ),
    );
    for (const name of [
      'environment',
      'encryption keys',
      'backup key',
      'telegram mode',
      'panel address',
    ]) {
      expect(of(local, name).status, name).toBe('fail');
    }
  });

  it('fail without a backup key or a bot token, and warn without the panel, the proxy or the metrics page', () => {
    const bare = configChecks(
      configOf({
        BACKUP_KEY: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_MODE: undefined,
        TELEGRAM_WEBHOOK_SECRET: undefined,
        PUBLIC_BASE_URL: undefined,
        PANEL_BASE_URL: undefined,
        PANEL_TRUST_PROXY: undefined,
        METRICS_TOKEN: undefined,
      }),
    );
    expect(of(bare, 'backup key').status).toBe('fail');
    expect(of(bare, 'telegram').status).toBe('fail');
    expect(of(bare, 'panel address').status).toBe('warn');
    expect(of(bare, 'panel proxy').status).toBe('warn');
    expect(of(bare, 'metrics').status).toBe('warn');
  });

  it('never say a secret: a name, a count, a host at most', () => {
    const text = [...configChecks(configOf()), ...configChecks(configOf({ BACKUP_KEY: undefined }))]
      .map(formatCheck)
      .join('\n');
    for (const secret of [
      TOKEN,
      SECRET,
      KEY(1),
      KEY(2),
      'metrics-token-0123456789abcdef',
      '123456789',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('Telegram', () => {
  it('knows the token, and sends updates to this installation’s own address', async () => {
    const checks = await telegramChecks(configOf(), new Telegram());
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ['bot', 'ok'],
      ['webhook', 'ok'],
      ['webhook errors', 'ok'],
      ['webhook backlog', 'ok'],
    ]);
    expect(of(checks, 'bot').detail).toBe('Telegram knows the token: @clinic_bot');
  });

  it('refuses the token: says so, and does not repeat the address the error carried', async () => {
    const telegram = new Telegram();
    telegram.down = true;
    const checks = await telegramChecks(configOf(), telegram);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('fail');
    const line = checks.map(formatCheck).join('\n');
    expect(line).not.toContain('api.telegram.org');
    expect(line).not.toContain(TOKEN);
  });

  it('fails when no webhook is set, or it points somewhere else, or Telegram cannot deliver', async () => {
    const telegram = new Telegram();
    telegram.url = '';
    expect(of(await telegramChecks(configOf(), telegram), 'webhook')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('no webhook is set') as string,
    });

    telegram.url = 'https://elsewhere.example/telegram/abc';
    expect(of(await telegramChecks(configOf(), telegram), 'webhook')).toMatchObject({
      status: 'fail',
      detail: 'Telegram sends updates elsewhere (elsewhere.example)',
    });

    telegram.url = `${PUBLIC}${webhookPath(SECRET)}`;
    telegram.lastError = 'Connection timed out';
    expect(of(await telegramChecks(configOf(), telegram), 'webhook errors')).toMatchObject({
      status: 'fail',
      detail: 'Telegram’s last delivery error: Connection timed out',
    });
  });

  it('fails when the webhook cannot be read from Telegram', async () => {
    const telegram = new Telegram();
    telegram.webhookDown = true;
    const checks = await telegramChecks(configOf(), telegram);
    expect(of(checks, 'webhook')).toEqual({
      name: 'webhook',
      status: 'fail',
      detail: 'the webhook could not be read from Telegram',
    });
  });

  it('warns when updates pile up, and not for a normal handful', async () => {
    const telegram = new Telegram();
    telegram.pending = MAX_PENDING_UPDATES;
    expect(of(await telegramChecks(configOf(), telegram), 'webhook backlog').status).toBe('ok');
    telegram.pending = MAX_PENDING_UPDATES + 1;
    expect(of(await telegramChecks(configOf(), telegram), 'webhook backlog').status).toBe('warn');
  });

  it('is skipped when offline, and silent when there is no token to ask with', async () => {
    expect(await telegramChecks(configOf(), null)).toEqual([
      { name: 'telegram', status: 'skip', detail: 'not asked (offline)' },
    ]);
    expect(
      await telegramChecks(
        configOf({
          TELEGRAM_BOT_TOKEN: undefined,
          TELEGRAM_MODE: undefined,
          TELEGRAM_WEBHOOK_SECRET: undefined,
          PUBLIC_BASE_URL: undefined,
        }),
        new Telegram(),
      ),
    ).toEqual([]);
  });

  it('does not look for a webhook when the bot polls', async () => {
    const polling = loadConfig(
      {
        DATABASE_URL: GOOD_ENV.DATABASE_URL,
        ENCRYPTION_KEYS: `dev1:${KEY(1)}`,
        TELEGRAM_BOT_TOKEN: TOKEN,
      },
      { defaultHttpPort: 3000 },
    );
    expect((await telegramChecks(polling, new Telegram())).map((check) => check.name)).toEqual([
      'bot',
    ]);
  });
});

describe('the verdict', () => {
  const check = (status: Check['status']): Check => ({ name: status, status, detail: '' });

  it('is "go" with warnings and skipped checks, and "no go" with a single failure', () => {
    expect(preflightExitCode([])).toBe(0);
    expect(preflightExitCode([check('ok'), check('warn'), check('skip')])).toBe(0);
    expect(preflightExitCode([check('ok'), check('fail'), check('warn')])).toBe(1);
    expect(preflightExitCode([check('fail')])).toBe(1);
  });
});

describe('the backups', () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);

  it('are fine while the newest is from the last day, however many there are', () => {
    expect(
      backupChecks(
        [
          { name: 'a', writtenAt: at(60) },
          { name: 'b', writtenAt: at(3) },
        ],
        NOW,
      ),
    ).toEqual([{ name: 'backups', status: 'ok', detail: 'the newest is 3 hour(s) old' }]);
    expect(
      backupChecks([{ name: 'a', writtenAt: new Date(NOW.getTime() - BACKUP_MAX_AGE_MS) }], NOW)[0]
        ?.status,
    ).toBe('ok');
  });

  it('fail when the newest is older than that, or there is none', () => {
    expect(
      backupChecks(
        [{ name: 'a', writtenAt: new Date(NOW.getTime() - BACKUP_MAX_AGE_MS - 1) }],
        NOW,
      )[0],
    ).toMatchObject({
      status: 'fail',
      detail: 'the newest is 26 hours old: the daily backup is not running',
    });
    expect(backupChecks([], NOW)[0]).toMatchObject({
      status: 'fail',
      detail: 'there is no backup in the directory',
    });
  });

  it('are skipped when nobody said where they are', () => {
    expect(backupChecks(null, NOW)[0]?.status).toBe('skip');
  });
});

describe('the database', () => {
  let testDatabase: TestDatabase;
  let migrations: Migration[];
  const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  const system = systemActor('preflight test');
  const run = (
    change: Record<string, string | undefined> = {},
    api: PreflightApi | null = new Telegram(),
  ) =>
    runPreflight({
      config: configOf(change),
      sql: testDatabase.db.sql,
      api,
      migrations,
      backups: [
        { name: 'medcourse-20261010-060000.mcbk', writtenAt: new Date(NOW.getTime() - 3_600_000) },
      ],
      now: NOW,
    });

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
  });
  afterAll(async () => {
    await testDatabase.drop();
  });

  it('is not ready while nobody runs it: no administrator, and says how to make one', async () => {
    const checks = await run();
    expect(of(checks, 'database').status).toBe('ok');
    expect(of(checks, 'schema')).toMatchObject({
      status: 'ok',
      detail: `all ${String(migrations.length)} migrations applied, checksums match`,
    });
    expect(of(checks, 'administrator')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('grant-admin') as string,
    });
    expect(of(checks, 'doctors').status).toBe('warn');
    expect(preflightExitCode(checks)).toBe(1);
  });

  it('is ready once there is an administrator and a verified doctor, and nothing is late', async () => {
    const repos = createRepositories(testDatabase.db.orm, repositoryDeps);
    const adminId = await insertPatient(testDatabase.db.sql);
    await repos.platform.grantTechAdmin(system, adminId);
    await insertClinician(testDatabase.db.sql, await insertClinic(testDatabase.db.sql));

    const checks = await run();

    expect(of(checks, 'administrator').status).toBe('ok');
    expect(of(checks, 'doctors').detail).toBe('1 verified, 0 waiting');
    expect(of(checks, 'queue').status).toBe('ok');
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(preflightExitCode(checks)).toBe(0);
    expect(checks.map(formatCheck).every((line) => /^\[( ok |warn|FAIL|skip)\] /.test(line))).toBe(
      true,
    );
  });

  it('is not ready without an administrator who is still active, nor a doctor who is verified', async () => {
    const sql = testDatabase.db.sql;
    await sql`update platform_staff set status = 'REVOKED'`;
    await sql`update clinician_profiles set verification_status = 'REVOKED'`;
    try {
      const checks = await run();
      expect(of(checks, 'administrator').status).toBe('fail');
      expect(of(checks, 'doctors')).toMatchObject({
        status: 'warn',
        detail: 'no verified doctor yet (0 waiting)',
      });
    } finally {
      await sql`update platform_staff set status = 'ACTIVE'`;
      await sql`update clinician_profiles set verification_status = 'VERIFIED'`;
    }
  });

  it('counts a doctor who is waiting for verification as waiting, not as verified', async () => {
    const sql = testDatabase.db.sql;
    await sql`update clinician_profiles set verification_status = 'PENDING'`;
    try {
      expect(of(await run(), 'doctors')).toMatchObject({
        status: 'warn',
        detail: 'no verified doctor yet (1 waiting)',
      });
    } finally {
      await sql`update clinician_profiles set verification_status = 'VERIFIED'`;
    }
  });

  describe('the queue', () => {
    const TEN_MINUTES = 10 * 60_000;
    let courseId: string;
    beforeAll(async () => {
      const repos = createRepositories(testDatabase.db.orm, repositoryDeps);
      courseId = (await startRunningCourse(testDatabase.db.sql, repos)).courseId;
    });
    // One reminder of the course is made the only live one, with the given state; the rest are cancelled.
    const only = async (status: 'QUEUED' | 'SENDING', at: Date): Promise<void> => {
      const sql = testDatabase.db.sql;
      await sql`update notifications set status = 'CANCELLED', locked_until = null where course_id = ${courseId}`;
      await sql`
        update notifications
        set status = ${status}, due_at = ${at}, locked_until = ${status === 'SENDING' ? at : null}
        where id = (select id from notifications where course_id = ${courseId} order by id limit 1)`;
    };
    afterAll(async () => {
      await testDatabase.db
        .sql`update notifications set status = 'CANCELLED', locked_until = null where course_id = ${courseId}`;
    });

    it('is fine for a reminder that is exactly ten minutes late, and not for one a second later', async () => {
      await only('QUEUED', new Date(NOW.getTime() - TEN_MINUTES));
      expect(of(await run(), 'queue').status).toBe('ok');

      await only('QUEUED', new Date(NOW.getTime() - TEN_MINUTES - 1000));
      const checks = await run();
      expect(of(checks, 'queue')).toMatchObject({
        status: 'fail',
        detail: '1 reminder(s) are over ten minutes late, 0 stuck: is the worker running?',
      });
      expect(preflightExitCode(checks)).toBe(1);
    });

    it('is not fine for a reminder that a worker took and never finished', async () => {
      await only('SENDING', new Date(NOW.getTime() - TEN_MINUTES - 1000));
      expect(of(await run(), 'queue')).toMatchObject({
        status: 'fail',
        detail: '0 reminder(s) are over ten minutes late, 1 stuck: is the worker running?',
      });

      await only('SENDING', new Date(NOW.getTime() - TEN_MINUTES));
      expect(of(await run(), 'queue').status).toBe('ok');
    });
  });

  it('is not ready when the database is not in UTF-8: names and reports would break', async () => {
    const latin = await createTestDatabase({ migrate: false, encoding: 'LATIN1' });
    try {
      const checks = await runPreflight({
        config: configOf(),
        sql: latin.db.sql,
        api: null,
        migrations,
        backups: null,
        now: NOW,
      });
      expect(of(checks, 'database')).toEqual({
        name: 'database',
        status: 'fail',
        detail: 'encoding is LATIN1, not UTF8',
      });
    } finally {
      await latin.drop();
    }
  });

  it('is not ready while a migration is waiting, and names it', async () => {
    const last = migrations.at(-1);
    await testDatabase.db.sql`delete from schema_migrations where id = ${last?.id ?? ''}`;
    try {
      const checks = await run();
      expect(of(checks, 'schema')).toMatchObject({
        status: 'fail',
        detail: `not applied yet: ${last?.id ?? ''} (node ops.cjs migrate up)`,
      });
    } finally {
      await testDatabase.db.sql`
        insert into schema_migrations (id, checksum) values (${last?.id ?? ''}, ${last?.checksum ?? ''})`;
    }
  });

  it('is not ready when the migrations on disk are not the ones the database was built with', async () => {
    const first = migrations[0];
    const changed = migrations.map((migration, index) =>
      index === 0 ? { ...migration, checksum: 'f'.repeat(64) } : migration,
    );
    const checks = await runPreflight({
      config: configOf(),
      sql: testDatabase.db.sql,
      api: null,
      migrations: changed,
      backups: null,
      now: NOW,
    });
    expect(of(checks, 'schema').status).toBe('fail');
    expect(of(checks, 'schema').detail).toContain(first?.id ?? '');
    // The checks after it are not run on a schema that cannot be trusted.
    expect(checks.map((check) => check.name)).not.toContain('administrator');
  });

  it('says plainly when the database does not answer, and goes no further with it', async () => {
    const checks = await runPreflight({
      config: configOf(),
      sql: ((): never => {
        throw new Error('postgres://medcourse:secret@db/medcourse refused');
      }) as never,
      api: null,
      migrations,
      backups: null,
      now: NOW,
    });
    expect(of(checks, 'database')).toEqual({
      name: 'database',
      status: 'fail',
      detail: 'does not answer',
    });
    expect(checks.map(formatCheck).join('\n')).not.toContain('secret');
  });

  it('puts the settings first, then Telegram, then the database, then the backups', async () => {
    const names = (await run()).map((check) => check.name);
    expect(names.indexOf('environment')).toBeLessThan(names.indexOf('bot'));
    expect(names.indexOf('bot')).toBeLessThan(names.indexOf('database'));
    expect(names.indexOf('database')).toBeLessThan(names.indexOf('backups'));
  });
});
