import type { MetricsSnapshot } from '@medcourse/db';
import { describe, expect, it } from 'vitest';
import { renderMetrics } from './metrics';

const QUIET: MetricsSnapshot = {
  reminders: {
    byStatus: { QUEUED: 42, SENT: 7 },
    overdue: 0,
    oldestOverdueSeconds: null,
    stuck: 0,
    failures: {},
    delaySecondsP50: null,
    delaySecondsP95: null,
    sentInDay: 0,
  },
  alerts: { byStatus: {}, overdue: 0, oldestOverdueSeconds: null, stuck: 0, failures: {} },
  unsweptDoses: 0,
  courses: { ACTIVE: 3 },
  doctors: { VERIFIED: 2 },
  users: 9,
  incidentsOpen: {},
};

const LATE: MetricsSnapshot = {
  ...QUIET,
  reminders: {
    byStatus: { QUEUED: 120, SENDING: 3, FAILED: 2 },
    overdue: 90,
    oldestOverdueSeconds: 754,
    stuck: 3,
    failures: { HTTP_403: 2, 'odd "code"\n': 1 },
    delaySecondsP50: 4,
    delaySecondsP95: 41,
    sentInDay: 812,
  },
  unsweptDoses: 5,
  incidentsOpen: { OPERATIONAL: 2, TECHNICAL: 1 },
};

describe('renderMetrics', () => {
  it('says the service is up and how long since the loop last finished a round', () => {
    const text = renderMetrics(QUIET, { heartbeatAgeSeconds: 1.6 });
    expect(text).toContain('medcourse_up 1\n');
    expect(text).toContain('medcourse_worker_heartbeat_age_seconds 2\n');
  });

  it('gives every gauge a help line and a type, and ends with a line break', () => {
    const text = renderMetrics(LATE, { heartbeatAgeSeconds: 0 });
    const names = new Set(
      text
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => /^[a-z_0-9]+/.exec(line)?.[0] ?? ''),
    );
    expect(names.size).toBeGreaterThan(15);
    for (const name of names) {
      expect(text, name).toContain(`# HELP ${name} `);
      expect(text, name).toContain(`# TYPE ${name} gauge\n`);
    }
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('reports the queues, their lateness and the delay of a reminder from due to sent', () => {
    const text = renderMetrics(LATE, { heartbeatAgeSeconds: 0 });
    expect(text).toContain('medcourse_reminders_queue{status="QUEUED"} 120\n');
    expect(text).toContain('medcourse_reminders_queue{status="SENDING"} 3\n');
    expect(text).toContain('medcourse_reminders_overdue 90\n');
    expect(text).toContain('medcourse_reminders_oldest_overdue_seconds 754\n');
    expect(text).toContain('medcourse_reminders_stuck 3\n');
    expect(text).toContain('medcourse_reminders_sent_24h 812\n');
    expect(text).toContain('medcourse_reminder_delay_seconds{quantile="0.5"} 4\n');
    expect(text).toContain('medcourse_reminder_delay_seconds{quantile="0.95"} 41\n');
    expect(text).toContain('medcourse_unswept_doses 5\n');
    expect(text).toContain('medcourse_incidents_open{kind="OPERATIONAL"} 2\n');
    expect(text).toContain('medcourse_incidents_open{kind="TECHNICAL"} 1\n');
    expect(text).toContain('medcourse_courses{status="ACTIVE"} 3\n');
  });

  it('has no delay to report while nothing has been sent, and says zero for a queue that is not late', () => {
    const text = renderMetrics(QUIET, { heartbeatAgeSeconds: 0 });
    expect(text).not.toMatch(/^medcourse_reminder_delay_seconds\{/m);
    expect(text).toContain('medcourse_reminders_oldest_overdue_seconds 0\n');
    expect(text).not.toMatch(/^medcourse_incidents_open\{/m);
  });

  it('writes failures by code and cannot be made to break its own format by an odd code', () => {
    const text = renderMetrics(LATE, { heartbeatAgeSeconds: 0 });
    expect(text).toContain('medcourse_reminders_failures_24h{code="HTTP_403"} 2\n');
    // The quotes and the line break of the code arrive escaped, as backslash-quote and backslash-n.
    expect(text).toContain(
      String.raw`medcourse_reminders_failures_24h{code="odd \"code\"\n"} 1` + '\n',
    );
    for (const line of text.split('\n')) {
      expect(line).toMatch(/^(#.*|[a-z_0-9]+(\{.*\})? -?\d+(\.\d+)?|)$/);
    }
  });

  it('holds numbers and machine words only: no name, no text, nothing of anybody', () => {
    const text = renderMetrics(LATE, { heartbeatAgeSeconds: 0 });
    for (const secret of ['Aziza', 'Karimova', 'Testamol', '@', 'http']) {
      expect(text).not.toContain(secret);
    }
  });
});
