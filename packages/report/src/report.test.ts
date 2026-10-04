import type { CourseExport, ExportEntry } from '@medcourse/db';
import { dictionaries, t } from '@medcourse/i18n';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { CSV_SEPARATOR, csvCell, toCsv, toCsvText } from './csv';
import { renderReport } from './index';
import { buildReport, type ReportDocument } from './model';
import { knownCharacters, printable, toPdf, wrap } from './pdf';
import { SAMPLE_ENTRIES, SAMPLE_EXPORT } from './report.fixture';

/**
 * A course's report as a file (TZ §14.3). The sample is described in report.fixture.ts: five
 * days of "Амоксициллин" and "Vitamin D₃", a pause, two as-needed marks; ten doses came due.
 */

const ru = (overrides: Partial<Parameters<typeof buildReport>[0]> = {}): ReportDocument =>
  buildReport({ export: SAMPLE_EXPORT, locale: 'ru', audience: 'doctor', ...overrides });

/** The sample with something changed, without spelling the whole thing out again. */
function sampleWith(change: {
  course?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  report?: Record<string, unknown>;
  entries?: readonly ExportEntry[];
}): CourseExport {
  const { report } = SAMPLE_EXPORT;
  return {
    ...SAMPLE_EXPORT,
    entries: change.entries ?? SAMPLE_EXPORT.entries,
    report: {
      ...report,
      ...change.report,
      plan: {
        ...report.plan,
        ...change.plan,
        course: { ...report.plan.course, ...change.course },
      },
    },
  };
}

function sampleEntry(index: number): ExportEntry {
  const entry = SAMPLE_ENTRIES[index];
  if (entry === undefined) {
    throw new Error('no such sample entry');
  }
  return entry;
}

