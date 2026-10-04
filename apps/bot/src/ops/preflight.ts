import type { Config } from '@medcourse/config';
import { migrationStatus, type Database, type Migration } from '@medcourse/db';
import { webhookPath } from '../telegram/webhook';

/**
 * Is this installation ready for real people? (TZ §16 "проверка конфигурации", §20.) One line per
 * thing that has to be true before a patient is let in, each saying ok, warn (go in knowingly),
 * fail (do not go in) or skip. Nothing here changes anything, and no line carries a secret: a
 * name of a variable, a count, a host name at most.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** What Telegram says about the bot and its webhook. */
type Sql = Database['sql'];

export interface PreflightApi {
  getMe(): Promise<{ readonly username?: string }>;
  getWebhookInfo(): Promise<{
    readonly url?: string | undefined;
    readonly pending_update_count: number;
    readonly last_error_message?: string | undefined;
  }>;
}

export interface PreflightDeps {
  readonly config: Config;
  readonly sql: Sql;
  /** Null when no bot token is configured, or when only the offline checks are wanted. */
  readonly api: PreflightApi | null;
  readonly migrations: readonly Migration[];
  /** Files of the directory the backups go to, with when each was written; null: not asked about. */
  readonly backups: readonly { readonly name: string; readonly writtenAt: Date }[] | null;
  readonly now: Date;
}

/** A backup older than this means the daily one did not happen. */
export const BACKUP_MAX_AGE_MS = 26 * 3_600_000;
/** Updates waiting at Telegram for the bot: more than this means the bot is not keeping up. */
export const MAX_PENDING_UPDATES = 100;

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail });
const warn = (name: string, detail: string): Check => ({ name, status: 'warn', detail });
const fail = (name: string, detail: string): Check => ({ name, status: 'fail', detail });
const skip = (name: string, detail: string): Check => ({ name, status: 'skip', detail });

/** The settings: the part that needs no network and no database. */
export function configChecks(config: Config): Check[] {
  const checks: Check[] = [];
  checks.push(
    config.appEnv === 'local'
      ? fail('environment', 'APP_ENV=local: throwaway keys and plain http are allowed here')
      : ok('environment', `APP_ENV=${config.appEnv}`),
  );
  checks.push(
    config.encryptionKeys.some((key) => key.id.startsWith('dev'))
      ? fail('encryption keys', 'a key whose id starts with "dev" is a throwaway key')
      : ok('encryption keys', `${String(config.encryptionKeys.length)} key(s), none a throwaway`),
  );
  checks.push(
    config.backupKey === null
      ? fail('backup key', 'BACKUP_KEY is not set: no backup can be made')
      : config.backupKey.id.startsWith('dev')
        ? fail('backup key', 'the backup key is a throwaway key')
        : ok('backup key', `set, id "${config.backupKey.id}", not one of the field keys`),
  );
  if (config.telegram === null) {
    checks.push(fail('telegram', 'TELEGRAM_BOT_TOKEN is not set'));
  } else if (config.telegram.mode !== 'webhook') {
    checks.push(
      fail('telegram mode', 'polling is for a developer’s machine; a server uses a webhook'),
    );
  } else {
    checks.push(ok('telegram mode', `webhook at ${new URL(config.telegram.publicBaseUrl).host}`));
  }
  checks.push(
    config.panelBaseUrl === null
      ? warn('panel address', 'PANEL_BASE_URL is not set: staff cannot sign in to the panel')
      : config.panelBaseUrl.startsWith('https://')
        ? ok('panel address', `https, ${new URL(config.panelBaseUrl).host}`)
        : fail(
            'panel address',
            'the panel is not on https: a session cookie would travel in the clear',
          ),
  );
  checks.push(
    config.panelTrustProxy
      ? ok('panel proxy', 'PANEL_TRUST_PROXY=true: callers are told apart by the proxy’s header')
      : warn(
          'panel proxy',
          'PANEL_TRUST_PROXY is not true: behind a proxy every caller looks like one address, and shares one limit',
        ),
  );
  checks.push(
    config.metricsToken === null
      ? warn(
          'metrics',
          'METRICS_TOKEN is not set: there is no /metrics page, nothing watches the queues',
        )
      : ok('metrics', 'the /metrics page is on, behind a token'),
  );
  return checks;
}

/** What Telegram thinks of the bot: it is who we say, and it knows where to send the updates. */
export async function telegramChecks(config: Config, api: PreflightApi | null): Promise<Check[]> {
  if (config.telegram === null) {
    return [];
  }
  if (api === null) {
    return [skip('telegram', 'not asked (offline)')];
  }
  const checks: Check[] = [];
  try {
    const me = await api.getMe();
    checks.push(ok('bot', `Telegram knows the token: @${me.username ?? '(no username)'}`));
  } catch {
    // The reason is not printed: an HTTP error can carry the request address, which holds the token.
    return [fail('bot', 'Telegram does not accept the token, or cannot be reached')];
  }
  if (config.telegram.mode !== 'webhook') {
    return checks;
  }
  try {
    const info = await api.getWebhookInfo();
    const expected = `${config.telegram.publicBaseUrl}${webhookPath(config.telegram.webhookSecret)}`;
    checks.push(
      info.url === expected
        ? ok('webhook', 'Telegram sends updates to this installation’s address')
        : (info.url ?? '') === ''
          ? fail('webhook', 'no webhook is set: start the bot, it sets it on start')
          : fail('webhook', `Telegram sends updates elsewhere (${new URL(info.url ?? '').host})`),
    );
    checks.push(
      info.last_error_message === undefined
        ? ok('webhook errors', 'Telegram reports no delivery error')
        : fail('webhook errors', `Telegram’s last delivery error: ${info.last_error_message}`),
    );
    checks.push(
      info.pending_update_count <= MAX_PENDING_UPDATES
        ? ok('webhook backlog', `${String(info.pending_update_count)} update(s) waiting`)
        : warn(
            'webhook backlog',
            `${String(info.pending_update_count)} updates are waiting at Telegram`,
          ),
    );
  } catch {
    checks.push(fail('webhook', 'the webhook could not be read from Telegram'));
  }
  return checks;
}

