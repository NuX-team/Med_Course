import { hashInviteCode, looksLikeInviteCode, type Actor, type WardDay } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  localDateOf,
} from '@medcourse/schedule';
import { encodeCallback } from './callbacks';
import { doseText, joinBlocks } from './card';
import { standing } from './doctor';
import { figureText } from './history';
import { isCodeHash } from './invite';
import { Chat, asClinician, asPatient, clip, fullName, system, textOf } from './session';
import type { Button, Reply } from './types';

const BUTTON_NAME = 24;

const asCaregiver = (userId: string): Actor => ({ kind: 'CAREGIVER', userId });

/** One ward's day as the caregiver reads it: the schedule and what became of each dose. */
export function wardText(locale: Locale, day: WardDay, now: Date): string[] {
  const zone = day.courses[0]?.timezone ?? 'UTC';
  const blocks = [
    t(locale, 'cg.wardTitle', {
      patient: fullName(day.patient),
      date: formatLocalDate(localDateOf(now, zone)),
    }),
  ];
  if (day.courses.length === 0) {
    blocks.push(t(locale, 'cg.wardNoCourse'));
  }
  for (const course of day.courses) {
    blocks.push(
      [
        t(locale, 'cg.wardCourse', { status: t(locale, `status.${course.status}`) }),
        ...(course.doses.length === 0
          ? [t(locale, 'today.nothing')]
          : course.doses.map((dose) => {
              // "Skipped by you" is the patient's wording; a caregiver reads who skipped it.
              const status =
                dose.status === 'SKIPPED'
                  ? t(locale, 'history.skippedByPatient')
                  : t(locale, `dose.${dose.status}`);
              return `${formatLocalTime(dose.scheduledAt, course.timezone)} — ${dose.displayName}, ${doseText(locale, dose)} · ${status}`;
            })),
        figureText(locale, course.adherence),
      ].join('\n'),
    );
  }
  blocks.push(t(locale, 'cg.readOnly'));
  return joinBlocks(blocks);
}

/**
 * Caregivers (TZ §5.6, D-14), three parties in one flow: the doctor issues a link, the person
 * who opens it agrees to watch, and the patient allows or refuses. Only then does the caregiver
 * see anything, and what they see is read-only. Every rule is in the repository; this turns its
 * verdicts into messages and tells each party, in their own language, what the others did.
 */
