import { INVITATION_TTL_MS, type ClinicianSummary } from '@medcourse/db';
import { t } from '@medcourse/i18n';
import { encodeCallback, type DoctorAction } from './callbacks';
import { cleanName, cleanNote } from './names';
import { CaregiverFlow } from './caregiver';
import { Chat, asClinician, asPatient, clip, fullName } from './session';
import type { Button, Reply } from './types';

/** A list longer than this is cut, with a note: a Telegram message holds 4096 characters. */
const LIST_LINES = 25;
const BUTTON_NAME = 22;
const HOUR_MS = 3_600_000;

/** What a person with a doctor profile can do right now. */
export function standing(
  clinician: ClinicianSummary | null,
): 'NONE' | 'PENDING' | 'REVOKED' | 'SUSPENDED' | 'GOOD' {
  if (clinician === null) return 'NONE';
  if (clinician.verificationStatus === 'PENDING') return 'PENDING';
  if (clinician.verificationStatus === 'REVOKED') return 'REVOKED';
  return clinician.clinicStatus === 'ACTIVE' ? 'GOOD' : 'SUSPENDED';
}

/**
 * The doctor's side: applying, the doctor's menu, invitations, and answering "is this the person
 * you invited?". Whether a doctor may do anything is decided by the database on every call
 * (verification, practice status, relationship); the checks here only choose what to say.
 */
