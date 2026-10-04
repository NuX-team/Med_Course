import {
  DELETION_GRACE_MS,
  type LeftDoctor,
  type PrivacyStanding,
  type SharedSummary,
} from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import { formatDose } from '@medcourse/telegram';
import { formatLocalDate, localDateOf } from '@medcourse/schedule';
import type { Callback, PrivacyAction, PrivacyDoctorAction } from './callbacks';
import { joinBlocks } from './card';
import { standing as doctorStanding } from './doctor';
import { Chat, asClinician, asPatient, clip, fullName } from './session';
import type { Button, Reply } from './types';

const BUTTON_NAME = 22;
const DAY_MS = 86_400_000;

/** A percentage as people here write it: "33,3". */
function percentText(percent: number): string {
  return String(percent).replace('.', ',');
}

/** The summary of an earlier course, as the patient's new doctor reads it. */
export function summaryText(locale: Locale, summary: SharedSummary, zone: string): string {
  const { content } = summary;
  const started = content.startedOn === null ? '—' : formatLocalDate(content.startedOn);
  const ended = formatLocalDate(localDateOf(new Date(content.endedAt), zone));
  return [
    t(locale, 'past.course', {
      started,
      ended,
      status: t(locale, `status.${content.status}`),
      doctor: summary.clinicianName,
    }),
    content.percent === null
      ? t(locale, 'past.figureNone')
      : t(locale, 'past.figure', {
          taken: content.taken,
          occurred: content.occurred,
          percent: percentText(content.percent),
        }),
    ...content.medications.map((medication) =>
      medication.doseValue === null || medication.doseUnit === null
        ? t(locale, 'past.medNoDose', {
            name: medication.name,
            taken: medication.taken,
            occurred: medication.occurred,
          })
        : t(locale, 'past.med', {
            name: medication.name,
            dose: `${formatDose(medication.doseValue, medication.doseDisplay)} ${t(locale, `unit.${medication.doseUnit}`)}`,
            taken: medication.taken,
            occurred: medication.occurred,
          }),
    ),
    ...content.asNeeded.map((drug) =>
      t(locale, 'past.prn', { name: drug.name, count: drug.count }),
    ),
  ].join('\n');
}

/**
 * A person's say over their own data (TZ §12, §12.1): the consent they gave, the doctors who
 * treat them, leaving one of them, withdrawing consent, asking for deletion. Every step that
 * cannot be undone by a tap is asked twice, and each says plainly what stops and what is kept.
 */
