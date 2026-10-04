import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  requireBackupKey,
  requireBotToken,
  requirePanelBaseUrl,
  requireTelegram,
} from './index';

const DATABASE_URL = 'postgres://medcourse:medcourse@localhost:5433/medcourse';
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const ENCRYPTION_KEYS = `dev1:${KEY_A}`;
const base = { DATABASE_URL, ENCRYPTION_KEYS };
const options = { defaultHttpPort: 3000 };

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env, options);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected loadConfig to throw ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults when only the required variables are set', () => {
    const config = loadConfig(base, options);

    expect(config).toMatchObject({
      appEnv: 'local',
      isProduction: false,
      logLevel: 'info',
      databaseUrl: DATABASE_URL,
      httpPort: 3000,
    });
    expect(config.encryptionKeys.map((key) => key.id)).toEqual(['dev1']);
  });

  it('uses the per-process default port and lets HTTP_PORT override it', () => {
    expect(loadConfig(base, { defaultHttpPort: 3001 }).httpPort).toBe(3001);
    expect(loadConfig({ ...base, HTTP_PORT: '8080' }, options).httpPort).toBe(8080);
  });

  it('treats empty and whitespace-only values as unset', () => {
    const config = loadConfig({ ...base, APP_ENV: '', LOG_LEVEL: '  ', HTTP_PORT: '' }, options);
    expect(config.appEnv).toBe('local');
    expect(config.logLevel).toBe('info');
    expect(config.httpPort).toBe(3000);
  });

  it('reports an empty DATABASE_URL as missing, not as a crash at connect time', () => {
    expect(configError({ ...base, DATABASE_URL: '' }).problems).toEqual([
      expect.stringContaining('DATABASE_URL'),
    ]);
  });

  it('rejects a non-postgres DATABASE_URL without echoing its value', () => {
    const error = configError({
      ...base,
      DATABASE_URL: 'mysql://app:hunter2-secret@db.example/prod',
    });
    expect(error.problems).toHaveLength(1);
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain('hunter2-secret');
  });

  it.each(['0', '65536', '-1', '80.5', 'abc'])('rejects HTTP_PORT=%s', (port) => {
    expect(configError({ ...base, HTTP_PORT: port }).problems).toEqual([
      expect.stringContaining('HTTP_PORT'),
    ]);
  });

  it('rejects unknown APP_ENV and LOG_LEVEL', () => {
    const error = configError({ ...base, APP_ENV: 'prod', LOG_LEVEL: 'verbose' });
    expect(error.problems).toHaveLength(2);
  });

  it('reports every problem at once', () => {
    const error = configError({ HTTP_PORT: 'abc', APP_ENV: 'nope' });
    expect(error.problems).toHaveLength(4);
  });
});

describe('ENCRYPTION_KEYS', () => {
  it('is required', () => {
    expect(configError({ DATABASE_URL }).problems).toEqual([
      expect.stringContaining('ENCRYPTION_KEYS'),
    ]);
  });

  it('parses a ring: the first key is the active one', () => {
    const config = loadConfig(
      { DATABASE_URL, ENCRYPTION_KEYS: `dev2:${KEY_B}, dev1:${KEY_A}` },
      options,
    );

    expect(config.encryptionKeys.map((key) => key.id)).toEqual(['dev2', 'dev1']);
    expect(config.encryptionKeys[0]?.key).toHaveLength(32);
    expect(Buffer.from(config.encryptionKeys[0]?.key ?? []).toString('base64')).toBe(KEY_B);
  });

  it.each([
    ['no separator', KEY_A],
    ['empty id', `:${KEY_A}`],
    ['bad id characters', `bad.id:${KEY_A}`],
    ['key too short', `dev1:${Buffer.alloc(16).toString('base64')}`],
    ['key too long', `dev1:${Buffer.alloc(64).toString('base64')}`],
    ['not base64', 'dev1:!!!!'],
    ['duplicate id', `dev1:${KEY_A},dev1:${KEY_B}`],
    ['trailing comma', `dev1:${KEY_A},`],
  ])('rejects a malformed ring: %s', (_name, value) => {
    const error = configError({ DATABASE_URL, ENCRYPTION_KEYS: value });
    expect(error.problems).toEqual([expect.stringContaining('ENCRYPTION_KEYS')]);
  });

  it('never echoes key material in errors', () => {
    const error = configError({
      DATABASE_URL,
      ENCRYPTION_KEYS: `dev1:${Buffer.alloc(16, 9).toString('base64')}`,
    });
    expect(error.message).not.toContain(Buffer.alloc(16, 9).toString('base64'));
  });

  it('refuses dev-prefixed key ids outside APP_ENV=local', () => {
    for (const appEnv of ['staging', 'production']) {
      const error = configError({ ...base, APP_ENV: appEnv });
      expect(error.problems).toEqual([expect.stringContaining('ENCRYPTION_KEYS')]);
    }
  });

  it('accepts real key ids in production, even next to nothing local', () => {
    const config = loadConfig(
      { DATABASE_URL, APP_ENV: 'production', ENCRYPTION_KEYS: `prod-2026-10:${KEY_B}` },
      options,
    );
    expect(config.isProduction).toBe(true);
    expect(config.encryptionKeys.map((key) => key.id)).toEqual(['prod-2026-10']);
  });
});