export class DoctorFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  /** Needs a registered person: the doctor profile reuses the name they gave when registering. */
  #registered(): { userId: string } | null {
    const { user, profile } = this.#chat.s;
    return user !== null && profile !== null ? { userId: user.id } : null;
  }

  // The section ---------------------------------------------------------------------------

  /** The doctor's section: what it shows depends on how far along the person is. */
  async section(): Promise<Reply[]> {
    if (this.#registered() === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const home: Button[][] = [[this.#chat.back('home')]];

    switch (standing(this.#chat.s.clinician)) {
      case 'NONE':
        return [
          this.#chat.respond(t(locale, 'doctor.intro'), [
            [this.#chat.button(locale, 'doctor.register', { kind: 'doctor', action: 'register' })],
            ...home,
          ]),
        ];
      case 'PENDING':
        return [this.#chat.respond(t(locale, 'doctor.pending'), home)];
      case 'REVOKED':
        return [this.#chat.respond(t(locale, 'doctor.revoked'), home)];
      case 'SUSPENDED':
        return [this.#chat.respond(t(locale, 'doctor.suspended'), home)];
      case 'GOOD':
        return [this.#chat.respond(t(locale, 'doctor.menuTitle'), this.#menuButtons())];
    }
  }

  #menuButtons(): Button[][] {
    const locale = this.#chat.locale();
    const row = (
      key:
        | 'doctor.newCourse'
        | 'doctor.courses'
        | 'doctor.invite'
        | 'doctor.patients'
        | 'doctor.invitations',
      action: DoctorAction,
    ) => [this.#chat.button(locale, key, { kind: 'doctor', action })];
    return [
      row('doctor.newCourse', 'newCourse'),
      row('doctor.courses', 'courses'),
      row('doctor.invite', 'invite'),
      row('doctor.patients', 'patients'),
      row('doctor.invitations', 'invitations'),
      [this.#chat.back('home')],
    ];
  }

  #backToDoctor(): Button[][] {
    return [
      [this.#chat.button(this.#chat.locale(), 'common.back', { kind: 'menu', target: 'doctor' })],
    ];
  }

  // Buttons -------------------------------------------------------------------------------

  async onAction(action: DoctorAction): Promise<Reply[]> {
    if (this.#registered() === null) {
      return [];
    }
    switch (action) {
      case 'register':
        return this.#askNote();
      case 'invite':
        return this.#askLabel();
      case 'skipLabel':
        return this.#skipLabel();
      case 'patients':
        return this.#patients();
      case 'invitations':
        return this.#invitations();
      case 'newCourse':
      case 'courses':
        // Courses have their own flow; the handler sends these there.
        return [];
    }
  }

  /** The doctor says whether the patient who accepted is the person they invited. */
  async onDecision(relationshipId: string, accept: boolean): Promise<Reply[]> {
    const { user, profile, clinician } = this.#chat.s;
    if (user === null || profile === null) {
      return [];
    }
    const { repos, now } = this.#chat.ctx;
    const locale = this.#chat.locale();

    const decision = await repos.care.decide(asClinician(user.id), { relationshipId, accept, now });
    if (decision === null) {
      return [this.#chat.edit(t(locale, 'doctor.decisionStale'))];
    }
    const name = fullName(decision.patient);
    const confirmed = decision.status === 'ACTIVE';
    const sameAsAsked = confirmed === accept && decision.status !== 'PENDING';
    const reply = this.#chat.edit(
      t(
        locale,
        sameAsAsked ? (confirmed ? 'doctor.confirmed' : 'doctor.rejected') : 'doctor.decisionStale',
        {
          name,
        },
      ),
    );
    if (!decision.changed || clinician === null) {
      return [reply];
    }
    // Only the first answer tells the patient; repeats change nothing and say nothing.
    const patientLocale = decision.patient.locale;
    return [
      reply,
      this.#chat.sendTo(
        decision.patient.telegramUserId,
        confirmed
          ? t(patientLocale, 'invite.connected', { doctor: fullName(clinician) })
          : t(patientLocale, 'invite.rejected'),
      ),
    ];
  }

  async onRevoke(invitationId: string): Promise<Reply[]> {
    const { user, profile } = this.#chat.s;
    if (user === null || profile === null) {
      return [];
    }
    const { repos, now } = this.#chat.ctx;
    const locale = this.#chat.locale();
    const revoked = await repos.invitations.revoke(asClinician(user.id), invitationId, now);
    return [
      this.#chat.edit(
        t(locale, revoked ? 'doctor.invitationRevoked' : 'doctor.invitationGone'),
        this.#backToDoctor(),
      ),
    ];
  }

  // Applying ------------------------------------------------------------------------------

  async #askNote(): Promise<Reply[]> {
    const locale = this.#chat.locale();
    if (standing(this.#chat.s.clinician) !== 'NONE') {
      return this.section();
    }
    await this.#chat.remember('DOCTOR', 'NOTE', {});
    return [this.#chat.edit(t(locale, 'doctor.askNote'), [[this.#chat.back('doctor')]])];
  }

  async #acceptNote(text: string): Promise<Reply[]> {
    const person = this.#registered();
    const locale = this.#chat.locale();
    const note = cleanNote(text);
    if (person === null) {
      return [];
    }
    if (note === null) {
      return [this.#chat.send(t(locale, 'doctor.invalidNote'))];
    }
    const result = await this.#chat.ctx.repos.clinicians.register(asPatient(person.userId), {
      userId: person.userId,
      note,
    });
    await this.#chat.clear();
    if (result === null) {
      return [this.#chat.send(t(locale, 'doctor.notAllowed'))];
    }
    return [
      this.#chat.send(t(locale, result.created ? 'doctor.applied' : 'doctor.pending'), [
        [this.#chat.back('home')],
      ]),
    ];
  }

  // Inviting ------------------------------------------------------------------------------

  async #askLabel(): Promise<Reply[]> {
    const locale = this.#chat.locale();
    if (standing(this.#chat.s.clinician) !== 'GOOD') {
      return [this.#chat.edit(t(locale, 'doctor.notAllowed'), this.#backToDoctor())];
    }
    await this.#chat.remember('DOCTOR', 'LABEL', {});
    return [
      this.#chat.edit(t(locale, 'doctor.askLabel'), [
        [this.#chat.button(locale, 'doctor.skip', { kind: 'doctor', action: 'skipLabel' })],
        [this.#chat.back('doctor')],
      ]),
    ];
  }

  async #skipLabel(): Promise<Reply[]> {
    return this.#awaitingLabel() ? this.#createInvitation(null) : [];
  }

  #awaitingLabel(): boolean {
    const talk = this.#chat.s.talk;
    return talk?.flow === 'DOCTOR' && talk.step === 'LABEL';
  }

  async #acceptLabel(text: string): Promise<Reply[]> {
    const label = cleanName(text);
    const locale = this.#chat.locale();
    if (label === null) {
      return [
        this.#chat.send(t(locale, 'doctor.invalidLabel'), [
          [this.#chat.button(locale, 'doctor.skip', { kind: 'doctor', action: 'skipLabel' })],
        ]),
      ];
    }
    return this.#createInvitation(label);
  }

  async #createInvitation(label: string | null): Promise<Reply[]> {
    const { user } = this.#chat.s;
    const { repos, now, botUsername } = this.#chat.ctx;
    const locale = this.#chat.locale();
    if (user === null) {
      return [];
    }

    const created = await repos.invitations.create(asClinician(user.id), { label, now });
    await this.#chat.clear();
    switch (created.status) {
      case 'NOT_ALLOWED':
        return [this.#chat.respond(t(locale, 'doctor.notAllowed'), this.#backToDoctor())];
      case 'LIMIT':
        return [this.#chat.respond(t(locale, 'doctor.inviteLimit'), this.#backToDoctor())];
      case 'CREATED':
        return [
          this.#chat.respond(
            t(locale, 'doctor.inviteReady', {
              link: `https://t.me/${botUsername}?start=i_${created.code}`,
              hours: INVITATION_TTL_MS / HOUR_MS,
            }),
            this.#backToDoctor(),
          ),
        ];
    }
  }

  // Lists ---------------------------------------------------------------------------------

  async #patients(): Promise<Reply[]> {
    const { user } = this.#chat.s;
    const locale = this.#chat.locale();
    if (user === null) {
      return [];
    }
    if (standing(this.#chat.s.clinician) !== 'GOOD') {
      return [this.#chat.edit(t(locale, 'doctor.notAllowed'), this.#backToDoctor())];
    }
    const list = await this.#chat.ctx.repos.care.listForClinician(asClinician(user.id));
    if (list.length === 0) {
      return [this.#chat.edit(t(locale, 'doctor.patientsNone'), this.#backToDoctor())];
    }

    const shown = list.slice(0, LIST_LINES);
    const lines = shown.map((entry) =>
      t(locale, entry.status === 'ACTIVE' ? 'doctor.patientActive' : 'doctor.patientPending', {
        name: clip(fullName(entry), 60),
      }),
    );
    if (list.length > shown.length) {
      lines.push(t(locale, 'doctor.more', { count: list.length - shown.length }));
    }
    // One row of answer buttons for each person still waiting to be confirmed.
    const answers: Button[][] = shown.flatMap((entry) =>
      entry.status === 'PENDING'
        ? [
            [
              {
                text: `✅ ${clip(`${entry.lastName} ${entry.firstName}`, BUTTON_NAME)}`,
                data: this.#decision(entry.relationshipId, true),
              },
              {
                text: `✖️ ${clip(`${entry.lastName} ${entry.firstName}`, BUTTON_NAME)}`,
                data: this.#decision(entry.relationshipId, false),
              },
            ],
          ]
        : [],
    );
    // And, for each confirmed patient, the way to add someone who will watch over their course.
    const caregiver = new CaregiverFlow(this.#chat);
    const watchers: Button[][] = shown.flatMap((entry) =>
      entry.status === 'ACTIVE' ? [[caregiver.inviteButton(entry)]] : [],
    );
    // And, where the patient allows it, the summaries of their earlier courses.
    const earlier: Button[][] = shown.flatMap((entry) =>
      entry.status === 'ACTIVE' && entry.sharesHistory
        ? [
            [
              this.#chat.button(
                locale,
                'past.button',
                { kind: 'pastCourses', relationshipId: entry.relationshipId },
                { name: clip(`${entry.lastName} ${entry.firstName}`, BUTTON_NAME) },
              ),
            ],
          ]
        : [],
    );
    return [
      this.#chat.edit(`${t(locale, 'doctor.patientsTitle')}\n\n${lines.join('\n')}`, [
        ...answers,
        ...watchers,
        ...earlier,
        ...this.#backToDoctor(),
      ]),
    ];
  }

  #decision(relationshipId: string, accept: boolean): string {
    return encodeCallback({ kind: 'doctorDecision', relationshipId, accept });
  }

  async #invitations(): Promise<Reply[]> {
    const { user } = this.#chat.s;
    const { repos, now } = this.#chat.ctx;
    const locale = this.#chat.locale();
    if (user === null) {
      return [];
    }
    if (standing(this.#chat.s.clinician) !== 'GOOD') {
      return [this.#chat.edit(t(locale, 'doctor.notAllowed'), this.#backToDoctor())];
    }
    const open = await repos.invitations.listOpen(asClinician(user.id), now);
    if (open.length === 0) {
      return [this.#chat.edit(t(locale, 'doctor.invitationsNone'), this.#backToDoctor())];
    }

    const nameOf = (label: string | null): string => label ?? t(locale, 'doctor.noLabel');
    const lines = open.slice(0, LIST_LINES).map((entry) =>
      t(locale, 'doctor.invitationLine', {
        label: clip(nameOf(entry.label), 60),
        hours: Math.max(1, Math.ceil((entry.expiresAt.getTime() - now.getTime()) / HOUR_MS)),
      }),
    );
    const revokes: Button[][] = open
      .slice(0, LIST_LINES)
      .map((entry) => [
        this.#chat.button(
          locale,
          'doctor.revokeButton',
          { kind: 'revokeInvitation', invitationId: entry.id },
          { label: clip(nameOf(entry.label), BUTTON_NAME) },
        ),
      ]);
    return [
      this.#chat.edit(`${t(locale, 'doctor.invitationsTitle')}\n\n${lines.join('\n')}`, [
        ...revokes,
        ...this.#backToDoctor(),
      ]),
    ];
  }

  // Typed answers -------------------------------------------------------------------------

  /** What the person typed, if they are in the middle of one of the doctor's exchanges. */
  async onText(text: string): Promise<Reply[] | null> {
    const talk = this.#chat.s.talk;
    if (talk?.flow !== 'DOCTOR' || this.#registered() === null) {
      return null;
    }
    switch (talk.step) {
      case 'NOTE':
        return this.#acceptNote(text);
      case 'LABEL':
        return this.#acceptLabel(text);
      default:
        // An exchange this version does not know: drop it instead of treating text as its answer.
        await this.#chat.clear();
        return null;
    }
  }
}
