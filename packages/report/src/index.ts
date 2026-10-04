import type { CourseExport } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import { toCsv } from './csv';
import { buildReport, type ReportAudience } from './model';
import { toPdf } from './pdf';

export * from './csv';
export * from './model';
export { knownCharacters, printable, toPdf, wrap } from './pdf';

export interface ReportFile {
  /** ASCII only: a file name travels through programs that mangle anything else. */
  readonly filename: string;
  readonly content: Uint8Array;
}

/**
 * The file a person asked for. The name carries the day it was made (on the course's calendar)
 * and the start of the course's id, enough to tell two files apart and nothing about anyone.
 */
export async function renderReport(input: {
  readonly export: CourseExport;
  readonly locale: Locale;
  readonly audience: ReportAudience;
}): Promise<ReportFile> {
  const document = buildReport(input);
  const { format, requestedAt, report } = input.export;
  const stamp = requestedAt.toISOString().slice(0, 10);
  const name = `medcourse-${stamp}-${report.plan.course.id.slice(0, 8)}`;
  return format === 'CSV'
    ? { filename: `${name}.csv`, content: toCsv(document) }
    : {
        filename: `${name}.pdf`,
        content: await toPdf(document, (page, pages) =>
          t(input.locale, 'rp.page', { page, pages }),
        ),
      };
}
