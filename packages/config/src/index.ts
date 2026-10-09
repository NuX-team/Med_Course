import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

function isPostgresUrl(value: string): boolean {
  try {
    return POSTGRES_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** One key of the application-level encryption ring (see packages/db field cipher). */
export interface EncryptionKey {
  readonly id: string;
  readonly key: Uint8Array;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;
/** Key ids with this prefix are throwaway local keys, committed to .env.example. */
const DEV_KEY_PREFIX = 'dev';

type ParsedKeys = { ok: true; keys: EncryptionKey[] } | { ok: false; error: string };

/**
 * `ENCRYPTION_KEYS="id1:base64,id2:base64"`. The first key encrypts, all of them decrypt,
 * so a key is rotated by prepending a new one. Error text never contains key material.
 */
function parseEncryptionKeys(raw: string): ParsedKeys {
  const keys: EncryptionKey[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();

    if (separator < 0 || !KEY_ID_PATTERN.test(id)) {
      return { ok: false, error: 'each entry must look like <id>:<base64 key>' };
    }
    if (seen.has(id)) {
      return { ok: false, error: `key id "${id}" is listed twice` };
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      return { ok: false, error: `key "${id}" must be ${String(KEY_BYTES)} bytes in base64` };
    }
    seen.add(id);
    keys.push({ id, key: new Uint8Array(key) });
  }

  return { ok: true, keys };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol, pathname, search, hash } = new URL(value);
    // An origin only: the panel builds its own paths.
    return (
      (protocol === 'https:' || protocol === 'http:') &&
      (pathname === '/' || pathname === '') &&
      search === '' &&
      hash === ''
    );
  } catch {
    return false;
  }
}

/** How the bot receives updates: Telegram pushes them (webhook) or the bot asks (polling). */
export type TelegramMode = 'polling' | 'webhook';

export type TelegramConfig =
  | { readonly mode: 'polling'; readonly botToken: string }
  | {
      readonly mode: 'webhook';
      readonly botToken: string;
      /** Sent by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
      readonly webhookSecret: string;
      /** HTTPS origin Telegram can reach, with no trailing path. */
      readonly publicBaseUrl: string;
    };

/**
 * `receivesUpdates` is true for the bot, which needs to know how updates reach it (webhook or
 * polling), and false for a process that only sends messages and so needs the token alone.
 */
const buildEnvSchema = (receivesUpdates: boolean) =>
  z
    .object({
      APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
      LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
      DATABASE_URL: z.string().refine(isPostgresUrl, {
        message: 'must be a postgres:// or postgresql:// URL',
      }),
      HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
      ENCRYPTION_KEYS: z.string().superRefine((value, ctx) => {
        const parsed = parseEncryptionKeys(value);
        if (!parsed.ok) {
          ctx.addIssue({ code: 'custom', message: parsed.error });
        }
      }),
      TELEGRAM_BOT_TOKEN: z
        .string()
        .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'does not look like a bot token (<digits>:<letters>)')
        .optional(),
      TELEGRAM_WEBHOOK_SECRET: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 characters from A-Z a-z 0-9 _ -')
        .optional(),
      PUBLIC_BASE_URL: z
        .string()
        .refine(isHttpsUrl, { message: 'must be an https:// URL' })
        .optional(),
      TELEGRAM_MODE: z.enum(['polling', 'webhook']).optional(),
      TELEGRAM_BOT_USERNAME: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/, 'must be the bot username without @')
        .optional(),
      PANEL_BASE_URL: z
        .string()
        .refine(isHttpUrl, { message: 'must be an http(s):// origin with no path' })
        .optional(),
      PANEL_TRUST_PROXY: z.enum(['true', 'false']).optional(),
      METRICS_TOKEN: z
        .string()
        .regex(/^[A-Za-z0-9_-]{24,200}$/, 'must be 24-200 characters from A-Z a-z 0-9 _ -')
        .optional(),
      BACKUP_KEY: z
        .string()
        .superRefine((value, ctx) => {
          const parsed = parseEncryptionKeys(value);
          if (!parsed.ok) {
            ctx.addIssue({ code: 'custom', message: parsed.error });
          } else if (parsed.keys.length !== 1) {
            ctx.addIssue({ code: 'custom', message: 'must be exactly one <id>:<base64 key>' });
          }
        })
        .optional(),
    })
    .superRefine((env, ctx) => {
      if (receivesUpdates && env.TELEGRAM_BOT_TOKEN !== undefined) {
        const mode = env.TELEGRAM_MODE ?? (env.APP_ENV === 'local' ? 'polling' : 'webhook');
        if (mode === 'polling' && env.APP_ENV !== 'local') {
          ctx.addIssue({
            code: 'custom',
            path: ['TELEGRAM_MODE'],
            message: 'polling is for APP_ENV=local only; use webhook',
          });
        }
        if (mode === 'webhook') {
          for (const name of ['TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL'] as const) {
            if (env[name] === undefined) {
              ctx.addIssue({ code: 'custom', path: [name], message: 'required in webhook mode' });
            }
          }
        }
      }
      if (env.APP_ENV === 'local') {
        return;
      }
      // A session cookie must never travel in the clear outside a developer's own machine.
      if (env.PANEL_BASE_URL !== undefined && !isHttpsUrl(env.PANEL_BASE_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['PANEL_BASE_URL'],
          message: 'must be https:// outside APP_ENV=local',
        });
      }
      const parsed = parseEncryptionKeys(env.ENCRYPTION_KEYS);
      if (parsed.ok && parsed.keys.some((key) => key.id.startsWith(DEV_KEY_PREFIX))) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENCRYPTION_KEYS'],
          message: `key ids starting with "${DEV_KEY_PREFIX}" are for APP_ENV=local only`,
        });
      }
      const backup = env.BACKUP_KEY === undefined ? null : parseEncryptionKeys(env.BACKUP_KEY);
      if (backup?.ok === true && backup.keys.some((key) => key.id.startsWith(DEV_KEY_PREFIX))) {
        ctx.addIssue({
          code: 'custom',
          path: ['BACKUP_KEY'],
          message: `key ids starting with "${DEV_KEY_PREFIX}" are for APP_ENV=local only`,
        });
      }
    })
    .superRefine((env, ctx) => {
      // A backup that opens with the key the database fields are encrypted with gives whoever
      // holds one copy both: the two must be different secrets, kept in different places.
      const fields = parseEncryptionKeys(env.ENCRYPTION_KEYS);
      const backup = env.BACKUP_KEY === undefined ? null : parseEncryptionKeys(env.BACKUP_KEY);
      const [key] = backup?.ok === true ? backup.keys : [];
      if (
        key !== undefined &&
        fields.ok &&
        fields.keys.some((field) => Buffer.from(field.key).equals(Buffer.from(key.key)))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['BACKUP_KEY'],
          message: 'must not be one of the ENCRYPTION_KEYS',
        });
      }
    });

