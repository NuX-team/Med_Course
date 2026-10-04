import type { CoursePlan, Recipient } from '@medcourse/db';
import { t, type Locale, type MessageKey } from '@medcourse/i18n';
import { formatLocalDate } from '@medcourse/schedule';
import type { Callback, CourseAction } from './callbacks';
import { changeLines, changeProposal, courseCard } from './card';
import type { CourseFlow } from './course';
import { standing } from './doctor';
import { Chat, asClinician, fullName } from './session';
import type { Button, Reply } from './types';

/** What a doctor can do to a course that has been sent. Everything else is the wizard's. */
const CONTROL_ACTIONS = [
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
] as const satisfies readonly CourseAction[];

export type CourseControlAction = (typeof CONTROL_ACTIONS)[number];

export function isControlAction(action: CourseAction): action is CourseControlAction {
  return (CONTROL_ACTIONS as readonly CourseAction[]).includes(action);
}

/**
 * The doctor's hand on a course after it has been sent: put it on hold, resume it, take it back
 * or end it, and change its plan (ARCHITECTURE §5.4, §5.5, §6.1). Whatever interrupts or ends
 * treatment takes two taps: the first says what will happen, the second does it. Every rule
 * lives in the repositories; this turns their verdicts into messages, and tells the patient,
 * in the patient's own language, each time something about their course changes.
 */
export class CourseControlFlow {
  readonly #chat: Chat;
  readonly #course: CourseFlow;

  constructor(chat: Chat, course: CourseFlow) {
    this.#chat = chat;
    this.#course = course;
  }

  #doctor(): { userId: string; locale: Locale } | null {
    const { user, profile, clinician } = this.#chat.s;
    if (user === null || profile === null || standing(clinician) !== 'GOOD') {
      return null;
    }
    return { userId: user.id, locale: this.#chat.locale() };
  }

