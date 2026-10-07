import { isLocale, t, type Locale, type MessageKey } from '@medcourse/i18n';
import { isValidTimeZone } from '@medcourse/schedule';
import {
  TIMEZONE_CHOICES,
  decodeCallback,
  encodeCallback,
  timezoneByCode,
  timezoneByZone,
  type Callback,
  type MenuTarget,
} from './callbacks';
import { AdminFlow } from './admin';
import { CaregiverFlow } from './caregiver';
import { CourseFlow } from './course';
import { CourseControlFlow, isControlAction } from './course-control';
import { DoctorFlow } from './doctor';
import { DoseFlow } from './dose';
import { HistoryFlow } from './history';
import { PrivacyFlow } from './privacy';
import { InviteFlow, isCodeHash } from './invite';
import { cleanName } from './names';
import { PatientCourseFlow } from './patient-course';
import { PrnFlow } from './as-needed';
import {
  Chat,
  ONBOARDING_STEPS,
  asPatient,
  system,
  textOf,
  type HandlerContext,
  type Incoming,
  type OnboardingStep,
  type Session,
  type Talk,
} from './session';
import type { Button, Reply, Update } from './types';

export type { HandlerContext, Incoming } from './session';

/**
 * Which text of the consent a person agreed to. Change it whenever that text changes in any
 * language: everyone then has to agree again. The wording itself still needs legal approval.
 */
export const CONSENT_VERSION = '2026-10-v1';

const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const LANGUAGE_PROMPT = 'Выберите язык / Tilni tanlang';

/**
 * Only private conversations with a person count. Groups, channels, other bots and every update
 * type other than a message or a button press are ignored (`null`).
 */
export function extractIncoming(update: Update): Incoming | null {
  const message = update.message;
  if (message !== undefined) {
    // The body is untrusted JSON, so do not rely on the type alone for a field that could be absent.
    const from = message.from as { id: number; is_bot: boolean } | undefined;
    if (message.chat.type !== 'private' || from === undefined || from.is_bot) {
      return null;
    }
    const key = `msg:${String(message.chat.id)}:${String(message.message_id)}`;
    return message.text === undefined
      ? { telegramUserId: from.id, chatId: message.chat.id, kind: 'other', key }
      : { telegramUserId: from.id, chatId: message.chat.id, kind: 'text', text: message.text, key };
  }

  const query = update.callback_query;
  if (query !== undefined) {
    const chat = query.message?.chat;
    if (query.from.is_bot || chat?.type !== 'private' || query.data === undefined) {
      return null;
    }
    return {
      telegramUserId: query.from.id,
      chatId: chat.id,
      kind: 'callback',
      callback: { id: query.id, data: query.data },
      messageId: query.message?.message_id ?? 0,
      key: `cb:${query.id}`,
    };
  }
  return null;
}