/** The database: it answers, is in UTF-8, is at the schema of this version, has somebody to run it. */
export async function databaseChecks(
  sql: Sql,
  migrations: readonly Migration[],
  now: Date,
): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const [encoding] = await sql<{ server_encoding: string }[]>`show server_encoding`;
    checks.push(
      encoding?.server_encoding === 'UTF8'
        ? ok('database', 'answers, encoding UTF8')
        : fail('database', `encoding is ${encoding?.server_encoding ?? 'unknown'}, not UTF8`),
    );
  } catch {
    return [fail('database', 'does not answer')];
  }
  try {
    const status = await migrationStatus(sql, migrations);
    const pending = status.filter(({ state }) => state === 'pending').map(({ id }) => id);
    checks.push(
      pending.length === 0
        ? ok('schema', `all ${String(status.length)} migrations applied, checksums match`)
        : fail('schema', `not applied yet: ${pending.join(', ')} (node ops.cjs migrate up)`),
    );
  } catch (error) {
    checks.push(
      fail(
        'schema',
        error instanceof Error ? error.message : 'the migrations do not match the database',
      ),
    );
    return checks;
  }
  const [staff] = await sql<{ admins: number; doctors: number; pending: number }[]>`
    select
      (select count(*) from platform_staff where status = 'ACTIVE' and role = 'TECH_ADMIN')::int as admins,
      (select count(*) from clinician_profiles where verification_status = 'VERIFIED')::int as doctors,
      (select count(*) from clinician_profiles where verification_status = 'PENDING')::int as pending`;
  checks.push(
    (staff?.admins ?? 0) > 0
      ? ok('administrator', `${String(staff?.admins ?? 0)} active technical administrator(s)`)
      : fail('administrator', 'there is none: node admin.cjs grant-admin <telegram-id>'),
  );
  checks.push(
    (staff?.doctors ?? 0) > 0
      ? ok(
          'doctors',
          `${String(staff?.doctors ?? 0)} verified, ${String(staff?.pending ?? 0)} waiting`,
        )
      : warn('doctors', `no verified doctor yet (${String(staff?.pending ?? 0)} waiting)`),
  );
  const late = new Date(now.getTime() - 10 * 60_000);
  const [queue] = await sql<{ overdue: number; stuck: number }[]>`
    select
      (select count(*) from notifications where status = 'QUEUED' and due_at < ${late})::int as overdue,
      (select count(*) from notifications where status = 'SENDING' and locked_until < ${late})::int as stuck`;
  checks.push(
    (queue?.overdue ?? 0) === 0 && (queue?.stuck ?? 0) === 0
      ? ok('queue', 'no reminder is late or stuck')
      : fail(
          'queue',
          `${String(queue?.overdue ?? 0)} reminder(s) are over ten minutes late, ${String(queue?.stuck ?? 0)} stuck: is the worker running?`,
        ),
  );
  return checks;
}

/** The backups: there is one, and it is from the last day. */
export function backupChecks(files: PreflightDeps['backups'], now: Date): Check[] {
  if (files === null) {
    return [skip('backups', 'no backup directory given (--backups <dir>)')];
  }
  const newest = [...files].sort((a, b) => b.writtenAt.getTime() - a.writtenAt.getTime())[0];
  if (newest === undefined) {
    return [fail('backups', 'there is no backup in the directory')];
  }
  const ageHours = Math.floor((now.getTime() - newest.writtenAt.getTime()) / 3_600_000);
  return [
    now.getTime() - newest.writtenAt.getTime() <= BACKUP_MAX_AGE_MS
      ? ok('backups', `the newest is ${String(ageHours)} hour(s) old`)
      : fail(
          'backups',
          `the newest is ${String(ageHours)} hours old: the daily backup is not running`,
        ),
  ];
}

export async function runPreflight(deps: PreflightDeps): Promise<Check[]> {
  return [
    ...configChecks(deps.config),
    ...(await telegramChecks(deps.config, deps.api)),
    ...(await databaseChecks(deps.sql, deps.migrations, deps.now)),
    ...backupChecks(deps.backups, deps.now),
  ];
}

/** 0 when nothing failed (warnings are the operator's to weigh), 1 otherwise. */
export function preflightExitCode(checks: readonly Check[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

export function formatCheck(check: Check): string {
  const mark = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]', skip: '[skip]' }[check.status];
  return `${mark} ${check.name}: ${check.detail}`;
}