type EnvValues = z.infer<ReturnType<typeof buildEnvSchema>>;
export type AppEnv = EnvValues['APP_ENV'];
export type LogLevel = EnvValues['LOG_LEVEL'];

export interface Config {
  readonly appEnv: AppEnv;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly httpPort: number;
  /** First key encrypts new data; every key can decrypt. */
  readonly encryptionKeys: readonly EncryptionKey[];
  /** Null when no bot token is configured; only the bot process requires it. */
  readonly telegram: TelegramConfig | null;
  /**
   * Where staff reach the panel, with no trailing slash; null when no panel is deployed. The bot
   * builds sign-in links from it, and the panel marks its cookie Secure when it is https.
   */
  readonly panelBaseUrl: string | null;
  /** What backups are encrypted with: a secret of its own, apart from the field keys. */
  readonly backupKey: EncryptionKey | null;
  /** Whoever holds this may read the worker's metrics page; null: the page does not exist. */
  readonly metricsToken: string | null;
  /** The panel stands behind a reverse proxy that reports the caller's address. */
  readonly panelTrustProxy: boolean;
  /**
   * The bot's @username, without the @. The mobile API builds its sign-in links from it
   * (t.me/<username>?start=a_<code>); null where no API is deployed.
   */
  readonly telegramBotUsername: string | null;
}

export interface LoadConfigOptions {
  /** Used when HTTP_PORT is not set. Each process has its own default. */
  readonly defaultHttpPort: number;
  /**
   * False for a process that only sends Telegram messages (the worker): the webhook settings
   * are then neither required nor checked. Defaults to true.
   */
  readonly receivesUpdates?: boolean;
}