export async function handleUpdate(context: HandlerContext, update: Update): Promise<Reply[]> {
  const incoming = extractIncoming(update);
  if (incoming === null) {
    return [];
  }
  const { repos, now } = context;

  const user = await repos.users.findByTelegramId(system, incoming.telegramUserId);
  if (user !== null && user.status !== 'ACTIVE') {
    // Blocked or deleted: the bot says nothing, and does not let the person register again.
    return [];
  }
  const profile =
    user?.status === 'ACTIVE' ? await repos.patients.getSummary(asPatient(user.id), user.id) : null;
  const clinician =
    user?.status === 'ACTIVE' && profile !== null
      ? await repos.clinicians.getOwn(asPatient(user.id), user.id)
      : null;
  // One short query per update: it decides whether the menu offers "wards" and "admin" at all.
  const flags =
    user?.status === 'ACTIVE' && profile !== null
      ? await repos.users.menuFlags(system, user.id)
      : { watching: false, admin: false };
  const standing =
    user?.status === 'ACTIVE' && profile !== null
      ? await repos.privacy.standing(system, user.id)
      : null;
  const stored = await repos.telegram.getConversation(incoming.telegramUserId, now);
  const talk: Talk | null =
    stored === null ? null : { flow: stored.flow, step: stored.step, data: { ...stored.data } };
  const conversation =
    stored?.flow === 'ONBOARDING' && ONBOARDING_STEPS.includes(stored.step)
      ? { step: stored.step as OnboardingStep, data: { ...stored.data } }
      : null;
  const chosen = conversation?.data.locale;

  const session: Session = {
    incoming,
    user: user?.status === 'ACTIVE' ? user : null,
    profile,
    clinician,
    watching: flags.watching,
    admin: flags.admin,
    conversation,
    talk,
    locale: user?.status === 'ACTIVE' ? user.locale : isLocale(chosen) ? chosen : null,
    standing,
  };
  if (standing !== null && (standing.consent === 'REVOKED' || standing.deletionDueAt !== null)) {
    // Consent is withdrawn, or a deletion is waiting: nothing is done for this person except
    // taking the request back or accepting consent again.
    const pressed =
      incoming.kind === 'callback' && incoming.callback !== undefined ? incoming.callback : null;
    const gate = await new PrivacyFlow(new Chat(context, session)).gated(
      standing,
      pressed === null ? null : decodeCallback(pressed.data),
      CONSENT_VERSION,
    );
    return pressed === null ? gate : [{ kind: 'answer', callbackQueryId: pressed.id }, ...gate];
  }
  const flow = new Flow(context, session);

  if (incoming.kind === 'callback' && incoming.callback !== undefined) {
    const answer: Reply = { kind: 'answer', callbackQueryId: incoming.callback.id };
    const decoded = decodeCallback(incoming.callback.data);
    return [answer, ...(decoded === null ? [] : await flow.onCallback(decoded))];
  }
  if (incoming.kind === 'text' && incoming.text !== undefined) {
    const command = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/u.exec(incoming.text.trim());
    return command === null
      ? flow.onText(incoming.text)
      : flow.onCommand(command[1] ?? '', (command[2] ?? '').trim());
  }
  return flow.onUnsupported();
}

class Flow {
  readonly #ctx: HandlerContext;
  readonly #s: Session;
  readonly #chat: Chat;
  readonly #invite: InviteFlow;
  readonly #caregiver: CaregiverFlow;
  readonly #doctor: DoctorFlow;
  readonly #admin: AdminFlow;
  readonly #course: CourseFlow;
  readonly #control: CourseControlFlow;
  readonly #patientCourse: PatientCourseFlow;
  readonly #dose: DoseFlow;
  readonly #history: HistoryFlow;
  readonly #privacy: PrivacyFlow;
  readonly #prn: PrnFlow;
  /**
   * The hash of an invitation link the person opened before finishing registration. It rides
   * along in every onboarding step and is offered to them once they have an account.
   */
  #carry: string | undefined;

  constructor(context: HandlerContext, session: Session) {
    this.#ctx = context;
    this.#s = session;
    this.#chat = new Chat(context, session);
    this.#invite = new InviteFlow(this.#chat);
    this.#caregiver = new CaregiverFlow(this.#chat);
    this.#doctor = new DoctorFlow(this.#chat);
    this.#admin = new AdminFlow(this.#chat);
    this.#course = new CourseFlow(this.#chat);
    this.#control = new CourseControlFlow(this.#chat, this.#course);
    this.#patientCourse = new PatientCourseFlow(this.#chat);
    this.#dose = new DoseFlow(this.#chat);
    this.#history = new HistoryFlow(this.#chat);
    this.#privacy = new PrivacyFlow(this.#chat);
    this.#prn = new PrnFlow(this.#chat);
    const carried = session.conversation?.data.invite;
    this.#carry = isCodeHash(carried) ? carried : undefined;
  }

  // Entry points -------------------------------------------------------------------------

