import { START_WINDOW_DAYS } from '@medcourse/db';
import type { Locale } from '@medcourse/i18n';
import type { MessageKey } from '@medcourse/i18n';

/**
 * Cities offered for the time zone. Codes keep callback data short and free of slashes; the zone
 * is looked up here, never taken from the button, so a forged callback cannot name an arbitrary one.
 */
export const TIMEZONE_CHOICES = [
  { code: 'tashkent', zone: 'Asia/Tashkent', label: 'timezone.city.tashkent' },
  { code: 'almaty', zone: 'Asia/Almaty', label: 'timezone.city.almaty' },
  { code: 'moscow', zone: 'Europe/Moscow', label: 'timezone.city.moscow' },
  { code: 'istanbul', zone: 'Europe/Istanbul', label: 'timezone.city.istanbul' },
  { code: 'dubai', zone: 'Asia/Dubai', label: 'timezone.city.dubai' },
  { code: 'seoul', zone: 'Asia/Seoul', label: 'timezone.city.seoul' },
] as const satisfies readonly { code: string; zone: string; label: MessageKey }[];

export type TimezoneCode = (typeof TIMEZONE_CHOICES)[number]['code'];

export function timezoneByCode(code: string): (typeof TIMEZONE_CHOICES)[number] | undefined {
  return TIMEZONE_CHOICES.find((choice) => choice.code === code);
}

export function timezoneByZone(zone: string): (typeof TIMEZONE_CHOICES)[number] | undefined {
  return TIMEZONE_CHOICES.find((choice) => choice.zone === zone);
}

export type MenuTarget =
  | 'home'
  | 'course'
  | 'today'
  | 'history'
  | 'settings'
  | 'doctor'
  /** The patients a caregiver watches over. */
  | 'wards'
  /** The administrator's section (only for an active technical administrator). */
  | 'admin';

/** What a button in the administrator's section can ask for. */
export type AdminAction =
  'applications' | 'doctors' | 'stats' | 'incidents' | 'admins' | 'addAdmin' | 'cancel';

/** What a button can ask about one person (a doctor or an administrator); their user id travels in it. */
export type AdminPersonAction =
  'open' | 'verify' | 'revokeAsk' | 'revoke' | 'revokeAdminAsk' | 'revokeAdmin';

const ADMIN_CODES: Readonly<Record<string, AdminAction>> = {
  a: 'applications',
  d: 'doctors',
  s: 'stats',
  i: 'incidents',
  m: 'admins',
  n: 'addAdmin',
  c: 'cancel',
};
const ADMIN_PERSON_CODES: Readonly<Record<string, AdminPersonAction>> = {
  o: 'open',
  v: 'verify',
  r: 'revokeAsk',
  y: 'revoke',
  x: 'revokeAdminAsk',
  z: 'revokeAdmin',
};

/** What a button in the doctor's section can ask for. */
export type DoctorAction =
  'register' | 'invite' | 'skipLabel' | 'patients' | 'invitations' | 'newCourse' | 'courses';

/**
 * What a button can ask of one particular course. The course id travels in the button. The
 * first group works on a plan being written; the second on a course that has been sent: put it
 * on hold, resume it, end it, or change its plan. What ends or interrupts treatment takes two
 * taps (the question, then the "yes").
 */
export type CourseAction =
  | 'open'
  | 'addMedication'
  | 'removeMenu'
  | 'duration'
  | 'send'
  | 'discard'
  | 'discardYes'
  | 'pause'
  | 'pauseYes'
  | 'resume'
  | 'resumeYes'
  | 'cancel'
  | 'cancelYes'
  | 'change'
  | 'changeSend'
  | 'changeSendYes'
  | 'changeDrop';

/** What a patient can do with one of their courses. */
export type PatientCourseAction =
  | 'ask'
  | 'confirm'
  | 'viewChange'
  | 'acceptChange'
  /** Asking the doctor for a pause: the question, then the "yes". */
  | 'pauseAsk'
  | 'pauseRequest';

