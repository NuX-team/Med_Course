import { DOSE_UNITS, FOOD_RULES, START_WINDOW_DAYS } from '@medcourse/db';
import { dictionaries } from '@medcourse/i18n';
import { isValidTimeZone } from '@medcourse/schedule';
import { describe, expect, it } from 'vitest';
import {
  TIMEZONE_CHOICES,
  decodeCallback,
  encodeCallback,
  timezoneByCode,
  timezoneByZone,
  WIZARD_VALUES,
  type Callback,
  type WizardField,
} from './callbacks';

const SOME_ID = '3f2b8c1e-9d4a-4b6e-8a1f-0c5d7e9a2b31';

const everyCallback: Callback[] = [
  { kind: 'language', locale: 'ru' },
  { kind: 'language', locale: 'uz' },
  { kind: 'consent', accepted: true },
  { kind: 'consent', accepted: false },
  { kind: 'consentAgain' },
  { kind: 'timezoneConfirm' },
  { kind: 'timezoneOther' },
  ...TIMEZONE_CHOICES.map((choice): Callback => ({ kind: 'timezone', code: choice.code })),
  ...(['home', 'course', 'today', 'history', 'settings', 'doctor', 'wards', 'admin'] as const).map(
    (target): Callback => ({ kind: 'menu', target }),
  ),
  { kind: 'settingsLanguage' },
  { kind: 'settingsTimezone' },
  { kind: 'setLanguage', locale: 'ru' },
  { kind: 'setLanguage', locale: 'uz' },
  ...TIMEZONE_CHOICES.map((choice): Callback => ({ kind: 'setTimezone', code: choice.code })),
  { kind: 'inviteAnswer', accepted: true },
  { kind: 'inviteAnswer', accepted: false },
  ...(
    ['register', 'invite', 'skipLabel', 'patients', 'invitations', 'newCourse', 'courses'] as const
  ).map((action): Callback => ({ kind: 'doctor', action })),
  ...(
    ['applications', 'doctors', 'stats', 'incidents', 'admins', 'addAdmin', 'cancel'] as const
  ).map((action): Callback => ({ kind: 'admin', action })),
  ...(['open', 'verify', 'revokeAsk', 'revoke', 'revokeAdminAsk', 'revokeAdmin'] as const).map(
    (action): Callback => ({ kind: 'adminPerson', action, userId: SOME_ID }),
  ),
  { kind: 'doctorDecision', relationshipId: SOME_ID, accept: true },
  { kind: 'doctorDecision', relationshipId: SOME_ID, accept: false },
  { kind: 'revokeInvitation', invitationId: SOME_ID },
  { kind: 'courseBegin', relationshipId: SOME_ID },
  ...(
    [
      'open',
      'addMedication',
      'removeMenu',
      'duration',
      'send',
      'discard',
      'discardYes',
      'pause',
      'pauseYes',
      'resume',
      'resumeYes',
      'cancel',
      'cancelYes',
      'change',
      'changeSend',
      'changeSendYes',
      'changeDrop',
    ] as const
  ).map((action): Callback => ({ kind: 'course', action, courseId: SOME_ID })),
  ...START_WINDOW_DAYS.map((days): Callback => ({ kind: 'courseWindow', courseId: SOME_ID, days })),
  { kind: 'courseRemoveMedication', medicationId: SOME_ID },
  { kind: 'patientCourse', action: 'ask', courseId: SOME_ID },
  { kind: 'patientCourse', action: 'confirm', courseId: SOME_ID },
  { kind: 'patientCourse', action: 'viewChange', courseId: SOME_ID },
  { kind: 'patientCourse', action: 'acceptChange', courseId: SOME_ID },
  { kind: 'patientCourse', action: 'pauseAsk', courseId: SOME_ID },
  { kind: 'patientCourse', action: 'pauseRequest', courseId: SOME_ID },
  { kind: 'history', audience: 'patient', courseId: SOME_ID },
  { kind: 'history', audience: 'doctor', courseId: SOME_ID },
  ...[1, 2, 37, 999].flatMap((page): Callback[] => [
    { kind: 'historyDays', audience: 'patient', courseId: SOME_ID, page },
    { kind: 'historyDays', audience: 'doctor', courseId: SOME_ID, page },
  ]),
  ...(['PDF', 'CSV'] as const).flatMap((format): Callback[] => [
    { kind: 'historyExport', audience: 'patient', courseId: SOME_ID, format },
    { kind: 'historyExport', audience: 'doctor', courseId: SOME_ID, format },
  ]),
  { kind: 'settingsPrivacy' },
  ...(
    ['doctors', 'withdrawAsk', 'withdraw', 'deleteAsk', 'delete', 'keep', 'regrant'] as const
  ).map((action): Callback => ({ kind: 'privacy', action })),
  ...(['leaveAsk', 'leave', 'share', 'unshare'] as const).map((action): Callback => ({
    kind: 'privacyDoctor',
    action,
    relationshipId: SOME_ID,
  })),
  { kind: 'pastCourses', relationshipId: SOME_ID },
  { kind: 'prn', action: 'ask', medicationId: SOME_ID },
  { kind: 'prn', action: 'confirm', medicationId: SOME_ID },
  { kind: 'prnUndo', eventId: SOME_ID },
  { kind: 'settingsCaregivers' },
  { kind: 'caregiverInvite', relationshipId: SOME_ID },
  { kind: 'caregiverAnswer', accepted: true },
  { kind: 'caregiverAnswer', accepted: false },
  { kind: 'caregiverDecision', relationshipId: SOME_ID, allow: true },
  { kind: 'caregiverDecision', relationshipId: SOME_ID, allow: false },
  { kind: 'caregiverRevoke', relationshipId: SOME_ID },
  { kind: 'ward', patientId: SOME_ID },
  ...(['take', 'skipAsk', 'undo', 'show'] as const).map((action): Callback => ({
    kind: 'dose',
    action,
    doseId: SOME_ID,
  })),
  ...[1, 5, 10, 15, 240].map((minutes): Callback => ({
    kind: 'doseSnooze',
    doseId: SOME_ID,
    minutes,
  })),
  ...(['FORGOT', 'NO_MEDICATION', 'OTHER', 'OTHER_SILENT'] as const).map((reason): Callback => ({
    kind: 'doseSkip',
    doseId: SOME_ID,
    reason,
  })),
  ...(Object.keys(WIZARD_VALUES) as WizardField[]).flatMap((field) =>
    WIZARD_VALUES[field].map((value) => ({ kind: 'wizard', field, value }) as Callback),
  ),
];

