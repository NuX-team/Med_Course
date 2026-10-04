import type { ReportDocument, ReportTable } from './model';

/**
 * Excel on a Russian or Uzbek Windows splits columns on a semicolon and reads a comma as the
 * decimal mark, so "66,7" in a cell is a number there. The byte order mark is what makes it read
 * the file as UTF-8 instead of the local code page (TZ §14.3).
 */
export const CSV_SEPARATOR = ';';
const BOM = '﻿';
const NEW_LINE = '\r\n';

/**
 * One cell. Two things can go wrong with text a person typed (a drug's name, the patient's own
 * words): it can break the table (a separator, a quote, a line break), and it can be read by a
 * spreadsheet as a formula and run on the doctor's computer when the file is opened. The first is
 * quoted away; the second is disarmed by a leading apostrophe, which a spreadsheet shows as text.
 */
export function csvCell(value: string): string {
  // A leading space or line break does not stop a spreadsheet from seeing the formula behind it.
  const disarmed = /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(disarmed) || disarmed !== disarmed.trim()
    ? `"${disarmed.replaceAll('"', '""')}"`
    : disarmed;
}

function line(cells: readonly string[]): string {
  return cells.map(csvCell).join(CSV_SEPARATOR);
}

function tableLines(table: ReportTable): string[] {
  return [
    line([table.title]),
    ...(table.rows.length === 0 && table.empty !== undefined
      ? [line([table.empty])]
      : [line(table.headers), ...table.rows.map(line)]),
    '',
  ];
}

/** The report as CSV text: a short preamble (who, what, the figures, the formula), then tables. */
export function toCsvText(document: ReportDocument): string {
  const tables = [
    document.medications,
    document.asNeeded,
    document.reasons,
    document.pauses,
    document.log,
  ].filter((table): table is ReportTable => table !== null);
  return [
    line([document.title]),
    '',
    ...document.facts.map(line),
    '',
    line([document.figuresTitle]),
    ...document.figures.map(line),
    line([document.formula]),
    '',
    ...tables.flatMap(tableLines),
    ...document.notes.map((note) => line([note])),
    '',
  ].join(NEW_LINE);
}

/** The bytes of the file: UTF-8 with a byte order mark, CRLF line ends. */
export function toCsv(document: ReportDocument): Uint8Array {
  return new TextEncoder().encode(BOM + toCsvText(document));
}