describe('Telegram settings', () => {
  // Shaped like a real token, but invented.
  const TOKEN = `123456789:${'A'.repeat(35)}`;
  const SECRET = 'webhook-secret-0123456789';
  const local = { ...base, TELEGRAM_BOT_TOKEN: TOKEN };
  const prod: Record<string, string> = {
    DATABASE_URL,
    APP_ENV: 'production',
    ENCRYPTION_KEYS: `prod1:${KEY_B}`,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://bot.example.org',
  };

  it('is absent without a token, and requireTelegram says what to do', () => {
    const config = loadConfig(base, options);
    expect(config.telegram).toBeNull();
    expect(() => requireTelegram(config)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('polls by default on a local machine, needing nothing but the token', () => {
    expect(loadConfig(local, options).telegram).toEqual({ mode: 'polling', botToken: TOKEN });
  });

  it('uses a webhook by default outside local and needs the secret and the public URL', () => {
    expect(loadConfig(prod, options).telegram).toEqual({
      mode: 'webhook',
      botToken: TOKEN,
      webhookSecret: SECRET,
      publicBaseUrl: 'https://bot.example.org',
    });
    for (const missing of ['TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL']) {
      const { [missing]: _removed, ...rest } = prod;
      expect(configError(rest).problems).toEqual([expect.stringContaining(missing)]);
    }
  });

  it('can run a webhook locally when asked, and strips a trailing slash', () => {
    const config = loadConfig(
      {
        ...local,
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        PUBLIC_BASE_URL: 'https://abc.tunnel.example/',
      },
      options,
    );
    expect(config.telegram).toMatchObject({
      mode: 'webhook',
      publicBaseUrl: 'https://abc.tunnel.example',
    });
  });

  it('refuses polling outside local', () => {
    expect(configError({ ...prod, TELEGRAM_MODE: 'polling' }).problems).toEqual([
      expect.stringContaining('TELEGRAM_MODE'),
    ]);
  });

  it.each(['abc', '123:short', 'x'.repeat(40), `abc:${'A'.repeat(35)}`, ` ${TOKEN}x y`])(
    'rejects the malformed token %j without echoing it',
    (token) => {
      const error = configError({ ...base, TELEGRAM_BOT_TOKEN: token });
      expect(error.problems).toEqual([expect.stringContaining('TELEGRAM_BOT_TOKEN')]);
      expect(error.message).not.toContain(token.trim());
    },
  );

  it('accepts a realistic token', () => {
    expect(
      loadConfig(
        { ...base, TELEGRAM_BOT_TOKEN: '7654321098:AAH-x_Yz0123456789abcdefghijklmnopqrs' },
        options,
      ).telegram,
    ).not.toBeNull();
  });

  it.each(['short', 'has space in it........', 'bad/char/in/secret/....'])(
    'rejects the webhook secret %j',
    (secret) => {
      const error = configError({ ...prod, TELEGRAM_WEBHOOK_SECRET: secret });
      expect(error.problems).toEqual([expect.stringContaining('TELEGRAM_WEBHOOK_SECRET')]);
      expect(error.message).not.toContain(secret);
    },
  );

  it('refuses a public URL that is not https', () => {
    expect(configError({ ...prod, PUBLIC_BASE_URL: 'http://bot.example.org' }).problems).toEqual([
      expect.stringContaining('PUBLIC_BASE_URL'),
    ]);
  });

  describe('for a process that only sends (the worker)', () => {
    const sender = { ...options, receivesUpdates: false };

    it('needs the token alone, in any environment: no webhook settings, no mode', () => {
      const config = loadConfig(
        {
          DATABASE_URL,
          ENCRYPTION_KEYS: prod.ENCRYPTION_KEYS ?? '',
          APP_ENV: 'production',
          TELEGRAM_BOT_TOKEN: TOKEN,
        },
        sender,
      );
      expect(requireBotToken(config)).toBe(TOKEN);
    });

    it('still refuses the same environment for the bot, which does receive updates', () => {
      const env = {
        DATABASE_URL,
        ENCRYPTION_KEYS: prod.ENCRYPTION_KEYS ?? '',
        APP_ENV: 'production',
        TELEGRAM_BOT_TOKEN: TOKEN,
      };
      expect(() => loadConfig(env, options)).toThrow(ConfigError);
    });

    it('says what is missing when there is no token, without inventing one', () => {
      const config = loadConfig(base, sender);
      expect(() => requireBotToken(config)).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it('still rejects a malformed token without echoing it', () => {
      expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 'abc' }, sender)).toThrow(ConfigError);
    });
  });
});

describe('the staff panel address', () => {
  const prod = { DATABASE_URL, APP_ENV: 'production', ENCRYPTION_KEYS: `prod1:${KEY_B}` };

  it('is absent by default, and requirePanelBaseUrl says what to do', () => {
    const config = loadConfig(base, options);
    expect(config.panelBaseUrl).toBeNull();
    expect(() => requirePanelBaseUrl(config)).toThrow(/PANEL_BASE_URL/);
  });

  it('is an origin, kept without its trailing slash', () => {
    const config = loadConfig({ ...base, PANEL_BASE_URL: 'http://localhost:3002/' }, options);
    expect(config.panelBaseUrl).toBe('http://localhost:3002');
    expect(requirePanelBaseUrl(config)).toBe('http://localhost:3002');
  });

  it.each([
    'localhost:3002',
    'ftp://panel.example.org',
    'https://panel.example.org/login',
    'https://panel.example.org/?x=1',
  ])('refuses %j', (value) => {
    expect(configError({ ...base, PANEL_BASE_URL: value }).problems).toEqual([
      expect.stringContaining('PANEL_BASE_URL'),
    ]);
  });

  it('must be https outside a developer’s machine: a session cookie never travels in the clear', () => {
    expect(configError({ ...prod, PANEL_BASE_URL: 'http://panel.example.org' }).problems).toEqual([
      expect.stringContaining('PANEL_BASE_URL'),
    ]);
    expect(
      loadConfig({ ...prod, PANEL_BASE_URL: 'https://panel.example.org' }, options).panelBaseUrl,
    ).toBe('https://panel.example.org');
  });
});

describe('the backup key', () => {
  const KEY_C = Buffer.alloc(32, 3).toString('base64');
  const prod = { DATABASE_URL, APP_ENV: 'production', ENCRYPTION_KEYS: `prod1:${KEY_B}` };

  it('is absent by default, and requireBackupKey says what to do', () => {
    const config = loadConfig(base, options);
    expect(config.backupKey).toBeNull();
    expect(() => requireBackupKey(config)).toThrow(/BACKUP_KEY/);
  });

  it('is one key with an id, like the field keys', () => {
    const config = loadConfig({ ...base, BACKUP_KEY: `devbackup:${KEY_C}` }, options);
    expect(requireBackupKey(config)).toEqual({
      id: 'devbackup',
      key: new Uint8Array(Buffer.alloc(32, 3)),
    });
  });

  it.each([
    'no-separator',
    `short:${Buffer.alloc(16, 3).toString('base64')}`,
    `a:${KEY_C},b:${KEY_B}`,
  ])('refuses %j without repeating it', (value) => {
    const { problems, message } = configError({ ...base, BACKUP_KEY: value });
    expect(problems).toEqual([expect.stringContaining('BACKUP_KEY')]);
    expect(message).not.toContain(KEY_C);
  });

  it('must not be a key the database fields are encrypted with', () => {
    expect(configError({ ...base, BACKUP_KEY: `other:${KEY_A}` }).problems).toEqual([
      'BACKUP_KEY: must not be one of the ENCRYPTION_KEYS',
    ]);
    const rotated = { ...base, ENCRYPTION_KEYS: `dev2:${KEY_B},dev1:${KEY_A}` };
    expect(configError({ ...rotated, BACKUP_KEY: `other:${KEY_A}` }).problems).toEqual([
      'BACKUP_KEY: must not be one of the ENCRYPTION_KEYS',
    ]);
  });

  it('cannot be a throwaway development key outside a developer’s machine', () => {
    expect(configError({ ...prod, BACKUP_KEY: `devbackup:${KEY_C}` }).problems).toEqual([
      expect.stringContaining('BACKUP_KEY'),
    ]);
    expect(loadConfig({ ...prod, BACKUP_KEY: `backup1:${KEY_C}` }, options).backupKey?.id).toBe(
      'backup1',
    );
  });
});