describe('callback data', () => {
  it('decodes to exactly what was encoded, for every button the bot can show', () => {
    for (const callback of everyCallback) {
      expect(decodeCallback(encodeCallback(callback)), JSON.stringify(callback)).toEqual(callback);
    }
  });

  it('gives every button its own data', () => {
    const encoded = everyCallback.map(encodeCallback);
    expect(new Set(encoded).size).toBe(encoded.length);
  });

  it('fits Telegram’s 64-byte limit', () => {
    for (const callback of everyCallback) {
      expect(
        Buffer.byteLength(encodeCallback(callback)),
        JSON.stringify(callback),
      ).toBeLessThanOrEqual(64);
    }
  });

  it.each([
    '',
    ':',
    'x',
    'l:',
    'l:en',
    'l:RU',
    'c:',
    'c:yes',
    'c:Y',
    'z:',
    'z:berlin',
    'z:../etc',
    'z:Asia/Tashkent',
    'sz:ok',
    'sz:o',
    'm:',
    'm:x',
    'm:__proto__',
    'm:constructor',
    's:',
    's:x',
    'unknown:ru',
    'l:ru:extra',
    ' l:ru',
    'l:ru ',
    'l: ru',
    '💥',
    'i:',
    'i:yes',
    'i:Y',
    'd:',
    'd:x',
    'd:__proto__',
    'd:constructor',
    'd:ri',
    'dc:',
    `dc:${SOME_ID}`,
    `dc:${SOME_ID}:`,
    `dc:${SOME_ID}:x`,
    `dc:${SOME_ID}:y:extra`,
    `dc:${SOME_ID.toUpperCase()}:y`,
    `dc:${SOME_ID}x:y`,
    'dc:not-an-id:y',
    "dc:' or 1=1 --:y",
    'dc:00000000-0000-0000-0000-00000000000:y',
    `dr:`,
    `dr:${SOME_ID}:y`,
    `dr:${SOME_ID.slice(1)}`,
    `dr:${SOME_ID.toUpperCase()}`,
    'dr:../../etc/passwd',
    'kb:',
    'kb:not-an-id',
    `kb:${SOME_ID}:x`,
    `kh:${SOME_ID}`,
    `k:${SOME_ID}`,
    `kvv:${SOME_ID}`,
    `kv:${SOME_ID.toUpperCase()}`,
    `ks:${SOME_ID}:7`,
    `k__proto__:${SOME_ID}`,
    `kw:${SOME_ID}`,
    `kw:${SOME_ID}:`,
    `kw:${SOME_ID}:2`,
    `kw:${SOME_ID}:365`,
    `kw:${SOME_ID}:07`,
    `kw:${SOME_ID}:7:x`,
    'kw:nope:7',
    `kx:${SOME_ID}x`,
    'xt:',
    'xt:not-an-id',
    `xt:${SOME_ID}:x`,
    `xz:${SOME_ID}`,
    `x:${SOME_ID}`,
    `xt:${SOME_ID.toUpperCase()}`,
    `x__proto__:${SOME_ID}`,
    `xs:${SOME_ID}`,
    `xs:${SOME_ID}:`,
    `xs:${SOME_ID}:0`,
    `xs:${SOME_ID}:05`,
    `xs:${SOME_ID}:241`,
    `xs:${SOME_ID}:-5`,
    `xs:${SOME_ID}:5.5`,
    `xs:${SOME_ID}:1e2`,
    `xs:${SOME_ID}:5:x`,
    'xs:nope:5',
    `xr:${SOME_ID}`,
    `xr:${SOME_ID}:`,
    `xr:${SOME_ID}:z`,
    `xr:${SOME_ID}:FORGOT`,
    `xr:${SOME_ID}:f:x`,
    `xr:${SOME_ID}:__proto__`,
    'ps:',
    'pc:not-an-id',
    `ps:${SOME_ID}:x`,
    `pc:${SOME_ID.toUpperCase()}`,
    `px:${SOME_ID}`,
    'w:',
    'w:u',
    'w:u:',
    'w:u:OTHER',
    'w:u:mg',
    'w:u:BUCKET',
    'w:f:WHENEVER',
    'w:q:5',
    'w:q:0',
    'w:i:1',
    'w:i:61',
    'w:l:365',
    'w:l:0',
    'w:t:yes',
    'w:x:1',
    'w:__proto__:1',
    'w:constructor:name',
    'w:u:MG:extra',
    `hv:${SOME_ID}:1`,
    `hr:${SOME_ID.toUpperCase()}`,
    'hv:nope',
    `hd:${SOME_ID}`,
    `hd:${SOME_ID}:`,
    `hd:${SOME_ID}:0`,
    `hd:${SOME_ID}:01`,
    `hd:${SOME_ID}:1000`,
    `hd:${SOME_ID}:-1`,
    `hk:${SOME_ID}:2:x`,
    `hx:${SOME_ID}`,
    'v:',
    'v:q',
    'v:toString',
    'v:w:1',
    's:q',
    'vl:',
    'vl:nope',
    `vy:${SOME_ID}:x`,
    `vs:${SOME_ID.toUpperCase()}`,
    `vz:${SOME_ID}`,
    'dh:',
    `dh:${SOME_ID}:1`,
    `hx:${SOME_ID}:`,
    `hx:${SOME_ID}:x`,
    `hx:${SOME_ID}:P`,
    `hx:${SOME_ID}:p:1`,
    `hy:${SOME_ID}:pdf`,
    'hy:nope:p',
    `hz:${SOME_ID}:p`,
    'np:',
    `np:${SOME_ID}:1`,
    `ny:${SOME_ID.slice(1)}`,
    `nu:${SOME_ID.toUpperCase()}`,
    `nz:${SOME_ID}`,
    `pp:${SOME_ID}:x`,
    `pz:${SOME_ID}`,
    'g:',
    'g:yes',
    's:x',
    `gi:${SOME_ID}:x`,
    `gi:${SOME_ID.toUpperCase()}`,
    `gd:${SOME_ID}`,
    `gd:${SOME_ID}:`,
    `gd:${SOME_ID}:maybe`,
    `gd:${SOME_ID}:y:x`,
    'gd:nope:y',
    `gr:${SOME_ID.slice(2)}`,
    `gw:${SOME_ID}:1`,
    `gx:${SOME_ID}`,
  ])('rejects %j', (data) => {
    expect(decodeCallback(data)).toBeNull();
  });

  it('offers every unit and food rule the database knows, except the free-form unit', () => {
    expect([...WIZARD_VALUES.unit].sort()).toEqual(
      DOSE_UNITS.filter((unit) => unit !== 'OTHER').sort(),
    );
    expect([...WIZARD_VALUES.food].sort()).toEqual([...FOOD_RULES].sort());
  });

  it('carries a full database id and still fits the limit', () => {
    expect(
      Buffer.byteLength(
        encodeCallback({ kind: 'doctorDecision', relationshipId: SOME_ID, accept: true }),
      ),
    ).toBe(41);
    expect(
      Buffer.byteLength(encodeCallback({ kind: 'revokeInvitation', invitationId: SOME_ID })),
    ).toBe(39);
  });

  it('never throws, whatever Telegram (or someone forging a callback) sends', () => {
    const alphabet = ':lcmzs_ruyontakpdi/.%0123456789abcdef- \n\u0000💥Ωz';
    let state = 17;
    const next = () => (state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0);
    for (let round = 0; round < 3_000; round += 1) {
      const length = next() % 12;
      const data = Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
      expect(() => decodeCallback(data), JSON.stringify(data)).not.toThrow();
    }
  });
});