/** Whose history screen a button belongs to: the patient's own, or the doctor's of a patient. */
export type HistoryAudience = 'patient' | 'doctor';

/** What a person does about their consent and their data; each destructive step is asked twice. */
export type PrivacyAction =
  'doctors' | 'withdrawAsk' | 'withdraw' | 'deleteAsk' | 'delete' | 'keep' | 'regrant';
export type PrivacyDoctorAction = 'leaveAsk' | 'leave' | 'share' | 'unshare';

const PRIVACY_CODES: Readonly<Record<string, PrivacyAction>> = {
  m: 'doctors',
  w: 'withdrawAsk',
  x: 'withdraw',
  d: 'deleteAsk',
  e: 'delete',
  u: 'keep',
  g: 'regrant',
};
const PRIVACY_DOCTOR_CODES: Readonly<Record<string, PrivacyDoctorAction>> = {
  vl: 'leaveAsk',
  vy: 'leave',
  vs: 'share',
  vn: 'unshare',
};

/** The kinds of file a course's report comes as. */
export type ExportFileFormat = 'PDF' | 'CSV';

/** The furthest page of a course's history a button may name. */
export const MAX_HISTORY_PAGE = 999;

/**
 * The choices offered on the steps of the course wizard. These buttons carry no ids: which
 * course and which medication they are about is in the conversation, and a press is honoured
 * only on the step that offers it. Units and food rules are the database's own values.
 */
export const WIZARD_VALUES = {
  unit: ['MG', 'G', 'MCG', 'ML', 'TABLET', 'CAPSULE', 'DROP', 'IU', 'PUFF', 'SACHET'],
  food: ['BEFORE_MEAL', 'WITH_MEAL', 'AFTER_MEAL', 'ANY'],
  freq: ['1', '2', '3', '4', 'own', 'prn'],
  times: ['ok', 'change'],
  days: ['all', 'some'],
  note: ['skip'],
  /** Minutes between two as-needed doses. */
  interval: ['30', '60', '120', '240', '360', '480', '720'],
  /** Days a course lasts, as quick choices. */
  length: ['5', '7', '10', '14'],
  source: ['scratch', 'copy'],
} as const;

export type WizardField = keyof typeof WIZARD_VALUES;
export type WizardChoice = {
  [F in WizardField]: { readonly field: F; readonly value: (typeof WIZARD_VALUES)[F][number] };
}[WizardField];

/** Ids in buttons are database UUIDs, in the lowercase form Postgres prints. Nothing else passes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a patient can do with one dose. The dose id travels in the button. */
export type DoseAction = 'take' | 'skipAsk' | 'undo' | 'show';

/**
 * Why a dose is skipped. `OTHER` asks for the patient's own words next; `OTHER_SILENT` is
 * "another reason" without saying more.
 */
export type SkipChoice = 'FORGOT' | 'NO_MEDICATION' | 'OTHER' | 'OTHER_SILENT';

/** The longest "later" a button may ask for. The real limit is the dose's own deadline. */
export const MAX_SNOOZE_MINUTES = 240;