  async onCommand(name: string, args: string): Promise<Reply[]> {
    switch (name.toLowerCase()) {
      case 'start':
        return this.#startCommand(args);
      case 'menu':
        if (this.#s.profile === null) {
          return this.#start();
        }
        await this.#chat.clearSideConversation();
        return [this.#menuMessage()];
      case 'doctor':
        return this.#s.profile === null ? this.#start() : this.#doctor.section();
      case 'admin':
        // Not an administrator: the command does not exist, as with /panel.
        return this.#s.profile === null
          ? this.#start()
          : this.#s.admin
            ? this.#admin.section()
            : [this.#menuMessage()];
      case 'help':
        return [this.#send(this.#chat.say('help.text'))];
      case 'panel':
        return this.#panelCommand();
      default:
        // An unknown command: the most helpful reply is the way forward, not a complaint.
        return this.#s.profile === null ? this.#start() : [this.#menuMessage()];
    }
  }

  /**
   * `/panel`: a one-time sign-in link for a member of staff. To anyone else the command does
   * not exist: they get what any unknown command gets, so the bot does not say who is staff.
   */
  async #panelCommand(): Promise<Reply[]> {
    const { user, profile } = this.#s;
    if (user === null || profile === null) {
      return this.#start();
    }
    await this.#chat.clearSideConversation();
    const { repos, now, panelBaseUrl } = this.#ctx;
    const issued = await repos.panel.issueLogin(system, { userId: user.id, now });
    if (issued.status === 'NOT_STAFF') {
      return [this.#menuMessage()];
    }
    const locale = this.#locale();
    if (panelBaseUrl === null) {
      return [this.#send(t(locale, 'panel.notConfigured'))];
    }
    if (issued.status === 'TOO_MANY') {
      return [this.#send(t(locale, 'panel.tooMany'))];
    }
    return [
      this.#send(t(locale, 'panel.link', { link: `${panelBaseUrl}/login?t=${issued.token}` })),
    ];
  }

  async onText(text: string): Promise<Reply[]> {
    const handled =
      (await this.#doctor.onText(text)) ??
      (await this.#admin.onText(text)) ??
      (await this.#course.onText(text)) ??
      (await this.#dose.onText(text));
    if (handled !== null) {
      return handled;
    }
    const step = this.#s.conversation?.step;
    if (step === 'FIRST_NAME' && this.#s.user !== null) {
      return this.#acceptFirstName(text);
    }
    if (step === 'LAST_NAME' && this.#s.user !== null) {
      return this.#acceptLastName(text);
    }
    if (this.#s.profile !== null) {
      return [this.#menuMessage()];
    }
    return this.#start();
  }

  async onUnsupported(): Promise<Reply[]> {
    return this.#unsupported();
  }

  async onCallback(callback: Callback): Promise<Reply[]> {
    switch (callback.kind) {
      case 'language':
        return this.#chooseLanguage(callback.locale);
      case 'consent':
        return callback.accepted ? this.#acceptConsent() : this.#declineConsent();
      case 'consentAgain':
        return this.#reconsider();
      case 'timezoneConfirm':
        return this.#finishOnboarding(this.#s.user?.timezone ?? DEFAULT_TIMEZONE);
      case 'timezoneOther':
        return this.#onboardingStep('TIMEZONE')
          ? [this.#edit(t(this.#locale(), 'timezone.pick'), this.#cityButtons('timezone'))]
          : [];
      case 'timezone': {
        const choice = timezoneByCode(callback.code);
        return choice === undefined ? [] : this.#finishOnboarding(choice.zone);
      }
      case 'menu':
        return this.#menu(callback.target);
      case 'settingsLanguage':
        return this.#registered()
          ? [
              this.#edit(t(this.#locale(), 'settings.languagePick'), [
                this.#languageButtons('setLanguage'),
                [this.#back('settings')],
              ]),
            ]
          : [];
      case 'setLanguage':
        return this.#changeLanguage(callback.locale);
      case 'settingsTimezone':
        return this.#registered() ? [this.#editTimezonePicker()] : [];
      case 'settingsCaregivers':
        return this.#caregiver.list();
      case 'settingsPrivacy':
        return this.#privacy.screen();
      case 'privacy':
        return this.#privacy.on(callback.action);
      case 'privacyDoctor':
        return this.#privacy.onDoctor(callback.action, callback.relationshipId);
      case 'pastCourses':
        return this.#privacy.pastCourses(callback.relationshipId);
      case 'caregiverInvite':
        return this.#caregiver.invite(callback.relationshipId);
      case 'caregiverAnswer':
        return this.#caregiver.answer(callback.accepted);
      case 'caregiverDecision':
        return this.#caregiver.decide(callback.relationshipId, callback.allow);
      case 'caregiverRevoke':
        return this.#caregiver.revoke(callback.relationshipId);
      case 'ward':
        return this.#caregiver.ward(callback.patientId);
      case 'setTimezone':
        return this.#changeTimezone(callback.code);
      case 'inviteAnswer':
        return this.#invite.answer(callback.accepted);
      case 'doctor':
        if (callback.action === 'newCourse') {
          return this.#course.begin();
        }
        return callback.action === 'courses'
          ? this.#course.list()
          : this.#doctor.onAction(callback.action);
      case 'admin':
        return this.#admin.onAction(callback.action);
      case 'adminPerson':
        return this.#admin.onPerson(callback.action, callback.userId);
      case 'doctorDecision':
        return this.#doctor.onDecision(callback.relationshipId, callback.accept);
      case 'revokeInvitation':
        return this.#doctor.onRevoke(callback.invitationId);
      case 'courseBegin':
        return this.#course.forPatient(callback.relationshipId);
      case 'course':
        return isControlAction(callback.action)
          ? this.#control.on(callback.action, callback.courseId)
          : this.#course.onCourse(callback.action, callback.courseId);
      case 'courseWindow':
        return this.#course.onWindow(callback.courseId, callback.days);
      case 'courseRemoveMedication':
        return this.#course.onRemoveMedication(callback.medicationId);
      case 'wizard':
        return this.#course.onChoice(callback);
      case 'patientCourse':
        return this.#patientCourse.on(callback.action, callback.courseId);
      case 'history':
        return this.#history.report(callback.audience, callback.courseId);
      case 'historyDays':
        return this.#history.days(callback.audience, callback.courseId, callback.page);
      case 'historyExport':
        return this.#history.export(callback.audience, callback.courseId, callback.format);
      case 'prn':
        return callback.action === 'ask'
          ? this.#prn.ask(callback.medicationId)
          : this.#prn.confirm(callback.medicationId);
      case 'prnUndo':
        return this.#prn.undo(callback.eventId);
      case 'dose':
        return this.#dose.onDose(callback.action, callback.doseId);
      case 'doseSnooze':
        return this.#dose.onSnooze(callback.doseId, callback.minutes);
      case 'doseSkip':
        return this.#dose.onSkip(callback.doseId, callback.reason);
    }
  }

  // Invitation links ---------------------------------------------------------------------

  /**
   * `/start`, with or without a payload. `i_<code>` is a doctor's invitation to a patient,
   * `g_<code>` a doctor's link for a caregiver; anything else is a plain start.
   */
  async #startCommand(args: string): Promise<Reply[]> {
    const watch = /^g_(\S*)$/u.exec(args);
    if (watch !== null) {
      const opened = await this.#caregiver.open(watch[1] ?? '');
      // A person we do not know yet registers first; the link is good for three days.
      return opened ?? [this.#send(this.#chat.say('cg.registerFirst')), ...(await this.#start())];
    }
    const linked = /^i_(\S*)$/u.exec(args);
    return linked === null ? this.#start() : this.#startWithInvite(linked[1] ?? '');
  }

  async #startWithInvite(code: string): Promise<Reply[]> {
    const opened = await this.#invite.open(code);
    switch (opened.kind) {
      case 'offered':
        return opened.replies;
      case 'refused': {
        const note = this.#send(opened.text);
        // A person with an account is shown their menu; a new one carries on registering.
        return this.#s.profile !== null
          ? [note, this.#menuMessage()]
          : [note, ...(await this.#start())];
      }
      case 'carry': {
        // The link is good. Keep it through registration and offer it afterwards.
        this.#carry = opened.codeHash;
        const current = this.#s.conversation;
        if (current !== null) {
          await this.#remember(current.step, current.data);
        }
        return this.#start();
      }
    }
  }

  // Onboarding ---------------------------------------------------------------------------

  /** `/start`: wherever the person is, take them to the next thing they need to do. */
  async #start(): Promise<Reply[]> {
    const { user, profile, conversation } = this.#s;
    if (profile !== null) {
      await this.#chat.clear();
      return [this.#menuMessage()];
    }
    // A step that needs an account is meaningless without one (a half-lost conversation): start over.
    const stranded =
      user === null && ['FIRST_NAME', 'LAST_NAME', 'TIMEZONE'].includes(conversation?.step ?? '');
    if (conversation !== null && !stranded && this.#knownLocaleFor(conversation.step)) {
      return this.#showStep(conversation.step, conversation.data);
    }
    if (user !== null) {
      const consented = await this.#ctx.repos.consents.isGranted(
        asPatient(user.id),
        user.id,
        'PERSONAL_DATA',
        CONSENT_VERSION,
      );
      if (consented) {
        await this.#remember('FIRST_NAME', {});
        return [this.#send(t(this.#locale(), 'onboarding.askFirstName'))];
      }
      await this.#remember('CONSENT', {});
      return [this.#consentScreen()];
    }
    await this.#remember('LANGUAGE', {});
    return [this.#languagePrompt()];
  }

  #knownLocaleFor(step: OnboardingStep): boolean {
    return step === 'LANGUAGE' || this.#s.locale !== null;
  }

  #showStep(step: OnboardingStep, data: Record<string, unknown>): Reply[] {
    switch (step) {
      case 'LANGUAGE':
        return [this.#languagePrompt()];
      case 'CONSENT':
        return [this.#consentScreen()];
      case 'DECLINED':
        return [
          this.#send(t(this.#locale(), 'consent.declined'), [
            [this.#button(this.#locale(), 'consent.reconsider', { kind: 'consentAgain' })],
          ]),
        ];
      case 'FIRST_NAME':
        return [this.#send(t(this.#locale(), 'onboarding.askFirstName'))];
      case 'LAST_NAME':
        return [
          this.#send(t(this.#locale(), 'onboarding.askLastName', { name: textOf(data.firstName) })),
        ];
      case 'TIMEZONE':
        return [this.#timezoneQuestion()];
    }
  }

  async #chooseLanguage(locale: Locale): Promise<Reply[]> {
    const step = this.#s.conversation?.step;
    if (
      this.#s.user !== null ||
      (step !== 'LANGUAGE' && step !== 'CONSENT' && step !== 'DECLINED')
    ) {
      return [];
    }
    await this.#remember('CONSENT', { locale });
    return [this.#edit(this.#consentText(locale), this.#consentButtons(locale))];
  }

  async #acceptConsent(): Promise<Reply[]> {
    const locale = this.#s.locale;
    if (this.#s.conversation?.step !== 'CONSENT' || locale === null) {
      return [];
    }
    const { repos } = this.#ctx;
    const { user } = await repos.users.create(system, {
      telegramUserId: this.#s.incoming.telegramUserId,
      locale,
    });
    await repos.consents.record(asPatient(user.id), {
      userId: user.id,
      kind: 'PERSONAL_DATA',
      version: CONSENT_VERSION,
      decision: 'GRANTED',
      locale,
      context: 'ONBOARDING',
    });
    await this.#remember('FIRST_NAME', { locale });
    return [
      this.#edit(this.#consentText(locale), []),
      this.#send(t(locale, 'onboarding.askFirstName')),
    ];
  }

  async #declineConsent(): Promise<Reply[]> {
    const locale = this.#s.locale;
    if (this.#s.conversation?.step !== 'CONSENT' || locale === null) {
      return [];
    }
    await this.#remember('DECLINED', { locale });
    return [
      this.#edit(t(locale, 'consent.declined'), [
        [this.#button(locale, 'consent.reconsider', { kind: 'consentAgain' })],
      ]),
    ];
  }

  async #reconsider(): Promise<Reply[]> {
    const locale = this.#s.locale;
    if (this.#s.conversation?.step !== 'DECLINED' || locale === null) {
      return [];
    }
    await this.#remember('CONSENT', { locale });
    return [this.#edit(this.#consentText(locale), this.#consentButtons(locale))];
  }

  async #acceptFirstName(text: string): Promise<Reply[]> {
    const name = cleanName(text);
    const locale = this.#locale();
    if (name === null) {
      return [this.#send(t(locale, 'onboarding.invalidName'))];
    }
    await this.#remember('LAST_NAME', { locale, firstName: name });
    return [this.#send(t(locale, 'onboarding.askLastName', { name }))];
  }

  async #acceptLastName(text: string): Promise<Reply[]> {
    const lastName = cleanName(text);
    const locale = this.#locale();
    const firstName = this.#s.conversation?.data.firstName;
    const user = this.#s.user;
    if (user === null || typeof firstName !== 'string') {
      await this.#remember('FIRST_NAME', { locale });
      return [this.#send(t(locale, 'onboarding.askFirstName'))];
    }
    if (lastName === null) {
      return [this.#send(t(locale, 'onboarding.invalidName'))];
    }
    await this.#ctx.repos.patients.upsertProfile(asPatient(user.id), {
      userId: user.id,
      firstName,
      lastName,
    });
    await this.#remember('TIMEZONE', { locale, firstName });
    return [this.#timezoneQuestion()];
  }

  async #finishOnboarding(zone: string): Promise<Reply[]> {
    const { user, conversation } = this.#s;
    if (conversation?.step !== 'TIMEZONE' || user === null || !isValidTimeZone(zone)) {
      return [];
    }
    await this.#ctx.repos.users.confirmTimezone(asPatient(user.id), user.id, zone, this.#ctx.now);
    await this.#chat.clear();
    const locale = this.#locale();
    const name = textOf(conversation.data.firstName);
    const done = this.#edit(t(locale, 'onboarding.done', { name }), []);

    // A link opened before registering is offered now that there is an account to connect.
    if (this.#carry !== undefined) {
      const opened = await this.#invite.consider(this.#carry);
      if (opened.kind === 'offered') {
        return [done, ...opened.replies];
      }
      if (opened.kind === 'refused') {
        return [done, this.#send(opened.text), this.#menuMessage(name)];
      }
    }
    return [done, this.#menuMessage(name)];
  }

  // The registered person's menu and settings --------------------------------------------

  async #menu(target: MenuTarget): Promise<Reply[]> {
    if (!this.#registered()) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#locale();
    switch (target) {
      case 'home':
        return [this.#edit(this.#menuText(), this.#menuButtons())];
      case 'course':
        return this.#patientCourse.myCourse();
      case 'today':
        return this.#patientCourse.today();
      case 'history':
        return this.#history.list();
      case 'settings':
        return [
          this.#edit(t(locale, 'settings.title'), [
            [this.#button(locale, 'settings.language', { kind: 'settingsLanguage' })],
            [this.#button(locale, 'settings.timezone', { kind: 'settingsTimezone' })],
            [this.#button(locale, 'settings.caregivers', { kind: 'settingsCaregivers' })],
            [this.#button(locale, 'settings.privacy', { kind: 'settingsPrivacy' })],
            [this.#back('home')],
          ]),
        ];
      case 'doctor':
        return this.#doctor.section();
      case 'wards':
        return this.#caregiver.wards();
      case 'admin':
        return this.#admin.section();
    }
  }

  async #changeLanguage(locale: Locale): Promise<Reply[]> {
    const user = this.#s.user;
    if (!this.#registered() || user === null) {
      return [];
    }
    await this.#ctx.repos.users.setLocale(asPatient(user.id), user.id, locale);
    return [
      this.#edit(t(locale, 'settings.languageChanged'), [
        [this.#button(locale, 'common.back', { kind: 'menu', target: 'settings' })],
      ]),
    ];
  }

  async #changeTimezone(code: string): Promise<Reply[]> {
    const user = this.#s.user;
    const choice = timezoneByCode(code);
    if (
      !this.#registered() ||
      user === null ||
      choice === undefined ||
      !isValidTimeZone(choice.zone)
    ) {
      return [];
    }
    await this.#ctx.repos.users.confirmTimezone(
      asPatient(user.id),
      user.id,
      choice.zone,
      this.#ctx.now,
    );
    const locale = this.#locale();
    return [
      this.#edit(t(locale, 'settings.timezoneChanged', { zone: t(locale, choice.label) }), [
        [this.#back('settings')],
      ]),
    ];
  }

  #editTimezonePicker(): Reply {
    const locale = this.#locale();
    return this.#edit(
      t(locale, 'settings.timezoneCurrent', {
        zone: this.#zoneLabel(this.#s.user?.timezone ?? DEFAULT_TIMEZONE),
      }),
      [...this.#cityButtons('setTimezone'), [this.#back('settings')]],
    );
  }

  // Building replies ---------------------------------------------------------------------

  #registered(): boolean {
    return this.#s.profile !== null && this.#s.user !== null;
  }

  #onboardingStep(step: OnboardingStep): boolean {
    return this.#s.conversation?.step === step && this.#s.user !== null;
  }

  #locale(): Locale {
    return this.#chat.locale();
  }

  /** Remembers an onboarding step, and the invitation link being carried through it, if any. */
  async #remember(step: OnboardingStep, data: Record<string, unknown>): Promise<void> {
    await this.#chat.remember(
      'ONBOARDING',
      step,
      this.#carry === undefined ? data : { ...data, invite: this.#carry },
    );
  }

  #send(text: string, buttons?: readonly (readonly Button[])[]): Reply {
    return this.#chat.send(text, buttons);
  }

  #edit(text: string, buttons?: readonly (readonly Button[])[]): Reply {
    return this.#chat.edit(text, buttons);
  }

  #button(locale: Locale, key: MessageKey, callback: Callback): Button {
    return this.#chat.button(locale, key, callback);
  }

  #back(target: MenuTarget): Button {
    return this.#chat.back(target);
  }

  #languageButtons(kind: 'language' | 'setLanguage'): Button[] {
    return [
      { text: 'Русский', data: encodeCallback({ kind, locale: 'ru' }) },
      { text: 'Oʻzbekcha', data: encodeCallback({ kind, locale: 'uz' }) },
    ];
  }

  #languagePrompt(): Reply {
    return this.#send(LANGUAGE_PROMPT, [this.#languageButtons('language')]);
  }

  #consentText(locale: Locale): string {
    return `${t(locale, 'welcome.text')}\n\n${t(locale, 'consent.title')}\n\n${t(locale, 'consent.text')}`;
  }