export class CaregiverFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  #person(): { userId: string } | null {
    const { user, profile } = this.#chat.s;
    return user !== null && profile !== null ? { userId: user.id } : null;
  }

  #home(): Button[][] {
    return [[this.#chat.back('home')]];
  }

  // The doctor ----------------------------------------------------------------------------

  /** A button under the doctor's list of patients: "caregiver for this patient". */
  inviteButton(entry: { relationshipId: string; firstName: string; lastName: string }): Button {
    return this.#chat.button(
      this.#chat.locale(),
      'cg.inviteButton',
      { kind: 'caregiverInvite', relationshipId: entry.relationshipId },
      { name: clip(`${entry.lastName} ${entry.firstName}`, BUTTON_NAME) },
    );
  }

  /** The doctor asks for a link to hand to the person who will watch over this patient. */
  async invite(relationshipId: string): Promise<Reply[]> {
    const { user, profile, clinician } = this.#chat.s;
    if (user === null || profile === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const back = [
      [this.#chat.button(locale, 'common.back', { kind: 'doctor', action: 'patients' })],
    ];
    if (standing(clinician) !== 'GOOD') {
      return [this.#chat.respond(t(locale, 'doctor.notAllowed'), back)];
    }
    await this.#chat.clearSideConversation();
    const { repos, now, botUsername } = this.#chat.ctx;
    const created = await repos.caregivers.invite(asClinician(user.id), { relationshipId, now });
    if (created.status === 'NOT_ALLOWED') {
      return [this.#chat.respond(t(locale, 'doctor.notAllowed'), back)];
    }
    if (created.status === 'LIMIT') {
      return [this.#chat.respond(t(locale, 'cg.linkLimit'), back)];
    }
    // A message of its own, so the link can be forwarded as it is.
    return [
      this.#chat.send(
        t(locale, 'cg.linkCreated', {
          patient: fullName(created.patient),
          link: `https://t.me/${botUsername}?start=g_${created.code}`,
          until: formatLocalDateTime(created.expiresAt, user.timezone),
        }),
        back,
      ),
    ];
  }

  // The person the link is for ------------------------------------------------------------

  /**
   * `/start g_<code>`. The code is hashed at once and never stored. A person without an account
   * is asked to register first: nothing about the patient is said to someone we do not know.
   * Returns the replies, or null when the person has no account (the caller starts onboarding).
   */
  async open(code: string): Promise<Reply[] | null> {
    const person = this.#person();
    const { repos, now } = this.#chat.ctx;
    const { telegramUserId } = this.#chat.s.incoming;
    const say = (text: string): Reply[] => [this.#chat.send(text, this.#home())];

    if (person === null) {
      return null;
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    if (!looksLikeInviteCode(code)) {
      // Cannot be a real code, but trying one still counts as a guess.
      if (await repos.invitations.throttled(system, telegramUserId, now)) {
        return say(t(locale, 'invite.throttled'));
      }
      await repos.invitations.noteFailure(system, telegramUserId, now);
      return say(t(locale, 'cg.linkInvalid'));
    }
    const codeHash = hashInviteCode(code);
    const check = await repos.caregivers.inspect(asCaregiver(person.userId), {
      telegramUserId,
      codeHash,
      now,
    });
    switch (check.status) {
      case 'THROTTLED':
        return say(t(locale, 'invite.throttled'));
      case 'INVALID':
        return say(t(locale, 'cg.linkInvalid'));
      case 'OWN':
        return say(t(locale, 'cg.own'));
      case 'ALREADY':
        return say(t(locale, 'cg.already', { patient: fullName(check.patient) }));
      case 'OK':
        await this.#chat.remember('CAREGIVER', 'CONFIRM', { hash: codeHash });
        return [
          this.#chat.send(
            t(locale, 'cg.offer', {
              doctor: fullName(check.clinician),
              patient: fullName(check.patient),
            }),
            [
              [this.#chat.button(locale, 'cg.accept', { kind: 'caregiverAnswer', accepted: true })],
              [
                this.#chat.button(locale, 'cg.decline', {
                  kind: 'caregiverAnswer',
                  accepted: false,
                }),
              ],
            ],
          ),
        ];
    }
  }

  /** "Agree" or "decline" under the offer. A press with nothing pending is ignored. */
  async answer(accepted: boolean): Promise<Reply[]> {
    const person = this.#person();
    const { talk, incoming } = this.#chat.s;
    if (person === null || talk?.flow !== 'CAREGIVER' || talk.step !== 'CONFIRM') {
      return [];
    }
    const codeHash = textOf(talk.data.hash);
    await this.#chat.clear();
    if (!isCodeHash(codeHash)) {
      return [];
    }
    const locale = this.#chat.locale();
    if (!accepted) {
      return [this.#chat.edit(t(locale, 'cg.declined'), this.#home())];
    }
    const outcome = await this.#chat.ctx.repos.caregivers.redeem(asCaregiver(person.userId), {
      telegramUserId: incoming.telegramUserId,
      codeHash,
      now: this.#chat.ctx.now,
    });
    switch (outcome.status) {
      case 'THROTTLED':
        return [this.#chat.edit(t(locale, 'invite.throttled'), this.#home())];
      case 'INVALID':
        return [this.#chat.edit(t(locale, 'cg.linkInvalid'), this.#home())];
      case 'OWN':
        return [this.#chat.edit(t(locale, 'cg.own'), this.#home())];
      case 'ALREADY':
        return [
          this.#chat.edit(
            t(locale, 'cg.already', { patient: fullName(outcome.patient) }),
            this.#home(),
          ),
        ];
      case 'REQUESTED': {
        const { patient, relationshipId } = outcome;
        const decision = (to: Locale, key: 'cg.allow' | 'cg.refuse', allow: boolean): Button[] => [
          this.#chat.button(to, key, { kind: 'caregiverDecision', relationshipId, allow }),
        ];
        return [
          this.#chat.edit(
            t(locale, 'cg.requested', { patient: fullName(outcome.patientName) }),
            this.#home(),
          ),
          // The patient is asked, in their own language: nothing opens without their yes.
          ...(patient === null
            ? []
            : [
                this.#chat.sendTo(
                  patient.telegramUserId,
                  t(patient.locale, 'cg.askPatient', {
                    doctor: fullName(outcome.clinician),
                    caregiver: fullName(outcome.caregiver),
                  }),
                  [
                    decision(patient.locale, 'cg.allow', true),
                    decision(patient.locale, 'cg.refuse', false),
                  ],
                ),
              ]),
        ];
      }
    }
  }

  // The patient ---------------------------------------------------------------------------

  /** The patient allows or refuses a caregiver who is waiting. */
  async decide(relationshipId: string, allow: boolean): Promise<Reply[]> {
    const person = this.#person();
    if (person === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const decision = await this.#chat.ctx.repos.caregivers.decide(asPatient(person.userId), {
      relationshipId,
      allow,
      now: this.#chat.ctx.now,
    });
    if (decision.status === 'NOT_AVAILABLE') {
      return [this.#chat.edit(t(locale, 'cg.notAvailable'), this.#home())];
    }
    const { caregiver } = decision;
    const names = { caregiver: fullName(decision.caregiverName) };
    return [
      this.#chat.edit(
        t(locale, decision.status === 'ALLOWED' ? 'cg.allowed' : 'cg.refused', names),
        this.#home(),
      ),
      // Told once: a repeated tap changes nothing and says nothing more.
      ...(decision.changed && caregiver !== null
        ? [
            this.#chat.sendTo(
              caregiver.telegramUserId,
              t(
                caregiver.locale,
                decision.status === 'ALLOWED' ? 'cg.youAllowed' : 'cg.youRefused',
                { patient: fullName(decision.patientName) },
              ),
              decision.status === 'ALLOWED'
                ? [
                    [
                      this.#chat.button(caregiver.locale, 'menu.wards', {
                        kind: 'menu',
                        target: 'wards',
                      }),
                    ],
                  ]
                : undefined,
            ),
          ]
        : []),
    ];
  }

  /** Settings: who watches over my course, with a way to end each one's access. */
  async list(): Promise<Reply[]> {
    const person = this.#person();
    if (person === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const back = [[this.#chat.back('settings')]];
    const caregivers = await this.#chat.ctx.repos.caregivers.listForPatient(
      asPatient(person.userId),
    );
    if (caregivers.length === 0) {
      return [this.#chat.edit(t(locale, 'cg.listNone'), back)];
    }
    return [
      this.#chat.edit(
        [
          t(locale, 'cg.listTitle'),
          ...caregivers.map((entry) =>
            t(locale, entry.status === 'ACTIVE' ? 'cg.listActive' : 'cg.listPending', {
              name: clip(fullName(entry), 60),
            }),
          ),
        ].join('\n'),
        [
          ...caregivers.map((entry) => [
            this.#chat.button(
              locale,
              'cg.revokeButton',
              { kind: 'caregiverRevoke', relationshipId: entry.relationshipId },
              { name: clip(fullName(entry), 18) },
            ),
          ]),
          ...back,
        ],
      ),
    ];
  }

  /** The patient ends one caregiver's access. */
  async revoke(relationshipId: string): Promise<Reply[]> {
    const person = this.#person();
    if (person === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const back = [[this.#chat.button(locale, 'common.back', { kind: 'settingsCaregivers' })]];
    const result = await this.#chat.ctx.repos.caregivers.revoke(asPatient(person.userId), {
      relationshipId,
    });
    if (result.status === 'NOT_AVAILABLE') {
      return [this.#chat.edit(t(locale, 'cg.notAvailable'), back)];
    }
    const { caregiver } = result;
    return [
      this.#chat.edit(t(locale, 'cg.revoked', { caregiver: fullName(result.caregiverName) }), back),
      ...(caregiver === null
        ? []
        : [
            this.#chat.sendTo(
              caregiver.telegramUserId,
              t(caregiver.locale, 'cg.youRevoked', { patient: fullName(result.patientName) }),
            ),
          ]),
    ];
  }

  // The caregiver -------------------------------------------------------------------------

  /** "Wards": the patients this person is allowed to watch over. */
  async wards(): Promise<Reply[]> {
    const person = this.#person();
    if (person === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const wards = await this.#chat.ctx.repos.caregivers.wards(asCaregiver(person.userId));
    if (wards.length === 0) {
      return [this.#chat.edit(t(locale, 'cg.wardsNone'), this.#home())];
    }
    return [
      this.#chat.edit(t(locale, 'cg.wardsTitle'), [
        ...wards.map((ward) => [
          {
            text: clip(`${ward.lastName} ${ward.firstName}`, 30),
            data: encodeCallback({ kind: 'ward', patientId: ward.patientId }),
          },
        ]),
        ...this.#home(),
      ]),
    ];
  }

  /** One ward's day. Nothing here can be pressed to change anything. */
  async ward(patientId: string): Promise<Reply[]> {
    const person = this.#person();
    if (person === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const back = [[this.#chat.button(locale, 'common.back', { kind: 'menu', target: 'wards' })]];
    const day = await repos.caregivers.wardDay(asCaregiver(person.userId), { patientId, now });
    if (day === null) {
      return [this.#chat.edit(t(locale, 'cg.wardGone'), back)];
    }
    const chunks = wardText(locale, day, now);
    const buttons = [
      [this.#chat.button(locale, 'cg.refresh', { kind: 'ward', patientId })],
      ...back,
    ];
    if (chunks.length === 1) {
      return [this.#chat.edit(chunks[0] ?? '', buttons)];
    }
    return chunks.map((chunk, index) =>
      index === chunks.length - 1 ? this.#chat.send(chunk, buttons) : this.#chat.send(chunk),
    );
  }
}
