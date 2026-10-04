import type { AnswerOutcome, DoseView, SkipReason } from '@medcourse/db';
import { MAX_SKIP_REASON_LENGTH } from '@medcourse/db';
import { t, type Locale, type MessageKey } from '@medcourse/i18n';
import { formatLocalTime } from '@medcourse/schedule';
import {
  doseButtons,
  doseLine,
  encodeCallback,
  type DoseAction,
  type SkipChoice,
} from '@medcourse/telegram';
import { cleanText } from './names';
import { Chat, asPatient, textOf } from './session';
import type { Button, Reply } from './types';

/** What the conversation may hold as a dose id: a database UUID and nothing else. */
const DOSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One dose as a message: what it is, where it stands, and what can be done about it now. */
export function doseCard(
  locale: Locale,
  dose: DoseView,
  now: Date,
  note?: string,
): { text: string; buttons: Button[][] } {
  const clock = (instant: Date): string => formatLocalTime(instant, dose.timezone);
  const button = (key: MessageKey, action: DoseAction): Button[] => [
    { text: t(locale, key), data: encodeCallback({ kind: 'dose', action, doseId: dose.doseId }) },
  ];
  const waiting =
    dose.status === 'SCHEDULED' || dose.status === 'NOTIFIED' || dose.status === 'SNOOZED';
  // Past the deadline but not yet swept: it is a miss already, and is shown as one.
  const missed = dose.status === 'MISSED' || (waiting && now >= dose.deadlineAt);

  let state: string;
  let buttons: Button[][];
  if (missed) {
    state = t(locale, 'dose.state.missed');
    buttons = [button('dose.takeLate', 'take')];
  } else if (dose.status === 'SNOOZED') {
    state = t(locale, 'dose.state.snoozed', { time: clock(dose.snoozedUntil ?? dose.deadlineAt) });
    buttons = [button('dose.take', 'take'), button('dose.skip', 'skipAsk')];
  } else if (waiting) {
    state = t(locale, 'dose.state.waiting', { time: clock(dose.deadlineAt) });
    buttons = doseButtons(locale, dose.doseId, dose.snoozeOptions);
  } else {
    const at = clock(dose.answeredAt ?? now);
    state =
      dose.status === 'TAKEN'
        ? t(locale, 'dose.state.taken', { time: at })
        : dose.status === 'TAKEN_LATE'
          ? t(locale, 'dose.state.takenLate', { time: at })
          : t(locale, 'dose.state.skipped', {
              reason: t(locale, `dose.reason.${dose.skipReason ?? 'OTHER'}`),
            });
    const correctable = dose.correctableUntil !== null && now <= dose.correctableUntil;
    buttons = correctable ? [button('dose.undo', 'undo')] : [];
  }

  const lines = [`${clock(dose.scheduledAt)} — ${doseLine(locale, dose.medication)}`, state];
  if (note !== undefined) {
    lines.unshift(note, '');
  }
  return {
    text: lines.join('\n'),
    buttons: [
      ...buttons,
      [{ text: t(locale, 'menu.today'), data: encodeCallback({ kind: 'menu', target: 'today' }) }],
    ],
  };
}

/**
 * The patient answers a reminder: took it, later, skip (with a reason), or takes an answer back.
 * Every rule lives in the repository; this only turns its verdict into a message. The message
 * that was tapped is rewritten to show where the dose stands now, so stale buttons disappear
 * and a second tap finds nothing left to do.
 */