  #consentButtons(locale: Locale): Button[][] {
    return [
      [this.#button(locale, 'consent.accept', { kind: 'consent', accepted: true })],
      [this.#button(locale, 'consent.decline', { kind: 'consent', accepted: false })],
    ];
  }

  #consentScreen(): Reply {
    const locale = this.#locale();
    return this.#send(this.#consentText(locale), this.#consentButtons(locale));
  }

  #zoneLabel(zone: string): string {
    const choice = timezoneByZone(zone);
    return choice === undefined ? zone : t(this.#locale(), choice.label);
  }

  #timezoneQuestion(): Reply {
    const locale = this.#locale();
    const zone = this.#s.user?.timezone ?? DEFAULT_TIMEZONE;
    return this.#send(t(locale, 'onboarding.askTimezone', { zone: this.#zoneLabel(zone) }), [
      [this.#button(locale, 'timezone.confirm', { kind: 'timezoneConfirm' })],
      [this.#button(locale, 'timezone.other', { kind: 'timezoneOther' })],
    ]);
  }

  #cityButtons(kind: 'timezone' | 'setTimezone'): Button[][] {
    const locale = this.#locale();
    return TIMEZONE_CHOICES.map((choice) => [
      { text: t(locale, choice.label), data: encodeCallback({ kind, code: choice.code }) },
    ]);
  }

  #menuText(name?: string): string {
    const locale = this.#locale();
    const who = name ?? this.#s.profile?.firstName ?? '';
    return `${t(locale, 'menu.hello', { name: who })}\n${t(locale, 'menu.title')}`;
  }

  #menuButtons(): Button[][] {
    const locale = this.#locale();
    const row = (key: MessageKey, target: MenuTarget): Button[] => [
      this.#button(locale, key, { kind: 'menu', target }),
    ];
    return [
      row('menu.course', 'course'),
      row('menu.today', 'today'),
      row('menu.history', 'history'),
      // Only for a person some patient has allowed to watch: nobody else needs the button.
      ...(this.#s.watching ? [row('menu.wards', 'wards')] : []),
      row('menu.settings', 'settings'),
      row('menu.doctor', 'doctor'),
      // Only for an active administrator: nobody else is told the section exists.
      ...(this.#s.admin ? [row('admin.menu', 'admin')] : []),
    ];
  }

  #menuMessage(name?: string): Reply {
    return this.#send(this.#menuText(name), this.#menuButtons());
  }

  async #unsupported(): Promise<Reply[]> {
    if (this.#s.locale === null) {
      return this.#start();
    }
    return [this.#send(t(this.#locale(), 'error.unsupported'))];
  }
}
