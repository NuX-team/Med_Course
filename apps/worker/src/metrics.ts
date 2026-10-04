import type { MetricsSnapshot } from '@medcourse/db';

/** A label value in the exposition format: backslash, quote and line break escaped. */
function label(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

type Series = readonly (readonly [labels: Readonly<Record<string, string>>, value: number])[];

/**
 * The metrics page in the Prometheus text format (ARCHITECTURE §12). Numbers only: queue depths
 * and ages, delays, counts of failures by machine code, open incidents by kind. There is no
 * name, no id and no text of anybody's in it, so what it shows may be read by whoever watches
 * the service without being allowed to see a patient.
 */
export function renderMetrics(
  snapshot: MetricsSnapshot,
  process: { readonly heartbeatAgeSeconds: number },
): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, series: Series): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of series) {
      const pairs = Object.entries(labels).map(([key, text]) => `${key}="${label(text)}"`);
      lines.push(`${name}${pairs.length === 0 ? '' : `{${pairs.join(',')}}`} ${String(value)}`);
    }
  };
  const byKey = (key: string, values: Readonly<Record<string, number>>): Series =>
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [{ [key]: name }, value]);

  gauge('medcourse_up', 'The worker is running.', [[{}, 1]]);
  gauge(
    'medcourse_worker_heartbeat_age_seconds',
    'Seconds since the worker loop last finished a round.',
    [[{}, Math.round(process.heartbeatAgeSeconds)]],
  );
  for (const [queue, stats] of [
    ['reminders', snapshot.reminders],
    ['alerts', snapshot.alerts],
  ] as const) {
    gauge(
      `medcourse_${queue}_queue`,
      `Rows of the ${queue} queue by state.`,
      byKey('status', stats.byStatus),
    );
    gauge(`medcourse_${queue}_overdue`, `Rows of the ${queue} queue due and not yet sent.`, [
      [{}, stats.overdue],
    ]);
    gauge(
      `medcourse_${queue}_oldest_overdue_seconds`,
      `How long the oldest overdue row of the ${queue} queue has waited.`,
      [[{}, stats.oldestOverdueSeconds ?? 0]],
    );
    gauge(
      `medcourse_${queue}_stuck`,
      `Rows of the ${queue} queue taken by a worker that never reported.`,
      [[{}, stats.stuck]],
    );
    gauge(
      `medcourse_${queue}_failures_24h`,
      `Failures of the ${queue} queue in the last 24 hours, by machine code.`,
      byKey('code', stats.failures),
    );
  }
  gauge('medcourse_reminders_sent_24h', 'Reminders sent in the last 24 hours.', [
    [{}, snapshot.reminders.sentInDay],
  ]);
  gauge(
    'medcourse_reminder_delay_seconds',
    'Seconds from "due" to "sent" over the last 24 hours, by quantile (absent when nothing was sent).',
    [
      ...(snapshot.reminders.delaySecondsP50 === null
        ? []
        : ([[{ quantile: '0.5' }, snapshot.reminders.delaySecondsP50]] as const)),
      ...(snapshot.reminders.delaySecondsP95 === null
        ? []
        : ([[{ quantile: '0.95' }, snapshot.reminders.delaySecondsP95]] as const)),
    ],
  );
  gauge(
    'medcourse_unswept_doses',
    'Doses past their deadline that nobody has recorded as missed.',
    [[{}, snapshot.unsweptDoses]],
  );
  gauge(
    'medcourse_incidents_open',
    'Incidents still open, by kind.',
    byKey('kind', snapshot.incidentsOpen),
  );
  gauge('medcourse_courses', 'Courses by state.', byKey('status', snapshot.courses));
  gauge('medcourse_doctors', 'Doctors by verification state.', byKey('status', snapshot.doctors));
  gauge('medcourse_users', 'Accounts in all.', [[{}, snapshot.users]]);
  return `${lines.join('\n')}\n`;
}