/** Everything a button can say. Parsed strictly: anything else is ignored. */
export type Callback =
  /** Onboarding: the first language choice. */
  | { readonly kind: 'language'; readonly locale: Locale }
  | { readonly kind: 'consent'; readonly accepted: boolean }
  | { readonly kind: 'consentAgain' }
  /** The person confirms signing in to the mobile app; the sign-in's id travels in the button. */
  | { readonly kind: 'appLogin'; readonly loginId: string }
  /** Onboarding: the proposed time zone is right. */
  | { readonly kind: 'timezoneConfirm' }
  | { readonly kind: 'timezoneOther' }
  | { readonly kind: 'timezone'; readonly code: TimezoneCode }
  | { readonly kind: 'menu'; readonly target: MenuTarget }
  | { readonly kind: 'settingsLanguage' }
  | { readonly kind: 'settingsTimezone' }
  /** Settings: who watches over the patient's course. */
  | { readonly kind: 'settingsCaregivers' }
  /** Settings: consent, one's doctors, withdrawing consent, asking for deletion. */
  | { readonly kind: 'settingsPrivacy' }
  | { readonly kind: 'privacy'; readonly action: PrivacyAction }
  /** What a patient does about one of their doctors. */
  | {
      readonly kind: 'privacyDoctor';
      readonly action: PrivacyDoctorAction;
      readonly relationshipId: string;
    }
  /** A doctor opens the summaries of a patient's earlier courses. */
  | { readonly kind: 'pastCourses'; readonly relationshipId: string }
  | { readonly kind: 'setLanguage'; readonly locale: Locale }
  | { readonly kind: 'setTimezone'; readonly code: TimezoneCode }
  /** A patient answers an invitation from a doctor. */
  | { readonly kind: 'inviteAnswer'; readonly accepted: boolean }
  | { readonly kind: 'doctor'; readonly action: DoctorAction }
  | { readonly kind: 'admin'; readonly action: AdminAction }
  | { readonly kind: 'adminPerson'; readonly action: AdminPersonAction; readonly userId: string }
  /** A doctor answers "is this the person you invited?". */
  | { readonly kind: 'doctorDecision'; readonly relationshipId: string; readonly accept: boolean }
  | { readonly kind: 'revokeInvitation'; readonly invitationId: string }
  /** A doctor picks the patient a new course is for. */
  | { readonly kind: 'courseBegin'; readonly relationshipId: string }
  | { readonly kind: 'course'; readonly action: CourseAction; readonly courseId: string }
  /** The last step of sending: how many days the patient has to start. */
  | { readonly kind: 'courseWindow'; readonly courseId: string; readonly days: number }
  | { readonly kind: 'courseRemoveMedication'; readonly medicationId: string }
  | ({ readonly kind: 'wizard' } & WizardChoice)
  /**
   * A patient asks to start a course ("ask"), then confirms it after seeing what it means; or
   * looks at a change of plan the doctor proposed, and accepts it.
   */
  | {
      readonly kind: 'patientCourse';
      readonly action: PatientCourseAction;
      readonly courseId: string;
    }
  /** A doctor asks for a caregiver link for one of their patients. */
  | { readonly kind: 'caregiverInvite'; readonly relationshipId: string }
  /** The person who opened a caregiver link agrees to watch, or does not. */
  | { readonly kind: 'caregiverAnswer'; readonly accepted: boolean }
  /** The patient allows or refuses a caregiver who is waiting. */
  | { readonly kind: 'caregiverDecision'; readonly relationshipId: string; readonly allow: boolean }
  /** The patient ends a caregiver's access. */
  | { readonly kind: 'caregiverRevoke'; readonly relationshipId: string }
  /** A caregiver opens one ward's day. */
  | { readonly kind: 'ward'; readonly patientId: string }
  /** The summary of one course: how its schedule was followed. */
  | { readonly kind: 'history'; readonly audience: HistoryAudience; readonly courseId: string }
  /** The same course day by day; page 1 is the most recent days. */
  | {
      readonly kind: 'historyDays';
      readonly audience: HistoryAudience;
      readonly courseId: string;
      readonly page: number;
    }
  /** The report of a course as a file, for the person pressing the button. */
  | {
      readonly kind: 'historyExport';
      readonly audience: HistoryAudience;
      readonly courseId: string;
      readonly format: ExportFileFormat;
    }
  /** An as-needed drug: "mark it?" and "yes, I took it". The medication id travels in the button. */
  | { readonly kind: 'prn'; readonly action: 'ask' | 'confirm'; readonly medicationId: string }
  /** Taking back one particular as-needed mark. */
  | { readonly kind: 'prnUndo'; readonly eventId: string }
  | { readonly kind: 'dose'; readonly action: DoseAction; readonly doseId: string }
  | { readonly kind: 'doseSnooze'; readonly doseId: string; readonly minutes: number }
  | { readonly kind: 'doseSkip'; readonly doseId: string; readonly reason: SkipChoice };

