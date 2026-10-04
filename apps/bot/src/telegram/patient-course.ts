import type { CoursePlan, StartOutlook, StartRefusal } from '@medcourse/db';
import { t } from '@medcourse/i18n';
import {
  EARLY_MARK_WINDOW_MINUTES,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  localDateOf,
} from '@medcourse/schedule';
import { encodeCallback, type PatientCourseAction } from '@medcourse/telegram';
import { changeProposal, courseCard, doseText, joinBlocks, startDeadline } from './card';
import { PrnFlow, prnLine } from './as-needed';
import { Chat, asPatient, clip, fullName } from './session';
import type { Button, Reply } from './types';

/** How many doses "today" offers as buttons at once. */
const TODAY_BUTTONS = 12;

/**
 * The patient's side of a course: seeing what was prescribed, starting it, and seeing what
 * today asks of them. Starting takes two taps on purpose (D-7): the first shows what the start
 * would mean right now (how much of today is left, when the course ends), the second does it.
 */
export class PatientCourseFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  #patient(): { userId: string } | null {
    const { user, profile } = this.#chat.s;
    return user !== null && profile !== null ? { userId: user.id } : null;
  }

  #toMyCourse(): Button[][] {
    return [[this.#chat.back('course')]];
  }

  /** Everything a button can ask about one of the patient's courses. */
  on(action: PatientCourseAction, courseId: string): Promise<Reply[]> {
    switch (action) {
      case 'ask':
        return this.ask(courseId);
      case 'confirm':
        return this.confirm(courseId);
      case 'viewChange':
        return this.viewChange(courseId);
      case 'acceptChange':
        return this.acceptChange(courseId);
      case 'pauseAsk':
        return this.pauseAsk(courseId);
      case 'pauseRequest':
        return this.pauseRequest(courseId);
    }
  }

  #startButton(courseId: string, ordinal: number | null): Button {
    const locale = this.#chat.locale();
    return ordinal === null
      ? this.#chat.button(locale, 'course.start', {
          kind: 'patientCourse',
          action: 'ask',
          courseId,
        })
      : this.#chat.button(
          locale,
          'course.startN',
          { kind: 'patientCourse', action: 'ask', courseId },
          { n: ordinal },
        );
  }

  /**
   * "My course": the courses a doctor has sent (not yet started, running or paused), each as
   * the prescription the doctor confirmed. With none, the patient is shown who their doctors are.
   */
  async myCourse(): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const home: Button[][] = [[this.#chat.back('home')]];
    const plans = await repos.plans.listForPatient(asPatient(patient.userId));

    if (plans.length === 0) {
      const doctors = await repos.care.listForPatient(asPatient(patient.userId));
      if (doctors.length === 0) {
        return [this.#chat.edit(t(locale, 'course.none'), home)];
      }
      const lines = doctors.map((doctor) =>
        t(locale, doctor.status === 'ACTIVE' ? 'course.doctorActive' : 'course.doctorPending', {
          name: fullName(doctor),
        }),
      );
      return [
        this.#chat.edit(
          `${t(locale, 'course.doctorsTitle')}\n${lines.join('\n')}\n\n${t(locale, 'course.none')}`,
          home,
        ),
      ];
    }

    const numbered = plans.length > 1;
    const blocks = plans.flatMap((plan, index) => [
      ...courseCard(locale, plan, 'PATIENT', { now, ...(numbered ? { ordinal: index + 1 } : {}) }),
      // A change the doctor has proposed is not in force yet: the card above is still the plan.
      ...(plan.change === null ? [] : [t(locale, 'course.changePending')]),
    ]);
    blocks.push(t(locale, 'course.followDoctor'));
    const courseButtons = plans.flatMap((plan, index) => {
      const courseId = plan.course.id;
      if (plan.course.status === 'PENDING_PATIENT') {
        return [[this.#startButton(courseId, numbered ? index + 1 : null)]];
      }
      const rows: Button[][] = [];
      if (plan.change !== null) {
        const view = { kind: 'patientCourse', action: 'viewChange', courseId } as const;
        rows.push([
          numbered
            ? this.#chat.button(locale, 'course.changeViewN', view, { n: index + 1 })
            : this.#chat.button(locale, 'course.changeView', view),
        ]);
      }
      if (plan.course.status === 'ACTIVE') {
        // The patient cannot put the course on hold; they can ask the doctor to.
        const ask = { kind: 'patientCourse', action: 'pauseAsk', courseId } as const;
        rows.push([
          numbered
            ? this.#chat.button(locale, 'course.pauseAskN', ask, { n: index + 1 })
            : this.#chat.button(locale, 'course.pauseAsk', ask),
        ]);
      }
      return rows;
    });
    const buttons = [...courseButtons, ...home];
    const chunks = joinBlocks(blocks);
    if (chunks.length === 1) {
      return [this.#chat.edit(chunks[0] ?? '', buttons)];
    }
    return chunks.map((chunk, index) =>
      index === chunks.length - 1 ? this.#chat.send(chunk, buttons) : this.#chat.send(chunk),
    );
  }

  /** First tap: what starting now would mean, and the question. Nothing is changed. */
  async ask(courseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const preview = await repos.runs.previewStart(asPatient(patient.userId), courseId, now);
    if (preview.status !== 'READY') {
      return [this.#chat.edit(this.#refusal(preview), this.#toMyCourse())];
    }
    return [
      this.#chat.edit(
        [
          t(locale, 'start.question'),
          '',
          ...this.#outlookLines(preview.plan, preview.outlook),
          '',
          t(locale, 'start.irreversible'),
        ].join('\n'),
        [
          [
            this.#chat.button(locale, 'start.confirm', {
              kind: 'patientCourse',
              action: 'confirm',
              courseId,
            }),
          ],
          [this.#chat.button(locale, 'start.later', { kind: 'menu', target: 'course' })],
        ],
      ),
    ];
  }

  /** Second tap: the course starts. A repeated tap finds it already started and changes nothing. */
  async confirm(courseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.runs.start(asPatient(patient.userId), courseId, now);
    if (result.status !== 'STARTED') {
      return [this.#chat.edit(this.#refusal(result), this.#toMyCourse())];
    }

    const { plan, outlook, doctor } = result;
    const dates = {
      date: formatLocalDate(outlook.effectiveStartDate),
      last: formatLocalDate(outlook.lastDay),
    };
    return [
      this.#chat.edit(t(locale, 'start.done', dates), this.#toMyCourse()),
      // The doctor learns that the course is running, in the doctor's own language.
      this.#chat.sendTo(
        doctor.telegramUserId,
        t(doctor.locale, 'doctor.courseStarted', { patient: fullName(plan.patient), ...dates }),
      ),
    ];
  }

  /** How today and the whole course would look if it started now. */
  #outlookLines(plan: CoursePlan, outlook: StartOutlook): string[] {
    const locale = this.#chat.locale();
    const zone = plan.course.timezone;
    const lines = [
      t(locale, 'start.dayOne', {
        date: formatLocalDate(outlook.effectiveStartDate),
        days: plan.course.durationDays,
        last: formatLocalDate(outlook.lastDay),
      }),
    ];
    if (outlook.firstSlotAt === null) {
      lines.push(t(locale, 'start.prnOnly'));
    } else if (outlook.slotsToday === 0) {
      lines.push(
        t(locale, 'start.todayNone', { first: formatLocalDateTime(outlook.firstSlotAt, zone) }),
      );
    } else if (outlook.slotsToday < outlook.plannedToday) {
      lines.push(
        t(locale, 'start.todayPartial', {
          left: outlook.slotsToday,
          planned: outlook.plannedToday,
          time: formatLocalTime(outlook.firstSlotAt, zone),
        }),
      );
    } else {
      lines.push(
        t(locale, 'start.todayFull', {
          count: outlook.slotsToday,
          time: formatLocalTime(outlook.firstSlotAt, zone),
        }),
      );
    }
    return lines;
  }

  /** Why the course cannot be started, in words that say what to do next. */
  #refusal(refusal: StartRefusal): string {
    const locale = this.#chat.locale();
    switch (refusal.status) {
      case 'NOT_AVAILABLE':
        return t(locale, 'start.notAvailable');
      case 'ALREADY_STARTED':
        return t(locale, 'start.already');
      case 'WITHDRAWN':
        return t(locale, 'start.withdrawn');
      case 'DOCTOR_UNAVAILABLE':
        return t(locale, 'start.doctorUnavailable');
      case 'NOTHING_LEFT':
        return t(locale, 'start.nothingLeft', { until: startDeadline(refusal.plan) ?? '' });
      case 'OUTSIDE_WINDOW':
        return refusal.when === 'BEFORE'
          ? t(locale, 'start.tooEarly')
          : t(locale, 'start.tooLate', {
              until: startDeadline(refusal.plan) ?? '',
              doctor: fullName(refusal.plan.clinician),
            });
    }
  }

  /** The change of plan the doctor proposed, as text, with the button that accepts it. */
  async viewChange(courseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const change = await repos.changes.get(asPatient(patient.userId), courseId);
    if (change === null) {
      return [this.#chat.edit(t(locale, 'course.changeNothing'), this.#toMyCourse())];
    }
    const chunks = changeProposal(locale, change, now);
    const buttons: Button[][] = [
      [
        this.#chat.button(locale, 'course.changeAccept', {
          kind: 'patientCourse',
          action: 'acceptChange',
          courseId,
        }),
      ],
      ...this.#toMyCourse(),
    ];
    if (chunks.length === 1) {
      return [this.#chat.edit(chunks[0] ?? '', buttons)];
    }
    return chunks.map((chunk, index) =>
      index === chunks.length - 1 ? this.#chat.send(chunk, buttons) : this.#chat.send(chunk),
    );
  }

  /**
   * The patient accepts the proposed plan and it takes effect at once. A repeated tap, or a tap
   * on a proposal the doctor has taken back, finds nothing waiting and changes nothing.
   */
  async acceptChange(courseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.changes.accept(asPatient(patient.userId), {
      courseId,
      now,
      key: this.#chat.s.incoming.key,
    });
    const say = (text: string): Reply => this.#chat.edit(text, this.#toMyCourse());
    switch (result.status) {
      case 'NOT_AVAILABLE':
        return [say(t(locale, 'start.notAvailable'))];
      case 'NOTHING_PENDING':
        return [say(t(locale, 'course.changeNothing'))];
      case 'DOCTOR_UNAVAILABLE':
        return [say(t(locale, 'course.changeDoctorUnavailable'))];
      case 'APPLIED': {
        const { plan, doctor, firstSlotAt } = result;
        const text =
          plan.course.status === 'PAUSED'
            ? t(locale, 'course.changeAppliedPaused')
            : [
                t(locale, 'course.changeApplied'),
                ...(firstSlotAt === null
                  ? []
                  : [
                      t(locale, 'course.changeNextDose', {
                        time: formatLocalDateTime(firstSlotAt, plan.course.timezone),
                      }),
                    ]),
              ].join(' ');
        return [
          say(text),
          // The doctor learns that the new plan is in force, in the doctor's own language.
          ...(doctor === null
            ? []
            : [
                this.#chat.sendTo(
                  doctor.telegramUserId,
                  t(doctor.locale, 'doctor.changeAccepted', { patient: fullName(plan.patient) }),
                ),
              ]),
        ];
      }
    }
  }

  /**
   * First tap of "ask for a pause": what asking means and what it does not. The course is not
   * touched, and the patient is told in so many words not to stop on their own (TZ §5.4).
   */
  async pauseAsk(courseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const plan = await this.#chat.ctx.repos.plans.getPlan(asPatient(patient.userId), courseId);
    if (plan?.course.status !== 'ACTIVE') {
      return [this.#chat.edit(t(locale, 'start.notAvailable'), this.#toMyCourse())];
    }
    return [
      this.#chat.edit(t(locale, 'course.pauseQuestion', { doctor: fullName(plan.clinician) }), [
        [
          this.#chat.button(locale, 'course.pauseSend', {
            kind: 'patientCourse',
            action: 'pauseRequest',
            courseId,
          }),
        ],
        ...this.#toMyCourse(),
      ]),
    ];
  }

  /** Second tap: the request goes to the doctor (once a day at most). The course runs on. */
  async pauseRequest(courseId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.alerts.requestPause(asPatient(patient.userId), { courseId, now });
    const key =
      result.status === 'REQUESTED'
        ? 'course.pauseRequested'
        : result.status === 'ALREADY'
          ? 'course.pauseAlready'
          : 'start.notAvailable';
    return [this.#chat.edit(t(locale, key), this.#toMyCourse())];
  }

  /** "Today": the doses of the patient's running courses, by the time they fall due. */
  async today(): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const home: Button[][] = [[this.#chat.back('home')]];
    const courses = await repos.runs.today(asPatient(patient.userId), now);
    if (courses.length === 0) {
      return [this.#chat.edit(t(locale, 'today.none'), home)];
    }
    const asNeeded = await repos.prn.available(asPatient(patient.userId), now);

    const zone = courses[0]?.timezone ?? this.#chat.s.user?.timezone ?? 'UTC';
    const blocks = [t(locale, 'today.title', { date: formatLocalDate(localDateOf(now, zone)) })];
    const lines = courses.flatMap((course) =>
      course.doses.map(
        (dose) =>
          `${formatLocalTime(dose.scheduledAt, course.timezone)} — ${dose.displayName}, ${doseText(locale, dose)}, ${t(locale, `food.${dose.foodRule}`)} · ${t(locale, `dose.${dose.status}`)}`,
      ),
    );
    if (lines.length === 0) {
      blocks.push(t(locale, 'today.nothing'));
    } else {
      // Lines are grouped so a long day still splits between doses, not inside one.
      for (let index = 0; index < lines.length; index += 20) {
        blocks.push(lines.slice(index, index + 20).join('\n'));
      }
    }
    // As-needed drugs have no time of day: they are listed with what the doctor allowed and
    // what has been marked in the last 24 hours, each with a button to mark an intake.
    if (asNeeded.length > 0) {
      blocks.push(
        [t(locale, 'prn.title'), ...asNeeded.map((item) => prnLine(locale, item))].join('\n'),
      );
    }
    // A dose that can be answered now (from an hour before its time), or was missed and can still
    // be marked as taken late, gets a button that opens it. This is the way to answer when the
    // reminder itself never arrived.
    const openable = courses
      .flatMap((course) => course.doses.map((dose) => ({ dose, timezone: course.timezone })))
      .filter(
        ({ dose }) =>
          dose.status === 'MISSED' ||
          (['SCHEDULED', 'NOTIFIED', 'SNOOZED'].includes(dose.status) &&
            now.getTime() >= dose.scheduledAt.getTime() - EARLY_MARK_WINDOW_MINUTES * 60_000),
      )
      .slice(0, TODAY_BUTTONS);
    const buttons: Button[][] = [
      ...openable.map(({ dose, timezone }) => [
        {
          text: `${formatLocalTime(dose.scheduledAt, timezone)} · ${clip(dose.displayName, 24)}`,
          data: encodeCallback({ kind: 'dose', action: 'show', doseId: dose.doseId }),
        },
      ]),
      ...new PrnFlow(this.#chat).buttons(asNeeded),
      ...home,
    ];
    const chunks = joinBlocks(blocks);
    if (chunks.length === 1) {
      return [this.#chat.edit(chunks[0] ?? '', buttons)];
    }
    return chunks.map((chunk, index) =>
      index === chunks.length - 1 ? this.#chat.send(chunk, buttons) : this.#chat.send(chunk),
    );
  }
}