/** A strict little reader of what `toCsvText` writes, to check that nothing is lost on the way. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === CSV_SEPARATOR) {
      row.push(cell);
      cell = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += character;
    }
  }
  return rows;
}

describe('the report as words and tables', () => {
  it('says whose course it is, in what state, and when and for whom it was made', () => {
    expect(ru().title).toBe('Отчёт о соблюдении расписания приёма лекарств');
    expect(ru().facts).toEqual([
      ['Пациент', 'Азиза Каримова'],
      ['Врач', 'Rustam Gʻulomov'],
      ['Состояние курса', 'идёт'],
      ['Длительность, дней', '7'],
      ['Начат', '03.10.2026'],
      // Seven days from 3 October, and one whole day on hold.
      ['Последний день', '10.10.2026'],
      ['Часовой пояс курса', 'Asia/Tashkent'],
      ['Отчёт сформирован', '08.10.2026 08:10'],
      ['Кем запрошен', 'врач'],
    ]);
    expect(ru({ audience: 'patient' }).facts.at(-1)).toEqual(['Кем запрошен', 'пациент']);
    expect(ru().createdAt).toEqual(SAMPLE_EXPORT.requestedAt);
  });

  it('gives the figures and, always, how the percentage is computed', () => {
    const document = ru();
    expect(document.figures).toEqual([
      ['Наступило приёмов', '10'],
      ['Принято вовремя', '6'],
      ['Принято с опозданием', '1'],
      ['Пропущено с указанием причины', '2'],
      ['Без ответа до конца срока', '1'],
      ['Соблюдение расписания, %', '60'],
    ]);
    expect(document.formula).toBe(t('ru', 'report.formula'));
    expect(document.formula).toContain('а не оценка результата лечения');
    expect(document.notes.join(' ')).toContain('Asia/Tashkent');
    expect(document.notes.join(' ')).toContain('а не подтверждённый факт приёма');
  });

  it('breaks the figures down by drug, with the dose of one taken off the plan since', () => {
    expect(ru().medications.rows).toEqual([
      ['Амоксициллин', '500 мг', '8', '5', '1', '1', '1', '62,5'],
      // No longer in the plan: its dose is the one its doses were prescribed with.
      ['Vitamin D₃', '1/2 табл.', '2', '1', '0', '1', '0', '50'],
    ]);
    expect(ru().medications.headers).toHaveLength(8);
  });

  it('lists as-needed intake, skip reasons and pauses, each only when there is any', () => {
    const document = ru();
    expect(document.asNeeded?.rows).toEqual([['Парацетамол', '2']]);
    expect(document.reasons?.rows).toEqual([
      ['Забыл', '0'],
      ['Нет лекарства', '1'],
      ['Другая причина', '1'],
    ]);
    expect(document.pauses?.rows).toEqual([['05.10.2026 23:00', '07.10.2026 06:00']]);

    const bare = buildReport({
      export: sampleWith({
        plan: { pauses: [] },
        report: {
          prn: [],
          adherence: { ...SAMPLE_EXPORT.report.adherence, skipped: 0 },
        },
      }),
      locale: 'ru',
      audience: 'doctor',
    });
    expect([bare.asNeeded, bare.reasons, bare.pauses]).toEqual([null, null, null]);
  });

  it('lists every dose with what became of it, on the clock of the course', () => {
    const { rows, headers } = ru().log;
    expect(headers).toEqual([
      'Дата',
      'Время',
      'Препарат',
      'Доза',
      'Исход',
      'Когда отмечено',
      'Причина',
      'Комментарий пациента',
    ]);
    expect(rows).toHaveLength(SAMPLE_ENTRIES.length);
    expect(rows[0]).toEqual([
      '03.10.2026',
      '08:00',
      'Амоксициллин',
      '500 мг',
      'принят вовремя',
      '08:04',
      '',
      '',
    ]);
    expect(rows[2]?.slice(4)).toEqual(['без ответа', '', '', '']);
    expect(rows[3]?.slice(4)).toEqual(['принят с опозданием', '09:15', '', '']);
    expect(rows[4]?.slice(4)).toEqual(['пропущен пациентом', '09:02', 'Нет лекарства', '']);
    // As needed: no slot, so nothing was "answered"; the time is when it was taken.
    expect(rows[5]).toEqual([
      '04.10.2026',
      '13:30',
      'Парацетамол',
      '1 табл.',
      'по необходимости',
      '',
      '',
      '',
    ]);
    expect(rows[7]?.slice(4)).toEqual([
      'пропущен пациентом',
      '08:01',
      'Другая причина',
      'Тошнило с утра; решила подождать до вечера',
    ]);
    // Answered after midnight: the day is said too.
    expect(rows[8]?.slice(4, 6)).toEqual(['принят вовремя', '06.10.2026 00:10']);
    expect(rows.at(-1)?.slice(4)).toEqual(['ждёт ответа', '', '', '']);
  });

  it('can be recomputed from its own rows: the percentage follows from the list of doses', () => {
    for (const locale of ['ru', 'uz'] as const) {
      const document = buildReport({ export: SAMPLE_EXPORT, locale, audience: 'patient' });
      const count = (status: 'TAKEN' | 'TAKEN_LATE' | 'SKIPPED' | 'MISSED'): number =>
        document.log.rows.filter((row) => row[4] === t(locale, `rp.outcome.${status}`)).length;
      const [taken, late, skipped, missed] = [
        count('TAKEN'),
        count('TAKEN_LATE'),
        count('SKIPPED'),
        count('MISSED'),
      ];
      const occurred = taken + late + skipped + missed;
      expect(document.figures.map(([, value]) => value)).toEqual([
        String(occurred),
        String(taken),
        String(late),
        String(skipped),
        String(missed),
        String(Math.round((taken / occurred) * 1000) / 10).replace('.', ','),
      ]);
      // And per drug, from the same rows.
      for (const row of document.medications.rows) {
        const own = document.log.rows.filter((entry) => entry[2] === row[0]);
        const ownTaken = own.filter((entry) => entry[4] === t(locale, 'rp.outcome.TAKEN')).length;
        expect(row[3], row[0]).toBe(String(ownTaken));
      }
    }
  });

  it('is written in the reader’s language, names and what people typed left as they are', () => {
    const document = buildReport({ export: SAMPLE_EXPORT, locale: 'uz', audience: 'doctor' });
    expect(document.title).toBe(t('uz', 'rp.title'));
    expect(document.facts[0]).toEqual(['Bemor', 'Азиза Каримова']);
    expect(document.facts.at(-1)).toEqual(['Kim soʻragan', 'shifokor']);
    expect(document.medications.rows[0]?.slice(0, 2)).toEqual(['Амоксициллин', '500 mg']);
    expect(document.log.rows[7]?.slice(4)).toEqual([
      'bemor oʻtkazib yuborgan',
      '08:01',
      'Boshqa sabab',
      'Тошнило с утра; решила подождать до вечера',
    ]);
    const russian = JSON.stringify(ru());
    for (const label of ['Bemor', 'Shifokor', 'Barcha qabullar']) {
      expect(JSON.stringify(document)).toContain(label);
      expect(russian).not.toContain(label);
    }
  });

  it('says so when a course has not begun, has no end in sight, or has nothing on record', () => {
    const waiting = buildReport({
      export: sampleWith({
        course: { status: 'PENDING_PATIENT', effectiveStartDate: null },
        plan: { pauses: [] },
        report: {
          adherence: {
            taken: 0,
            takenLate: 0,
            skipped: 0,
            missed: 0,
            occurred: 0,
            ratio: null,
            percent: null,
          },
          byMedication: [],
          prn: [],
        },
        entries: [],
      }),
      locale: 'ru',
      audience: 'doctor',
    });
    expect(waiting.facts).toContainEqual(['Начат', 'не начат']);
    expect(waiting.facts.map(([label]) => label)).not.toContain('Последний день');
    expect(waiting.figures.at(-1)).toEqual(['Соблюдение расписания, %', 'приёмов ещё не было']);
    expect(waiting.log).toMatchObject({ rows: [], empty: 'Приёмов ещё не было.' });

    const held = buildReport({
      export: sampleWith({
        course: { status: 'PAUSED' },
        plan: { pauses: [{ from: new Date('2026-10-05T18:00:00Z'), to: null }] },
      }),
      locale: 'ru',
      audience: 'doctor',
    });
    expect(held.facts).toContainEqual(['Последний день', 'станет известен, когда курс возобновят']);
    expect(held.pauses?.rows).toEqual([['05.10.2026 23:00', 'продолжается']]);
  });
});

describe('the report as CSV', () => {
  it('opens in Excel: UTF-8 with a byte order mark, semicolons, CRLF line ends', () => {
    const bytes = toCsv(ru());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe(toCsvText(ru()));
    expect(text.split('\r\n').length).toBeGreaterThan(40);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(text).toContain('Амоксициллин;500 мг;8;5;1;1;1;62,5\r\n');
    expect(text).toContain('"Соблюдение расписания, %";60\r\n'.replace(/^"|"(?=;)/g, ''));
  });

  it('carries everything the report says, and loses nothing on the way back', () => {
    const document = ru();
    const rows = parseCsv(toCsvText(document));
    const after = (title: string, count: number): string[][] => {
      const at = rows.findIndex((row) => row.length === 1 && row[0] === title);
      expect(at, title).toBeGreaterThan(-1);
      return rows.slice(at + 1, at + 1 + count);
    };
    expect(rows[0]).toEqual([document.title]);
    for (const pair of [...document.facts, ...document.figures]) {
      expect(rows).toContainEqual([...pair]);
    }
    expect(rows).toContainEqual([document.formula]);
    for (const table of [
      document.medications,
      document.asNeeded,
      document.reasons,
      document.pauses,
      document.log,
    ]) {
      if (table !== null) {
        expect(after(table.title, table.rows.length + 1)).toEqual([table.headers, ...table.rows]);
      }
    }
    for (const note of document.notes) {
      expect(rows).toContainEqual([note]);
    }
  });

  it('leaves out the tables there is nothing for, and says when no dose has come due', () => {
    const text = toCsvText(
      buildReport({
        export: sampleWith({
          plan: { pauses: [] },
          report: { prn: [], byMedication: [] },
          entries: [],
        }),
        locale: 'ru',
        audience: 'doctor',
      }),
    );
    expect(text).not.toContain('Паузы');
    expect(text).not.toContain('Приёмы «по необходимости»');
    expect(text).toContain('Все приёмы\r\nПриёмов ещё не было.\r\n');
  });

  it.each([
    ['plain text', 'plain text'],
    ['62,5', '62,5'],
    ['a;b', '"a;b"'],
    ['say "aah"', '"say ""aah"""'],
    ['two\r\nlines', '"two\r\nlines"'],
    [' padded ', '" padded "'],
    ['', ''],
  ])('writes a cell so that a table cannot be broken by it: %j', (value, written) => {
    expect(csvCell(value)).toBe(written);
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+7 900', "'+7 900"],
    ['-2', "'-2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['  =cmd', "'  =cmd"],
    ['\t=cmd', "'\t=cmd"],
    ['\r=cmd', '"\'\r=cmd"'],
    // A leading tab or line break is a way in by itself, whatever follows it.
    ['\tplain', "'\tplain"],
    ['\nplain', '"\'\nplain"'],
    ['=HYPERLINK("http://x";"click")', '"\'=HYPERLINK(""http://x"";""click"")"'],
  ])('disarms a cell a spreadsheet would run as a formula: %j', (value, written) => {
    expect(csvCell(value)).toBe(written);
  });

  it('disarms what a doctor or a patient typed, wherever it lands in the file', () => {
    const hostile: ExportEntry = {
      ...sampleEntry(7),
      displayName: '=cmd|"/c calc"!A1',
      skipText: '@SUM(1;2)',
    };
    const text = toCsvText(
      buildReport({
        export: sampleWith({
          entries: [hostile],
          report: {
            byMedication: [
              { ...SAMPLE_EXPORT.report.byMedication[0], displayName: hostile.displayName },
            ],
            prn: [{ displayName: '+prn', count: 1 }],
          },
          plan: { patient: { firstName: '=Азиза', lastName: 'Каримова' } },
        }),
        locale: 'ru',
        audience: 'doctor',
      }),
    );
    for (const line of text.split('\r\n')) {
      for (const cell of line.split(CSV_SEPARATOR)) {
        expect(cell, line).not.toMatch(/^"?[=+\-@]/);
      }
    }
    expect(text).toContain('"\'=cmd|""/c calc""!A1"');
    expect(text).toContain("'=Азиза Каримова");
    expect(text).toContain('"\'@SUM(1;2)"');
    expect(text).toContain("'+prn;1");
  });
});

describe('the report as PDF', () => {
  const pageLabel = (page: number, pages: number): string => t('ru', 'rp.page', { page, pages });

  it('is a real document: A4 pages, a title, the language and the moment it was made', async () => {
    const bytes = await toPdf(ru(), pageLabel);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 });
    expect(pdf.getTitle()).toBe('Отчёт о соблюдении расписания приёма лекарств');
    expect(pdf.getCreator()).toBe('MedCourse');
    expect(pdf.getCreationDate()).toEqual(SAMPLE_EXPORT.requestedAt);
    // Two embedded subsets, not two whole fonts: a report is tens of kilobytes.
    expect(bytes.length).toBeLessThan(120_000);
  });

  it('has every letter both languages are written in, so no label turns into question marks', () => {
    const known = knownCharacters();
    for (const locale of ['ru', 'uz'] as const) {
      for (const [key, text] of Object.entries(dictionaries[locale])) {
        if (/^(rp|status|unit|dose\.reason|report\.formula)\b/.test(key)) {
          expect(printable(text, known), `${locale}:${key}`).toBe(text.replace(/\s+/g, ' '));
        }
      }
    }
    expect(printable('Gʻulomov oʻgʻli, Ўзбек, Қ ғ ҳ', known)).toBe('Gʻulomov oʻgʻli, Ўзбек, Қ ғ ҳ');
  });

  it('comes out whatever a person typed: unknown characters become question marks', async () => {
    const known = knownCharacters();
    expect(printable('Аспирин 💊 100', known)).toBe('Аспирин ? 100');
    expect(printable('阿司匹林', known)).toBe('????');
    expect(printable('two\nlines\tand\u0000more ', known)).toBe('two lines and?more');
    // A heart the font has is kept; the selectors and joiners that only decorate emoji go.
    expect(printable('heart ❤️ joined 👨‍👩‍👧', known)).toBe('heart ❤ joined ???');

    const odd: ExportEntry = {
      ...sampleEntry(7),
      displayName: '阿司匹林 💊',
      skipText: 'не\nмогу 🤢\u0000 ' + 'оченьдлинноесловобезпробелов'.repeat(8),
    };
    const bytes = await toPdf(
      buildReport({ export: sampleWith({ entries: [odd] }), locale: 'ru', audience: 'doctor' }),
      pageLabel,
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('runs on to as many pages as a long course needs', async () => {
    const entries = Array.from({ length: 1200 }, (_, index) => ({
      ...sampleEntry(0),
      at: new Date(Date.UTC(2026, 9, 3, 3) + index * 6 * 3_600_000),
    }));
    const bytes = await toPdf(
      buildReport({ export: sampleWith({ entries }), locale: 'uz', audience: 'patient' }),
      (page, pages) => t('uz', 'rp.page', { page, pages }),
    );
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    expect(pages).toBeGreaterThan(20);
    expect(pages).toBeLessThan(60);
  }, 30_000);

  it('breaks lines at spaces, cuts only a word that is wider than the column, and never overflows', () => {
    const measure = (piece: string): number => piece.length;
    expect(wrap('one two three four', 9, measure)).toEqual(['one two', 'three', 'four']);
    expect(wrap('abcdefghijkl mn', 5, measure)).toEqual(['abcde', 'fghij', 'kl mn']);
    expect(wrap('', 5, measure)).toEqual(['']);
    expect(wrap('fits', 4, measure)).toEqual(['fits']);
    for (const line of wrap('оченьдлинноеслово и ещё несколько слов подряд', 7, measure)) {
      expect(line.length).toBeLessThanOrEqual(7);
    }
  });
});

describe('renderReport', () => {
  it('names the file by the day and the course, in plain ASCII, and by its format', async () => {
    const pdf = await renderReport({ export: SAMPLE_EXPORT, locale: 'ru', audience: 'doctor' });
    expect(pdf.filename).toBe('medcourse-2026-10-08-55555555.pdf');
    expect(new TextDecoder().decode(pdf.content.slice(0, 5))).toBe('%PDF-');

    const csv = await renderReport({
      export: { ...SAMPLE_EXPORT, format: 'CSV' },
      locale: 'uz',
      audience: 'patient',
    });
    expect(csv.filename).toBe('medcourse-2026-10-08-55555555.csv');
    expect(new TextDecoder().decode(csv.content)).toContain(t('uz', 'rp.title'));
    expect(csv.filename).not.toMatch(/[^\x20-\x7e]/);
  });
});