const MENU_CODES: Readonly<Record<string, MenuTarget>> = {
  h: 'home',
  c: 'course',
  t: 'today',
  y: 'history',
  s: 'settings',
  d: 'doctor',
  w: 'wards',
  a: 'admin',
};

const DOCTOR_CODES: Readonly<Record<string, DoctorAction>> = {
  r: 'register',
  i: 'invite',
  s: 'skipLabel',
  p: 'patients',
  o: 'invitations',
  c: 'newCourse',
  l: 'courses',
};

const COURSE_CODES: Readonly<Record<string, CourseAction>> = {
  v: 'open',
  a: 'addMedication',
  r: 'removeMenu',
  d: 'duration',
  s: 'send',
  q: 'discard',
  y: 'discardYes',
  p: 'pause',
  n: 'pauseYes',
  u: 'resume',
  g: 'resumeYes',
  c: 'cancel',
  z: 'cancelYes',
  e: 'change',
  t: 'changeSend',
  o: 'changeSendYes',
  f: 'changeDrop',
};

const PATIENT_COURSE_CODES: Readonly<Record<string, PatientCourseAction>> = {
  ps: 'ask',
  pc: 'confirm',
  pv: 'viewChange',
  pa: 'acceptChange',
  pp: 'pauseAsk',
  pq: 'pauseRequest',
};

const WIZARD_CODES: Readonly<Record<string, WizardField>> = {
  u: 'unit',
  f: 'food',
  q: 'freq',
  t: 'times',
  d: 'days',
  n: 'note',
  i: 'interval',
  l: 'length',
  s: 'source',
};

const DOSE_CODES: Readonly<Record<string, DoseAction>> = {
  t: 'take',
  k: 'skipAsk',
  u: 'undo',
  v: 'show',
};

const SKIP_CODES: Readonly<Record<string, SkipChoice>> = {
  f: 'FORGOT',
  n: 'NO_MEDICATION',
  o: 'OTHER',
  x: 'OTHER_SILENT',
};

function codeOf<T extends string>(codes: Readonly<Record<string, T>>, value: T): string {
  const found = Object.entries(codes).find(([, candidate]) => candidate === value)?.[0];
  if (found === undefined) {
    throw new Error(`no button code for "${value}"`);
  }
  return found;
}

const LOCALE_CODES: readonly Locale[] = ['ru', 'uz'];