  #button(key: MessageKey, callback: Callback): Button {
    return this.#chat.button(this.#chat.locale(), key, callback);
  }

  #act(key: MessageKey, action: CourseAction, courseId: string): Button[] {
    return [this.#button(key, { kind: 'course', action, courseId })];
  }

  #toCourse(courseId: string): Button[][] {
    return [this.#act('common.back', 'open', courseId)];
  }

  #toDoctorMenu(): Button[][] {
    return [[this.#button('common.back', { kind: 'menu', target: 'doctor' })]];
  }

  #notAvailable(): Reply[] {
    return [this.#chat.respond(t(this.#chat.locale(), 'cw.notAvailable'), this.#toDoctorMenu())];
  }

  /** The course is not in a state this can be done from: say where it stands instead. */
  #wrongState(plan: CoursePlan): Reply[] {
    const locale = this.#chat.locale();
    return [
      this.#chat.respond(
        t(locale, 'cw.wrongState', { status: t(locale, `status.${plan.course.status}`) }),
        this.#toCourse(plan.course.id),
      ),
    ];
  }

  /** A message to the patient, if their account can still be written to. */
  #tell(patient: Recipient | null, text: (locale: Locale) => string): Reply[] {
    return patient === null
      ? []
      : [this.#chat.sendTo(patient.telegramUserId, text(patient.locale))];
  }

  #question(key: MessageKey, plan: CoursePlan, yes: MessageKey, action: CourseAction): Reply[] {
    const locale = this.#chat.locale();
    return [
      this.#chat.respond(t(locale, key, { patient: fullName(plan.patient) }), [
        this.#act(yes, action, plan.course.id),
        ...this.#toCourse(plan.course.id),
      ]),
    ];
  }

  async on(action: CourseControlAction, courseId: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    const { user, profile } = this.#chat.s;
    if (doctor === null) {
      return user === null || profile === null
        ? []
        : [this.#chat.respond(t(this.#chat.locale(), 'doctor.notAllowed'), this.#toDoctorMenu())];
    }
    await this.#chat.clearSideConversation();
    const { repos, now } = this.#chat.ctx;
    const actor = asClinician(doctor.userId);
    const { locale } = doctor;
    const input = { courseId, now, key: this.#chat.s.incoming.key };

    switch (action) {
      case 'pause':
      case 'resume':
      case 'cancel': {
        const plan = await repos.plans.getPlan(actor, courseId);
        if (plan === null) {
          return this.#notAvailable();
        }
        const { status } = plan.course;
        if (action === 'pause') {
          return status === 'ACTIVE'
            ? this.#question('cw.pauseConfirm', plan, 'cw.pauseYes', 'pauseYes')
            : this.#wrongState(plan);
        }
        if (action === 'resume') {
          return status === 'PAUSED'
            ? this.#question('cw.resumeConfirm', plan, 'cw.resumeYes', 'resumeYes')
            : this.#wrongState(plan);
        }
        if (status === 'PENDING_PATIENT') {
          return this.#question('cw.withdrawConfirm', plan, 'cw.withdrawYes', 'cancelYes');
        }
        return status === 'ACTIVE' || status === 'PAUSED'
          ? this.#question('cw.cancelConfirm', plan, 'cw.cancelYes', 'cancelYes')
          : this.#wrongState(plan);
      }

      case 'pauseYes': {
        const result = await repos.lifecycle.pause(actor, input);
        if (result.status !== 'PAUSED') {
          return result.status === 'WRONG_STATE'
            ? this.#wrongState(result.plan)
            : this.#notAvailable();
        }
        const { plan } = result;
        return [
          this.#chat.respond(
            t(locale, 'cw.paused', { patient: fullName(plan.patient) }),
            this.#toCourse(courseId),
          ),
          ...this.#tell(result.patient, (to) =>
            t(to, 'course.paused', { doctor: fullName(plan.clinician) }),
          ),
        ];
      }

      case 'resumeYes': {
        const result = await repos.lifecycle.resume(actor, input);
        if (result.status !== 'RESUMED') {
          return result.status === 'WRONG_STATE'
            ? this.#wrongState(result.plan)
            : this.#notAvailable();
        }
        const { plan } = result;
        const last = result.lastDay === null ? '—' : formatLocalDate(result.lastDay);
        return [
          this.#chat.respond(
            t(locale, 'cw.resumed', { patient: fullName(plan.patient), last }),
            this.#toCourse(courseId),
          ),
          ...this.#tell(result.patient, (to) =>
            t(to, 'course.resumed', { doctor: fullName(plan.clinician), last }),
          ),
        ];
      }

      case 'cancelYes': {
        const result = await repos.lifecycle.cancel(actor, input);
        if (result.status !== 'CANCELLED') {
          return result.status === 'WRONG_STATE'
            ? this.#wrongState(result.plan)
            : this.#notAvailable();
        }
        const { plan } = result;
        const names = { patient: fullName(plan.patient) };
        if (result.withdrawn) {
          return [
            this.#chat.respond(t(locale, 'cw.withdrawn', names), [
              // The way to send a corrected course: a new one, which can copy this one.
              [
                this.#button('cw.newForPatient', {
                  kind: 'courseBegin',
                  relationshipId: plan.course.careRelationshipId,
                }),
              ],
              ...this.#toDoctorMenu(),
            ]),
            ...this.#tell(result.patient, (to) =>
              t(to, 'course.withdrawn', { doctor: fullName(plan.clinician) }),
            ),
          ];
        }
        return [
          this.#chat.respond(t(locale, 'cw.cancelled', names), this.#toCourse(courseId)),
          ...this.#tell(result.patient, (to) =>
            t(to, 'course.cancelled', { doctor: fullName(plan.clinician) }),
          ),
        ];
      }

      case 'change': {
        const opened = await repos.changes.open(actor, courseId);
        if (opened.status === 'NOT_AVAILABLE') {
          return this.#notAvailable();
        }
        // A change already with the patient is shown on the course's own screen, where it can
        // be taken back; one still being written opens in the editor.
        return opened.status === 'WAITING_FOR_PATIENT'
          ? this.#course.overview(courseId)
          : this.#course.editor(courseId);
      }

      case 'changeSend': {
        const change = await repos.changes.get(actor, courseId);
        if (change?.status !== 'DRAFT') {
          return this.#notAvailable();
        }
        const difference = changeLines(locale, change);
        if (difference.length === 0) {
          return [
            this.#chat.respond(t(locale, 'cw.changeUnchanged'), [
              this.#act('common.back', 'change', courseId),
            ]),
          ];
        }
        // The doctor reads the new prescription once more, exactly as the patient will.
        const chunks = courseCard(locale, change.proposed, 'DOCTOR', {
          now,
          title: t(locale, 'cw.changeTitle'),
        });
        const tail = [
          ...difference,
          '',
          t(locale, 'cw.changeSendConfirm', { patient: fullName(change.proposed.patient) }),
        ].join('\n');
        const last = chunks.length - 1;
        const buttons = [
          this.#act('cw.changeSendYes', 'changeSendYes', courseId),
          this.#act('common.back', 'change', courseId),
        ];
        return chunks.map((chunk, index) =>
          index !== last
            ? this.#chat.send(chunk)
            : chunks.length === 1
              ? this.#chat.respond(`${chunk}\n\n${tail}`, buttons)
              : this.#chat.send(`${chunk}\n\n${tail}`, buttons),
        );
      }

      case 'changeSendYes': {
        const result = await repos.changes.send(actor, courseId, now);
        if (result.status === 'NOT_AVAILABLE') {
          return this.#notAvailable();
        }
        if (result.status === 'UNCHANGED') {
          return [
            this.#chat.respond(t(locale, 'cw.changeUnchanged'), [
              this.#act('common.back', 'change', courseId),
            ]),
          ];
        }
        if (result.status === 'INVALID') {
          return [
            this.#chat.respond(
              [
                t(locale, 'cw.cannotSend'),
                ...result.problems.map((problem) => `• ${this.#course.problemText(problem)}`),
              ].join('\n'),
              [this.#act('common.back', 'change', courseId)],
            ),
          ];
        }
        const { change, patient } = result;
        const forPatient = patient === null ? [] : changeProposal(patient.locale, change, now);
        const last = forPatient.length - 1;
        return [
          this.#chat.respond(
            t(locale, 'cw.changeSent', { patient: fullName(change.proposed.patient) }),
            this.#toCourse(courseId),
          ),
          // The button that accepts the plan goes under the plan it accepts.
          ...forPatient.map((text, index) =>
            patient === null
              ? this.#chat.send(text)
              : index === last
                ? this.#chat.sendTo(patient.telegramUserId, text, [
                    [
                      this.#chat.button(patient.locale, 'course.changeAccept', {
                        kind: 'patientCourse',
                        action: 'acceptChange',
                        courseId,
                      }),
                    ],
                  ])
                : this.#chat.sendTo(patient.telegramUserId, text),
          ),
        ];
      }

      case 'changeDrop': {
        const result = await repos.changes.drop(actor, courseId);
        if (result.status === 'NOT_AVAILABLE') {
          return this.#notAvailable();
        }
        const { plan } = result;
        return [
          this.#chat.respond(t(locale, 'cw.changeDropped'), this.#toCourse(courseId)),
          // Only a patient who was asked needs to hear that the question is withdrawn.
          ...(result.wasSent
            ? this.#tell(result.patient, (to) =>
                t(to, 'course.changeDropped', { doctor: fullName(plan.clinician) }),
              )
            : []),
        ];
      }
    }
  }
}