/**
 * Lists the offending variables by name only. Values are never included:
 * DATABASE_URL carries a password, and later variables will carry tokens.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => ` - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** An empty `FOO=` line in .env is the same as FOO being unset. */
function withoutBlanks(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(env: Env, options: LoadConfigOptions): Config {
  const parsed = buildEnvSchema(options.receivesUpdates ?? true).safeParse(withoutBlanks(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const values = parsed.data;
  const keys = parseEncryptionKeys(values.ENCRYPTION_KEYS);
  if (!keys.ok) {
    // Unreachable: the schema already rejected it. Kept so the types need no assertion.
    throw new ConfigError([`ENCRYPTION_KEYS: ${keys.error}`]);
  }

  let telegram: TelegramConfig | null = null;
  if (values.TELEGRAM_BOT_TOKEN !== undefined) {
    const mode = values.TELEGRAM_MODE ?? (values.APP_ENV === 'local' ? 'polling' : 'webhook');
    telegram =
      mode === 'polling' ||
      values.TELEGRAM_WEBHOOK_SECRET === undefined ||
      values.PUBLIC_BASE_URL === undefined
        ? { mode: 'polling', botToken: values.TELEGRAM_BOT_TOKEN }
        : {
            mode: 'webhook',
            botToken: values.TELEGRAM_BOT_TOKEN,
            webhookSecret: values.TELEGRAM_WEBHOOK_SECRET,
            publicBaseUrl: values.PUBLIC_BASE_URL.replace(/\/+$/, ''),
          };
  }

  return {
    appEnv: values.APP_ENV,
    isProduction: values.APP_ENV === 'production',
    logLevel: values.LOG_LEVEL,
    databaseUrl: values.DATABASE_URL,
    httpPort: values.HTTP_PORT ?? options.defaultHttpPort,
    encryptionKeys: keys.keys,
    telegram,
    panelBaseUrl: values.PANEL_BASE_URL?.replace(/\/+$/, '') ?? null,
    backupKey: backupKeyOf(values.BACKUP_KEY),
    metricsToken: values.METRICS_TOKEN ?? null,
    panelTrustProxy: values.PANEL_TRUST_PROXY === 'true',
    telegramBotUsername: values.TELEGRAM_BOT_USERNAME ?? null,
  };
}

function backupKeyOf(raw: string | undefined): EncryptionKey | null {
  const parsed = raw === undefined ? null : parseEncryptionKeys(raw);
  return parsed?.ok === true ? (parsed.keys[0] ?? null) : null;
}

/** For the backup commands: the key backups are sealed with, or a ConfigError saying it is missing. */
export function requireBackupKey(config: Config): EncryptionKey {
  if (config.backupKey === null) {
    throw new ConfigError([
      'BACKUP_KEY: required for backups (<id>:<base64 of 32 random bytes>, not one of ENCRYPTION_KEYS)',
    ]);
  }
  return config.backupKey;
}

/** For the panel process: its own public address, or a ConfigError saying it is missing. */
export function requirePanelBaseUrl(config: Config): string {
  if (config.panelBaseUrl === null) {
    throw new ConfigError([
      'PANEL_BASE_URL: required for the panel (the address staff open it at, e.g. http://localhost:3002)',
    ]);
  }
  return config.panelBaseUrl;
}

/** For the bot process: the Telegram settings, or a ConfigError naming what is missing. */
export function requireTelegram(config: Config): TelegramConfig {
  if (config.telegram === null) {
    throw new ConfigError([
      'TELEGRAM_BOT_TOKEN: required for the bot (create one with @BotFather and put it in .env)',
    ]);
  }
  return config.telegram;
}

/** For a process that only sends messages: the bot token, or a ConfigError saying it is missing. */
export function requireBotToken(config: Config): string {
  if (config.telegram === null) {
    throw new ConfigError([
      'TELEGRAM_BOT_TOKEN: required to send reminders (the same token the bot uses)',
    ]);
  }
  return config.telegram.botToken;
}

/** The only place in the codebase that reads `process.env` (enforced by ESLint). */
export function loadConfigFromProcess(options: LoadConfigOptions): Config {
  return loadConfig(process.env, options);
}