export function encodeCallback(callback: Callback): string {
  switch (callback.kind) {
    case 'language':
      return `l:${callback.locale}`;
    case 'consent':
      return callback.accepted ? 'c:y' : 'c:n';
    case 'consentAgain':
      return 'c:a';
    case 'appLogin':
      return `al:${callback.loginId}`;
    case 'timezoneConfirm':
      return 'z:ok';
    case 'timezoneOther':
      return 'z:o';
    case 'timezone':
      return `z:${callback.code}`;
    case 'menu':
      return `m:${Object.entries(MENU_CODES).find(([, target]) => target === callback.target)?.[0] ?? 'h'}`;
    case 'settingsLanguage':
      return 's:l';
    case 'settingsTimezone':
      return 's:z';
    case 'settingsCaregivers':
      return 's:c';
    case 'settingsPrivacy':
      return 's:p';
    case 'privacy':
      return `v:${Object.entries(PRIVACY_CODES).find(([, action]) => action === callback.action)?.[0] ?? 'm'}`;
    case 'privacyDoctor':
      return `${Object.entries(PRIVACY_DOCTOR_CODES).find(([, action]) => action === callback.action)?.[0] ?? 'vl'}:${callback.relationshipId}`;
    case 'pastCourses':
      return `dh:${callback.relationshipId}`;
    case 'setLanguage':
      return `sl:${callback.locale}`;
    case 'setTimezone':
      return `sz:${callback.code}`;
    case 'inviteAnswer':
      return callback.accepted ? 'i:y' : 'i:n';
    case 'admin':
      return `a:${codeOf(ADMIN_CODES, callback.action)}`;
    case 'adminPerson':
      return `ap:${codeOf(ADMIN_PERSON_CODES, callback.action)}:${callback.userId}`;
    case 'doctor':
      return `d:${Object.entries(DOCTOR_CODES).find(([, action]) => action === callback.action)?.[0] ?? 'p'}`;
    case 'doctorDecision':
      return `dc:${callback.relationshipId}:${callback.accept ? 'y' : 'n'}`;
    case 'revokeInvitation':
      return `dr:${callback.invitationId}`;
    case 'courseBegin':
      return `kb:${callback.relationshipId}`;
    case 'course':
      return `k${codeOf(COURSE_CODES, callback.action)}:${callback.courseId}`;
    case 'courseWindow':
      return `kw:${callback.courseId}:${String(callback.days)}`;
    case 'courseRemoveMedication':
      return `kx:${callback.medicationId}`;
    case 'wizard':
      return `w:${codeOf(WIZARD_CODES, callback.field)}:${callback.value}`;
    case 'patientCourse':
      return `${codeOf(PATIENT_COURSE_CODES, callback.action)}:${callback.courseId}`;
    case 'caregiverInvite':
      return `gi:${callback.relationshipId}`;
    case 'caregiverAnswer':
      return callback.accepted ? 'g:y' : 'g:n';
    case 'caregiverDecision':
      return `gd:${callback.relationshipId}:${callback.allow ? 'y' : 'n'}`;
    case 'caregiverRevoke':
      return `gr:${callback.relationshipId}`;
    case 'ward':
      return `gw:${callback.patientId}`;
    case 'history':
      return `${callback.audience === 'patient' ? 'hv' : 'hr'}:${callback.courseId}`;
    case 'historyDays':
      return `${callback.audience === 'patient' ? 'hd' : 'hk'}:${callback.courseId}:${String(callback.page)}`;
    case 'historyExport':
      return `${callback.audience === 'patient' ? 'hx' : 'hy'}:${callback.courseId}:${callback.format === 'PDF' ? 'p' : 'c'}`;
    case 'prn':
      return `${callback.action === 'ask' ? 'np' : 'ny'}:${callback.medicationId}`;
    case 'prnUndo':
      return `nu:${callback.eventId}`;
    case 'dose':
      return `x${codeOf(DOSE_CODES, callback.action)}:${callback.doseId}`;
    case 'doseSnooze':
      return `xs:${callback.doseId}:${String(callback.minutes)}`;
    case 'doseSkip':
      return `xr:${callback.doseId}:${codeOf(SKIP_CODES, callback.reason)}`;
  }
}