export class PrivacyFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  #patient() {
    const { user, profile } = this.#chat.s;
    return user === null || profile === null ? null : { actor: asPatient(user.id), user, profile };
  }

  #button(key: Parameters<Chat['button']>[1], callback: Callback, name?: string): Button {
    return this.#chat.button(
      this.#chat.locale(),
      key,
      callback,
      name === undefined ? {} : { name: clip(name, BUTTON_NAME) },
    );
  }

  #backToPrivacy(): Button[] {
    return [this.#button('common.back', { kind: 'settingsPrivacy' })];
  }

  /** What each doctor is told when a patient leaves them. Sent once, after the fact. */
  #tell(doctors: readonly LeftDoctor[]): Reply[] {
    const { profile } = this.#chat.s;
    return doctors.map((doctor) =>
      this.#chat.sendTo(
        doctor.telegramUserId,
        t(doctor.locale, 'privacy.doctorTold', {
          name: profile === null ? '' : fullName(profile),
          count: doctor.coursesStopped,
        }),
      ),
    );
  }

  /**
   * Everything a person with withdrawn consent, or with a deletion waiting, can do: take the
   * request back, or give consent again. Whatever else they send gets the same explanation.
   */
  async gated(
    standing: PrivacyStanding,
    callback: Callback | null,
    consentVersion: string,
  ): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const regrant = [[this.#button('privacy.regrant', { kind: 'privacy', action: 'regrant' })]];

    if (standing.deletionDueAt !== null) {
      if (callback?.kind === 'privacy' && callback.action === 'keep') {
        await repos.privacy.cancelDeletion(patient.actor, { now });
        return [
          this.#chat.respond(
            `${t(locale, 'privacy.kept')}\n\n${t(locale, 'privacy.withdrawn')}`,
            regrant,
          ),
        ];
      }
      return [
        this.#chat.respond(
          t(locale, 'privacy.deletionPending', {
            date: formatLocalDate(localDateOf(standing.deletionDueAt, patient.user.timezone)),
          }),
          [[this.#button('privacy.keep', { kind: 'privacy', action: 'keep' })]],
        ),
      ];
    }
    if (callback?.kind === 'privacy' && callback.action === 'regrant') {
      const granted = await repos.privacy.grantConsentAgain(patient.actor, {
        version: consentVersion,
        locale,
      });
      if (granted) {
        return [this.#chat.respond(t(locale, 'privacy.regranted'), [[this.#chat.back('home')]])];
      }
    }
    return [this.#chat.respond(t(locale, 'privacy.withdrawn'), regrant)];
  }

  /** "Consent and data": what was agreed to and when, and what can be done about it. */
  async screen(): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const overview = await this.#chat.ctx.repos.privacy.overview(patient.actor);
    const lines = [
      t(locale, 'privacy.title'),
      overview.consent === null
        ? t(locale, 'privacy.consentNone')
        : t(locale, 'privacy.consentGiven', {
            date: formatLocalDate(localDateOf(overview.consent.at, patient.user.timezone)),
            version: overview.consent.version,
          }),
    ];
    if (overview.heldRole !== null) {
      return [
        this.#chat.edit(
          [...lines, t(locale, `privacy.hasRole.${overview.heldRole}`)].join('\n\n'),
          [
            [this.#button('privacy.doctors', { kind: 'privacy', action: 'doctors' })],
            [this.#chat.back('settings')],
          ],
        ),
      ];
    }
    return [
      this.#chat.edit(lines.join('\n\n'), [
        [this.#button('privacy.doctors', { kind: 'privacy', action: 'doctors' })],
        [this.#button('privacy.withdraw', { kind: 'privacy', action: 'withdrawAsk' })],
        [this.#button('privacy.delete', { kind: 'privacy', action: 'deleteAsk' })],
        [this.#chat.back('settings')],
      ]),
    ];
  }

  async on(action: PrivacyAction): Promise<Reply[]> {
    switch (action) {
      case 'doctors':
        return this.#doctors();
      case 'withdrawAsk':
        return this.#ask('privacy.withdrawAsk', 'privacy.withdrawYes', 'withdraw');
      case 'withdraw':
        return this.#withdraw();
      case 'deleteAsk':
        return this.#ask('privacy.deleteAsk', 'privacy.deleteYes', 'delete');
      case 'delete':
        return this.#delete();
      case 'keep':
      case 'regrant':
        // Only meaningful once consent is withdrawn; a stale button otherwise.
        return this.screen();
    }
  }

  async #doctors(notice?: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { doctors } = await this.#chat.ctx.repos.privacy.overview(patient.actor);
    const head = notice === undefined ? [] : [notice];
    if (doctors.length === 0) {
      return [
        this.#chat.edit([...head, t(locale, 'privacy.doctorsNone')].join('\n\n'), [
          this.#backToPrivacy(),
        ]),
      ];
    }
    const lines = doctors.map((doctor) =>
      t(
        locale,
        doctor.status === 'PENDING'
          ? 'privacy.doctorLinePending'
          : doctor.sharesHistory
            ? 'privacy.doctorLineShared'
            : 'privacy.doctorLine',
        { name: fullName(doctor) },
      ),
    );
    const buttons: Button[][] = doctors.flatMap((doctor) => {
      const name = `${doctor.lastName} ${doctor.firstName}`;
      const { relationshipId } = doctor;
      return [
        ...(doctor.status === 'ACTIVE'
          ? [
              [
                doctor.sharesHistory
                  ? this.#button(
                      'privacy.unshareButton',
                      { kind: 'privacyDoctor', action: 'unshare', relationshipId },
                      name,
                    )
                  : this.#button(
                      'privacy.shareButton',
                      { kind: 'privacyDoctor', action: 'share', relationshipId },
                      name,
                    ),
              ],
            ]
          : []),
        [
          this.#button(
            'privacy.leaveButton',
            { kind: 'privacyDoctor', action: 'leaveAsk', relationshipId },
            name,
          ),
        ],
      ];
    });
    return [
      this.#chat.edit(
        [...head, [t(locale, 'privacy.doctorsTitle'), ...lines].join('\n')].join('\n\n'),
        [...buttons, this.#backToPrivacy()],
      ),
    ];
  }

  async onDoctor(action: PrivacyDoctorAction, relationshipId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const { doctors } = await repos.privacy.overview(patient.actor);
    const doctor = doctors.find((entry) => entry.relationshipId === relationshipId);
    if (doctor === undefined) {
      // No longer this person's doctor: show the list as it is now.
      return this.#doctors();
    }
    const name = fullName(doctor);
    switch (action) {
      case 'leaveAsk':
        return [
          this.#chat.edit(t(locale, 'privacy.leaveAsk', { name }), [
            [
              this.#button('privacy.leaveYes', {
                kind: 'privacyDoctor',
                action: 'leave',
                relationshipId,
              }),
            ],
            [this.#button('common.back', { kind: 'privacy', action: 'doctors' })],
          ]),
        ];
      case 'leave': {
        const left = await repos.privacy.leaveDoctor(patient.actor, {
          relationshipId,
          now,
          key: this.#chat.s.incoming.key,
        });
        if (left.status !== 'LEFT') {
          return this.#doctors();
        }
        return [
          ...(await this.#doctors(t(locale, 'privacy.left', { name, count: left.coursesStopped }))),
          ...this.#tell(left.doctor === null ? [] : [left.doctor]),
        ];
      }
      case 'share':
      case 'unshare': {
        const share = action === 'share';
        const done = await repos.privacy.shareHistory(patient.actor, {
          relationshipId,
          share,
          now,
        });
        return this.#doctors(
          done ? t(locale, share ? 'privacy.shared' : 'privacy.unshared', { name }) : undefined,
        );
      }
    }
  }

  #ask(
    text: 'privacy.withdrawAsk' | 'privacy.deleteAsk',
    yes: 'privacy.withdrawYes' | 'privacy.deleteYes',
    action: 'withdraw' | 'delete',
  ): Reply[] {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const due = new Date(this.#chat.ctx.now.getTime() + DELETION_GRACE_MS);
    return [
      this.#chat.edit(
        text === 'privacy.deleteAsk'
          ? t(locale, text, {
              days: Math.round(DELETION_GRACE_MS / DAY_MS),
              date: formatLocalDate(localDateOf(due, patient.user.timezone)),
            })
          : t(locale, text),
        [[this.#button(yes, { kind: 'privacy', action })], this.#backToPrivacy()],
      ),
    ];
  }

  async #withdraw(): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.privacy.withdrawConsent(patient.actor, {
      now,
      key: this.#chat.s.incoming.key,
    });
    if (result.status === 'HAS_ROLE') {
      return this.screen();
    }
    await this.#chat.clear();
    return [
      this.#chat.edit(t(locale, 'privacy.withdrawn'), [
        [this.#button('privacy.regrant', { kind: 'privacy', action: 'regrant' })],
      ]),
      ...(result.status === 'WITHDRAWN' ? this.#tell(result.doctors) : []),
    ];
  }

  async #delete(): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.privacy.requestDeletion(patient.actor, {
      now,
      key: this.#chat.s.incoming.key,
    });
    if (result.status === 'HAS_ROLE') {
      return this.screen();
    }
    await this.#chat.clear();
    return [
      this.#chat.edit(
        t(locale, 'privacy.deletionPending', {
          date: formatLocalDate(localDateOf(result.dueAt, patient.user.timezone)),
        }),
        [[this.#button('privacy.keep', { kind: 'privacy', action: 'keep' })]],
      ),
      ...(result.status === 'REQUESTED' ? this.#tell(result.doctors) : []),
    ];
  }

  /** For a doctor: the summaries of a patient's earlier courses, if the patient lets them. */
  async pastCourses(relationshipId: string): Promise<Reply[]> {
    const { user, profile, clinician } = this.#chat.s;
    if (user === null || profile === null || doctorStanding(clinician) !== 'GOOD') {
      return [];
    }
    const locale = this.#chat.locale();
    const back = [[this.#button('common.back', { kind: 'doctor', action: 'patients' })]];
    const summaries = await this.#chat.ctx.repos.privacy.sharedSummaries(
      asClinician(user.id),
      relationshipId,
    );
    if (summaries === null) {
      return [this.#chat.edit(t(locale, 'past.notShared'), back)];
    }
    if (summaries.length === 0) {
      return [this.#chat.edit(t(locale, 'past.none'), back)];
    }
    const chunks = joinBlocks([
      t(locale, 'past.title'),
      ...summaries.map((summary) => summaryText(locale, summary, user.timezone)),
    ]);
    return chunks.map((chunk, index) =>
      index === chunks.length - 1
        ? chunks.length === 1
          ? this.#chat.edit(chunk, back)
          : this.#chat.send(chunk, back)
        : this.#chat.send(chunk),
    );
  }
}