export class DoseFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  #patient(): { userId: string } | null {
    const { user, profile } = this.#chat.s;
    return user !== null && profile !== null ? { userId: user.id } : null;
  }

  #gone(): Reply[] {
    return [this.#chat.respond(t(this.#chat.locale(), 'dose.notAvailable'), [])];
  }

  #show(dose: DoseView, note?: MessageKey): Reply[] {
    const locale = this.#chat.locale();
    const card = doseCard(
      locale,
      dose,
      this.#chat.ctx.now,
      note === undefined ? undefined : t(locale, note),
    );
    return [this.#chat.respond(card.text, card.buttons)];
  }

  /** What a verdict means to the patient: the dose as it now stands, with a word of why if needed. */
  #render(outcome: AnswerOutcome, done?: MessageKey): Reply[] {
    switch (outcome.result) {
      case 'NOT_AVAILABLE':
        return this.#gone();
      case 'DONE':
        return this.#show(outcome.dose, done);
      case 'ALREADY':
        return this.#show(outcome.dose);
      case 'TOO_EARLY':
        return this.#show(outcome.dose, 'dose.tooEarly');
      case 'TOO_LATE':
        return this.#show(outcome.dose, 'dose.tooLate');
      case 'SNOOZE_NOT_ALLOWED':
        return this.#show(outcome.dose, 'dose.snoozeNotAllowed');
      case 'NOT_CORRECTABLE':
        return this.#show(outcome.dose, 'dose.notCorrectable');
    }
  }

  async onDose(action: DoseAction, doseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const { repos, now } = this.#chat.ctx;
    const actor = asPatient(patient.userId);
    const { key } = this.#chat.s.incoming;
    await this.#chat.clearSideConversation();

    switch (action) {
      case 'take':
        return this.#render(await repos.answers.take(actor, { doseId, now, key }));
      case 'undo':
        return this.#render(await repos.answers.undo(actor, { doseId, now, key }), 'dose.undone');
      case 'show': {
        const dose = await repos.answers.get(actor, doseId, now);
        return dose === null ? this.#gone() : this.#show(dose);
      }
      case 'skipAsk': {
        const dose = await repos.answers.get(actor, doseId, now);
        if (dose === null) {
          return this.#gone();
        }
        const waiting = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(dose.status);
        if (!waiting || now >= dose.deadlineAt) {
          return this.#show(dose);
        }
        const locale = this.#chat.locale();
        const reason = (choice: SkipChoice, label: MessageKey): Button[] => [
          {
            text: t(locale, label),
            data: encodeCallback({ kind: 'doseSkip', doseId, reason: choice }),
          },
        ];
        return [
          this.#chat.edit(`${this.#header(dose)}\n\n${t(locale, 'dose.skipAsk')}`, [
            reason('FORGOT', 'dose.reason.FORGOT'),
            reason('NO_MEDICATION', 'dose.reason.NO_MEDICATION'),
            reason('OTHER', 'dose.reason.OTHER'),
            [this.#backToDose(doseId)],
          ]),
        ];
      }
    }
  }

  #header(dose: DoseView): string {
    return `${formatLocalTime(dose.scheduledAt, dose.timezone)} — ${doseLine(this.#chat.locale(), dose.medication)}`;
  }

  #backToDose(doseId: string): Button {
    return this.#chat.button(this.#chat.locale(), 'common.back', {
      kind: 'dose',
      action: 'show',
      doseId,
    });
  }

  async onSnooze(doseId: string, minutes: number): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const { repos, now } = this.#chat.ctx;
    await this.#chat.clearSideConversation();
    return this.#render(
      await repos.answers.snooze(asPatient(patient.userId), {
        doseId,
        now,
        key: this.#chat.s.incoming.key,
        minutes,
      }),
    );
  }

  /** A reason was chosen. "Other" asks for the patient's own words first; the rest skip at once. */
  async onSkip(doseId: string, choice: SkipChoice): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const { repos, now } = this.#chat.ctx;
    const locale = this.#chat.locale();
    const actor = asPatient(patient.userId);

    if (choice === 'OTHER') {
      const dose = await repos.answers.get(actor, doseId, now);
      if (dose === null) {
        return this.#gone();
      }
      await this.#chat.remember('DOSE', 'REASON', { doseId });
      return [
        this.#chat.edit(`${this.#header(dose)}\n\n${t(locale, 'dose.reasonAsk')}`, [
          [
            {
              text: t(locale, 'dose.reasonSilent'),
              data: encodeCallback({ kind: 'doseSkip', doseId, reason: 'OTHER_SILENT' }),
            },
          ],
          [this.#backToDose(doseId)],
        ]),
      ];
    }
    await this.#chat.clearSideConversation();
    const reason: SkipReason = choice === 'OTHER_SILENT' ? 'OTHER' : choice;
    return this.#render(
      await repos.answers.skip(actor, { doseId, now, key: this.#chat.s.incoming.key, reason }),
    );
  }

  /** The patient's own words for "another reason", if that is what the bot is waiting for. */
  async onText(text: string): Promise<Reply[] | null> {
    const talk = this.#chat.s.talk;
    const patient = this.#patient();
    if (talk?.flow !== 'DOSE' || talk.step !== 'REASON' || patient === null) {
      return null;
    }
    const doseId = textOf(talk.data.doseId);
    if (!DOSE_ID.test(doseId)) {
      await this.#chat.clear();
      return null;
    }
    const locale = this.#chat.locale();
    const words = cleanText(text, MAX_SKIP_REASON_LENGTH);
    if (words === null) {
      return [
        this.#chat.send(t(locale, 'dose.reasonInvalid'), [
          [
            {
              text: t(locale, 'dose.reasonSilent'),
              data: encodeCallback({ kind: 'doseSkip', doseId, reason: 'OTHER_SILENT' }),
            },
          ],
        ]),
      ];
    }
    await this.#chat.clear();
    const { repos, now } = this.#chat.ctx;
    return this.#render(
      await repos.answers.skip(asPatient(patient.userId), {
        doseId,
        now,
        key: this.#chat.s.incoming.key,
        reason: 'OTHER',
        text: words,
      }),
    );
  }
}
