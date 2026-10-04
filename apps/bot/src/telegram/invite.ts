import { hashInviteCode, looksLikeInviteCode, type InviteCheck } from '@medcourse/db';
import { t } from '@medcourse/i18n';
import { Chat, asPatient, fullName, system, textOf } from './session';
import type { Reply } from './types';

/** A code reaches the database as the SHA-256 of what was typed: 64 lowercase hex characters. */
const CODE_HASH = /^[0-9a-f]{64}$/;

/** Is this value a code hash this bot stored (and so safe to look up)? */
export function isCodeHash(value: unknown): value is string {
  return typeof value === 'string' && CODE_HASH.test(value);
}

/** What happened when a link was opened. */
export type OpenedLink =
  /** A registered person was shown who is inviting them and asked to decide. */
  | { readonly kind: 'offered'; readonly replies: Reply[] }
  /** Nothing to offer: this text says why. */
  | { readonly kind: 'refused'; readonly text: string }
  /** The link is fine but the person has no account yet: keep it through registration. */
  | { readonly kind: 'carry'; readonly codeHash: string };

/**
 * The patient's side of an invitation: opening a link, seeing who is inviting, and accepting.
 * The raw code is hashed at once and never stored or logged; only the hash is remembered.
 */
export class InviteFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  /** `/start i_<code>`. */
  async open(code: string): Promise<OpenedLink> {
    const { repos, now } = this.#chat.ctx;
    const { telegramUserId } = this.#chat.s.incoming;

    if (!looksLikeInviteCode(code)) {
      // Cannot be a real code, but typing one still counts as a guess.
      if (await repos.invitations.throttled(system, telegramUserId, now)) {
        return { kind: 'refused', text: this.#chat.say('invite.throttled') };
      }
      await repos.invitations.noteFailure(system, telegramUserId, now);
      return { kind: 'refused', text: this.#chat.say('invite.invalid') };
    }
    return this.consider(hashInviteCode(code));
  }

  /** What to do with a code, given who is asking (a registered person, or not yet). */
  async consider(codeHash: string): Promise<OpenedLink> {
    const { repos, now } = this.#chat.ctx;
    const { incoming, user, profile } = this.#chat.s;
    const patientUserId = user !== null && profile !== null ? user.id : null;

    const check = await repos.invitations.inspect(system, {
      telegramUserId: incoming.telegramUserId,
      codeHash,
      patientUserId,
      now,
    });
    if (check.result !== 'OPEN') {
      return { kind: 'refused', text: this.#refusal(check) };
    }
    if (patientUserId === null) {
      return { kind: 'carry', codeHash };
    }

    // Who is inviting is shown only to a person who has an account and so knows who is asking.
    await this.#chat.remember('INVITE', 'CONFIRM', { hash: codeHash });
    const locale = this.#chat.locale();
    return {
      kind: 'offered',
      replies: [
        this.#chat.send(t(locale, 'invite.offer', { doctor: fullName(check.doctor) }), [
          [this.#chat.button(locale, 'invite.accept', { kind: 'inviteAnswer', accepted: true })],
          [this.#chat.button(locale, 'invite.decline', { kind: 'inviteAnswer', accepted: false })],
        ]),
      ],
    };
  }

  /** The patient pressed "connect" or "not now". A press with nothing pending is ignored. */
  async answer(accepted: boolean): Promise<Reply[]> {
    const { talk, user, profile, incoming } = this.#chat.s;
    if (user === null || profile === null || talk?.flow !== 'INVITE' || talk.step !== 'CONFIRM') {
      return [];
    }
    const codeHash = textOf(talk.data.hash);
    const locale = this.#chat.locale();
    const home = [[this.#chat.back('home')]];

    if (!isCodeHash(codeHash)) {
      await this.#chat.clear();
      return [];
    }
    if (!accepted) {
      await this.#chat.clear();
      return [this.#chat.edit(t(locale, 'invite.declined'), home)];
    }

    const outcome = await this.#chat.ctx.repos.invitations.redeem(asPatient(user.id), {
      telegramUserId: incoming.telegramUserId,
      codeHash,
      now: this.#chat.ctx.now,
    });
    await this.#chat.clear();

    if (outcome.result !== 'ACCEPTED') {
      return [this.#chat.edit(this.#refusal(outcome), home)];
    }

    // The doctor is told in their language, and asked whether this is the person they meant.
    const doctorLocale = outcome.doctor.locale;
    const lines = [t(doctorLocale, 'doctor.patientAccepted', { name: fullName(outcome.patient) })];
    if (outcome.label !== null) {
      lines.push(t(doctorLocale, 'doctor.yourNote', { label: outcome.label }));
    }
    lines.push('', t(doctorLocale, 'doctor.confirmQuestion'));
    return [
      this.#chat.edit(t(locale, 'invite.accepted'), home),
      this.#chat.sendTo(outcome.doctor.telegramUserId, lines.join('\n'), [
        [
          this.#chat.button(doctorLocale, 'doctor.confirm', {
            kind: 'doctorDecision',
            relationshipId: outcome.relationshipId,
            accept: true,
          }),
        ],
        [
          this.#chat.button(doctorLocale, 'doctor.reject', {
            kind: 'doctorDecision',
            relationshipId: outcome.relationshipId,
            accept: false,
          }),
        ],
      ]),
    ];
  }

  /** The text for every outcome that is not "go ahead". */
  #refusal(check: Exclude<InviteCheck, { result: 'OPEN' }>): string {
    switch (check.result) {
      case 'THROTTLED':
        return this.#chat.say('invite.throttled');
      case 'INVALID':
        return this.#chat.say('invite.invalid');
      case 'SELF':
        return this.#chat.say('invite.self');
      case 'CONNECTED':
        return this.#chat.say(
          check.status === 'ACTIVE' ? 'invite.alreadyConnected' : 'invite.alreadyPending',
        );
    }
  }
}
