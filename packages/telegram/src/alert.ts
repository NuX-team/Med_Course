import { RUN_REPORT_LIMIT, type DueAlert } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import { formatLocalDateTime } from '@medcourse/schedule';
import { encodeCallback } from './callbacks';
import { intervalText } from './dose-text';
import { doseLine } from './reminder';
import type { Button } from './types';

/**
 * What a doctor reads about one of their courses: a dose not taken, a run of them, a reminder
 * that did not get through, a patient asking for a pause, an as-needed intake beyond the
 * prescription. In the doctor's language, with times on the patient's clock (the clock the
 * course is written in). Plain text. It names the patient and the drug, never a diagnosis and
 * never the patient's own words for a skip: those are read in the course's history.
 */
export function alertMessage(
  locale: Locale,
  alert: DueAlert,
): { text: string; buttons: Button[][] } {
  const patient = `${alert.patient.firstName} ${alert.patient.lastName}`;
  const clock = (instant: Date | null): string =>
    instant === null ? '—' : formatLocalDateTime(instant, alert.timezone);
  const doses = alert.doses.map((dose) => `• ${doseLine(locale, dose)}`);
  const run = alert.run >= RUN_REPORT_LIMIT ? `${String(RUN_REPORT_LIMIT)}+` : String(alert.run);

  let lines: string[];
  switch (alert.kind) {
    case 'MISSED':
      lines = [t(locale, 'alert.missed', { patient, time: clock(alert.slotAt) }), ...doses];
      break;
    case 'SKIPPED': {
      const [dose] = alert.doses;
      lines = [
        t(locale, 'alert.skipped', {
          patient,
          time: clock(dose?.scheduledAt ?? null),
          reason: t(locale, `dose.reason.${dose?.skipReason ?? 'OTHER'}`),
        }),
        ...doses,
      ];
      break;
    }
    case 'SERIES':
      lines = [t(locale, 'alert.series', { patient, run, since: clock(alert.runSince) })];
      break;
    case 'DIGEST':
      lines = [t(locale, 'alert.digest', { patient, run, since: clock(alert.runSince) })];
      break;
    case 'UNDELIVERED':
      lines = [t(locale, 'alert.undelivered', { patient })];
      break;
    case 'PAUSE_REQUEST':
      lines = [t(locale, 'alert.pauseRequest', { patient })];
      break;
    case 'PRN_OVER':
      lines = [
        t(locale, 'alert.prnOver', {
          patient,
          name: alert.prn?.displayName ?? '',
          max: alert.prn?.maxDailyDoses ?? 0,
          interval: intervalText(locale, alert.prn?.minimumIntervalMinutes ?? 0),
          count: alert.prn?.takenInDay ?? 0,
        }),
      ];
      break;
  }

  const { courseId } = alert;
  return {
    text: lines.join('\n'),
    buttons: [
      [
        {
          text: t(locale, 'alert.openCourse'),
          data: encodeCallback({ kind: 'course', action: 'open', courseId }),
        },
      ],
      [
        {
          text: t(locale, 'cw.report'),
          data: encodeCallback({ kind: 'history', audience: 'doctor', courseId }),
        },
      ],
    ],
  };
}