describe('the time zones on offer', () => {
  it('are real IANA zones with unique codes and zones', () => {
    expect(new Set(TIMEZONE_CHOICES.map((choice) => choice.code)).size).toBe(
      TIMEZONE_CHOICES.length,
    );
    expect(new Set(TIMEZONE_CHOICES.map((choice) => choice.zone)).size).toBe(
      TIMEZONE_CHOICES.length,
    );
    for (const choice of TIMEZONE_CHOICES) {
      expect(isValidTimeZone(choice.zone), choice.zone).toBe(true);
    }
  });

  it('lead with Tashkent, the default for Uzbekistan', () => {
    expect(TIMEZONE_CHOICES[0]).toMatchObject({ zone: 'Asia/Tashkent' });
  });

  it('have a label in every language', () => {
    for (const choice of TIMEZONE_CHOICES) {
      expect(dictionaries.ru[choice.label].length).toBeGreaterThan(0);
      expect(dictionaries.uz[choice.label].length).toBeGreaterThan(0);
    }
  });

  it('are looked up by code or by zone, and unknown ones are not found', () => {
    expect(timezoneByCode('moscow')?.zone).toBe('Europe/Moscow');
    expect(timezoneByZone('Asia/Dubai')?.code).toBe('dubai');
    expect(timezoneByCode('mars')).toBeUndefined();
    expect(timezoneByZone('Mars/Olympus')).toBeUndefined();
  });
});

describe('the administrator’s buttons', () => {
  it('read only what the bot wrote: a known action, and for a person a real id', () => {
    for (const bad of [
      'a:',
      'a:x',
      'a:__proto__',
      'a:a:extra',
      'ap:',
      'ap:o',
      'ap:o:',
      'ap:q:' + SOME_ID,
      'ap:o:not-an-id',
      'ap:__proto__:' + SOME_ID,
      `ap:o:${SOME_ID}:x`,
      `ap:o:${SOME_ID.toUpperCase()}`,
    ]) {
      expect(decodeCallback(bad), bad).toBeNull();
    }
  });

  it('fit into the 64 bytes Telegram allows', () => {
    for (const callback of everyCallback.filter(
      (candidate) => candidate.kind === 'admin' || candidate.kind === 'adminPerson',
    )) {
      expect(
        Buffer.byteLength(encodeCallback(callback)),
        JSON.stringify(callback),
      ).toBeLessThanOrEqual(64);
    }
  });
});