export function decodeCallback(data: string): Callback | null {
  const separator = data.indexOf(':');
  if (separator < 0) {
    return null;
  }
  const head = data.slice(0, separator);
  const rest = data.slice(separator + 1);
  const locale = LOCALE_CODES.find((candidate) => candidate === rest);

  switch (head) {
    case 'l':
      return locale === undefined ? null : { kind: 'language', locale };
    case 'sl':
      return locale === undefined ? null : { kind: 'setLanguage', locale };
    case 'c':
      return rest === 'y'
        ? { kind: 'consent', accepted: true }
        : rest === 'n'
          ? { kind: 'consent', accepted: false }
          : rest === 'a'
            ? { kind: 'consentAgain' }
            : null;
    case 'z': {
      if (rest === 'ok') return { kind: 'timezoneConfirm' };
      if (rest === 'o') return { kind: 'timezoneOther' };
      const choice = timezoneByCode(rest);
      return choice === undefined ? null : { kind: 'timezone', code: choice.code };
    }
    case 'sz': {
      const choice = timezoneByCode(rest);
      return choice === undefined ? null : { kind: 'setTimezone', code: choice.code };
    }
    case 'm': {
      // Own keys only: `m:__proto__` must not find Object.prototype.
      const target = Object.hasOwn(MENU_CODES, rest) ? MENU_CODES[rest] : undefined;
      return target === undefined ? null : { kind: 'menu', target };
    }
    case 's':
      return rest === 'l'
        ? { kind: 'settingsLanguage' }
        : rest === 'z'
          ? { kind: 'settingsTimezone' }
          : rest === 'c'
            ? { kind: 'settingsCaregivers' }
            : rest === 'p'
              ? { kind: 'settingsPrivacy' }
              : null;
    case 'i':
      return rest === 'y'
        ? { kind: 'inviteAnswer', accepted: true }
        : rest === 'n'
          ? { kind: 'inviteAnswer', accepted: false }
          : null;
    case 'd': {
      const action = Object.hasOwn(DOCTOR_CODES, rest) ? DOCTOR_CODES[rest] : undefined;
      return action === undefined ? null : { kind: 'doctor', action };
    }
    case 'a': {
      const action = Object.hasOwn(ADMIN_CODES, rest) ? ADMIN_CODES[rest] : undefined;
      return action === undefined ? null : { kind: 'admin', action };
    }
    case 'ap': {
      const [code, id, ...extra] = rest.split(':');
      const action =
        code !== undefined && Object.hasOwn(ADMIN_PERSON_CODES, code)
          ? ADMIN_PERSON_CODES[code]
          : undefined;
      return action === undefined || id === undefined || !UUID.test(id) || extra.length > 0
        ? null
        : { kind: 'adminPerson', action, userId: id };
    }
    case 'dc': {
      const [id, answer, ...extra] = rest.split(':');
      if (id === undefined || !UUID.test(id) || extra.length > 0) {
        return null;
      }
      return answer === 'y' || answer === 'n'
        ? { kind: 'doctorDecision', relationshipId: id, accept: answer === 'y' }
        : null;
    }
    case 'dr':
      return UUID.test(rest) ? { kind: 'revokeInvitation', invitationId: rest } : null;
    case 'dh':
      return UUID.test(rest) ? { kind: 'pastCourses', relationshipId: rest } : null;
    case 'v': {
      const action = Object.hasOwn(PRIVACY_CODES, rest) ? PRIVACY_CODES[rest] : undefined;
      return action === undefined ? null : { kind: 'privacy', action };
    }
    case 'vl':
    case 'vy':
    case 'vs':
    case 'vn': {
      const action = PRIVACY_DOCTOR_CODES[head];
      return action === undefined || !UUID.test(rest)
        ? null
        : { kind: 'privacyDoctor', action, relationshipId: rest };
    }
    case 'kb':
      return UUID.test(rest) ? { kind: 'courseBegin', relationshipId: rest } : null;
    case 'ps':
    case 'pc':
    case 'pv':
    case 'pa':
    case 'pp':
    case 'pq': {
      const action = PATIENT_COURSE_CODES[head];
      return action !== undefined && UUID.test(rest)
        ? { kind: 'patientCourse', action, courseId: rest }
        : null;
    }
    case 'kx':
      return UUID.test(rest) ? { kind: 'courseRemoveMedication', medicationId: rest } : null;
    case 'g':
      return rest === 'y'
        ? { kind: 'caregiverAnswer', accepted: true }
        : rest === 'n'
          ? { kind: 'caregiverAnswer', accepted: false }
          : null;
    case 'gi':
      return UUID.test(rest) ? { kind: 'caregiverInvite', relationshipId: rest } : null;
    case 'gr':
      return UUID.test(rest) ? { kind: 'caregiverRevoke', relationshipId: rest } : null;
    case 'gw':
      return UUID.test(rest) ? { kind: 'ward', patientId: rest } : null;
    case 'gd': {
      const [id, answer, ...extra] = rest.split(':');
      if (id === undefined || !UUID.test(id) || extra.length > 0) {
        return null;
      }
      return answer === 'y' || answer === 'n'
        ? { kind: 'caregiverDecision', relationshipId: id, allow: answer === 'y' }
        : null;
    }
    case 'hv':
    case 'hr':
      return UUID.test(rest)
        ? { kind: 'history', audience: head === 'hv' ? 'patient' : 'doctor', courseId: rest }
        : null;
    case 'hd':
    case 'hk': {
      const [id, page, ...extra] = rest.split(':');
      // Digits only, no leading zero: one spelling per number.
      const number = page !== undefined && /^[1-9][0-9]{0,2}$/.test(page) ? Number(page) : 0;
      return id === undefined || !UUID.test(id) || extra.length > 0 || number < 1
        ? null
        : {
            kind: 'historyDays',
            audience: head === 'hd' ? 'patient' : 'doctor',
            courseId: id,
            page: number,
          };
    }
    case 'hx':
    case 'hy': {
      const [id, format, ...extra] = rest.split(':');
      return id === undefined ||
        !UUID.test(id) ||
        extra.length > 0 ||
        (format !== 'p' && format !== 'c')
        ? null
        : {
            kind: 'historyExport',
            audience: head === 'hx' ? 'patient' : 'doctor',
            courseId: id,
            format: format === 'p' ? 'PDF' : 'CSV',
          };
    }
    case 'np':
    case 'ny':
      return UUID.test(rest)
        ? { kind: 'prn', action: head === 'np' ? 'ask' : 'confirm', medicationId: rest }
        : null;
    case 'nu':
      return UUID.test(rest) ? { kind: 'prnUndo', eventId: rest } : null;
    case 'al':
      return UUID.test(rest) ? { kind: 'appLogin', loginId: rest } : null;
    case 'xs': {
      const [id, minutes, ...extra] = rest.split(':');
      // Digits only, no leading zero: one spelling per number.
      const amount =
        minutes !== undefined && /^[1-9][0-9]{0,2}$/.test(minutes) ? Number(minutes) : 0;
      return id === undefined ||
        !UUID.test(id) ||
        extra.length > 0 ||
        amount < 1 ||
        amount > MAX_SNOOZE_MINUTES
        ? null
        : { kind: 'doseSnooze', doseId: id, minutes: amount };
    }
    case 'xr': {
      const [id, code, ...extra] = rest.split(':');
      const reason =
        code !== undefined && Object.hasOwn(SKIP_CODES, code) ? SKIP_CODES[code] : undefined;
      return id === undefined || !UUID.test(id) || extra.length > 0 || reason === undefined
        ? null
        : { kind: 'doseSkip', doseId: id, reason };
    }
    case 'kw': {
      const [id, days, ...extra] = rest.split(':');
      const allowed = START_WINDOW_DAYS.find((candidate) => String(candidate) === days);
      return id === undefined || !UUID.test(id) || extra.length > 0 || allowed === undefined
        ? null
        : { kind: 'courseWindow', courseId: id, days: allowed };
    }
    case 'w': {
      const [code, value, ...extra] = rest.split(':');
      const field =
        code !== undefined && Object.hasOwn(WIZARD_CODES, code) ? WIZARD_CODES[code] : undefined;
      if (field === undefined || value === undefined || extra.length > 0) {
        return null;
      }
      // Only a value this step really offers: the button text is never trusted.
      return (WIZARD_VALUES[field] as readonly string[]).includes(value)
        ? ({ kind: 'wizard', field, value } as Callback)
        : null;
    }
    default: {
      // `k<letter>:<course id>`: an action on one course.
      const action =
        head.length === 2 && head.startsWith('k') && Object.hasOwn(COURSE_CODES, head.slice(1))
          ? COURSE_CODES[head.slice(1)]
          : undefined;
      if (action !== undefined) {
        return UUID.test(rest) ? { kind: 'course', action, courseId: rest } : null;
      }
      // `x<letter>:<dose id>`: an action on one dose.
      const doseAction =
        head.length === 2 && head.startsWith('x') && Object.hasOwn(DOSE_CODES, head.slice(1))
          ? DOSE_CODES[head.slice(1)]
          : undefined;
      return doseAction !== undefined && UUID.test(rest)
        ? { kind: 'dose', action: doseAction, doseId: rest }
        : null;
    }
  }
}
