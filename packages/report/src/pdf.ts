import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { FONT_BOLD_BASE64, FONT_REGULAR_BASE64 } from './font.generated';
import type { ReportDocument, ReportTable } from './model';

// A4 in points, portrait.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const FOOTER_HEIGHT = 24;
const WIDTH = PAGE_WIDTH - 2 * MARGIN;

const INK = rgb(0.11, 0.14, 0.19);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.8, 0.83, 0.87);
const SHADE = rgb(0.94, 0.95, 0.97);

const SIZE = { title: 15, section: 11.5, body: 9.5, table: 7.5, footer: 7.5 } as const;
const LEADING = 1.35;
const CELL_PAD = 3;

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  /** Code points the faces can draw. Anything else (an emoji in a drug's name) becomes "?". */
  readonly known: ReadonlySet<number>;
}

let fontBytes: { regular: Uint8Array; bold: Uint8Array } | undefined;

function fontData(): { regular: Uint8Array; bold: Uint8Array } {
  fontBytes ??= {
    regular: Uint8Array.from(Buffer.from(FONT_REGULAR_BASE64, 'base64')),
    bold: Uint8Array.from(Buffer.from(FONT_BOLD_BASE64, 'base64')),
  };
  return fontBytes;
}

let characters: ReadonlySet<number> | undefined;

/** Every code point the report's font has a glyph for. */
export function knownCharacters(): ReadonlySet<number> {
  characters ??= new Set(fontkit.create(fontData().regular).characterSet);
  return characters;
}

/**
 * Text as the page can show it: one line, no control characters, and nothing the font has no
 * glyph for. A report must come out whatever a person typed into a name or a comment.
 */
export function printable(text: string, known: ReadonlySet<number>): string {
  let out = '';
  for (const character of text.replace(/\s+/g, ' ')) {
    const code = character.codePointAt(0) ?? 0;
    // Variation selectors and joiners only decorate an emoji; they vanish with it.
    if (code === 0xfe0f || code === 0x200d) {
      continue;
    }
    out += code >= 0x20 && known.has(code) ? character : '?';
  }
  return out.trim();
}

/** Breaks text into lines no wider than `width`, splitting a word only when it alone is too wide. */
export function wrap(text: string, width: number, measure: (piece: string) => number): string[] {
  const lines: string[] = [];
  let current = '';
  const push = (word: string): void => {
    const joined = current === '' ? word : `${current} ${word}`;
    if (measure(joined) <= width) {
      current = joined;
      return;
    }
    if (current !== '') {
      lines.push(current);
      current = '';
    }
    if (measure(word) <= width) {
      current = word;
      return;
    }
    // A single word wider than the column: cut it where it stops fitting.
    let piece = '';
    for (const character of word) {
      if (piece !== '' && measure(piece + character) > width) {
        lines.push(piece);
        piece = '';
      }
      piece += character;
    }
    current = piece;
  };
  for (const word of text.split(' ')) {
    if (word !== '') {
      push(word);
    }
  }
  if (current !== '' || lines.length === 0) {
    lines.push(current);
  }
  return lines;
}

/** Lays the report out from the top of a page downwards, opening a new page when one is full. */
class Writer {
  readonly #pdf: PDFDocument;
  readonly #fonts: Fonts;
  #page: PDFPage;
  /** Distance from the top edge of the page to where the next thing goes. */
  #top = MARGIN;

  constructor(pdf: PDFDocument, fonts: Fonts) {
    this.#pdf = pdf;
    this.#fonts = fonts;
    this.#page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  #clean(text: string): string {
    return printable(text, this.#fonts.known);
  }

  #lines(text: string, font: PDFFont, size: number, width: number): string[] {
    return wrap(this.#clean(text), width, (piece) => font.widthOfTextAtSize(piece, size));
  }

  /** Makes sure `height` fits on the current page. True if a new page had to be opened. */
  #need(height: number): boolean {
    if (this.#top + height <= PAGE_HEIGHT - MARGIN - FOOTER_HEIGHT) {
      return false;
    }
    this.#page = this.#pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.#top = MARGIN;
    return true;
  }

  #draw(line: string, x: number, font: PDFFont, size: number, color = INK): void {
    // `#top` is the top of the line; the baseline sits a font-size (less the descent) below it.
    this.#page.drawText(line, {
      x,
      y: PAGE_HEIGHT - this.#top - size * 0.95,
      size,
      font,
      color,
    });
  }

  gap(height: number): void {
    this.#top += height;
  }

  text(text: string, options: { size: number; bold?: boolean; muted?: boolean }): void {
    const font = options.bold === true ? this.#fonts.bold : this.#fonts.regular;
    const height = options.size * LEADING;
    for (const line of this.#lines(text, font, options.size, WIDTH)) {
      this.#need(height);
      this.#draw(line, MARGIN, font, options.size, options.muted === true ? MUTED : INK);
      this.#top += height;
    }
  }

  section(title: string): void {
    // A heading is not left alone at the foot of a page.
    this.#need(SIZE.section * LEADING + 40);
    this.gap(10);
    this.text(title, { size: SIZE.section, bold: true });
    this.gap(3);
  }

  /** Label on the left, value on the right; long values wrap under themselves. */
  pairs(rows: readonly (readonly [string, string])[]): void {
    const labelWidth = 190;
    const height = SIZE.body * LEADING;
    for (const [label, value] of rows) {
      const labels = this.#lines(label, this.#fonts.regular, SIZE.body, labelWidth - 8);
      const values = this.#lines(value, this.#fonts.bold, SIZE.body, WIDTH - labelWidth);
      const count = Math.max(labels.length, values.length);
      this.#need(count * height);
      for (let index = 0; index < count; index += 1) {
        const left = labels[index];
        const right = values[index];
        if (left !== undefined) {
          this.#draw(left, MARGIN, this.#fonts.regular, SIZE.body, MUTED);
        }
        if (right !== undefined) {
          this.#draw(right, MARGIN + labelWidth, this.#fonts.bold, SIZE.body);
        }
        this.#top += height;
      }
      this.gap(1.5);
    }
  }

  table(table: ReportTable): void {
    this.section(table.title);
    if (table.rows.length === 0) {
      this.text(table.empty ?? '', { size: SIZE.body, muted: true });
      return;
    }
    const share = table.widths.reduce((sum, part) => sum + part, 0);
    const widths = table.headers.map((_, index) => ((table.widths[index] ?? 1) / share) * WIDTH);
    const lineHeight = SIZE.table * LEADING;

    const row = (cells: readonly string[], header: boolean): void => {
      const font = header ? this.#fonts.bold : this.#fonts.regular;
      const wrapped = widths.map((width, index) =>
        this.#lines(cells[index] ?? '', font, SIZE.table, width - 2 * CELL_PAD),
      );
      const height = Math.max(...wrapped.map((lines) => lines.length)) * lineHeight + 2 * CELL_PAD;
      if (this.#need(height) && !header) {
        // The table went on to a new page: say again what the columns are.
        row(table.headers, true);
      }
      if (header) {
        this.#page.drawRectangle({
          x: MARGIN,
          y: PAGE_HEIGHT - this.#top - height,
          width: WIDTH,
          height,
          color: SHADE,
        });
      }
      let x = MARGIN;
      for (const [index, lines] of wrapped.entries()) {
        const top = this.#top;
        this.#top += CELL_PAD;
        for (const line of lines) {
          this.#draw(line, x + CELL_PAD, font, SIZE.table);
          this.#top += lineHeight;
        }
        this.#top = top;
        x += widths[index] ?? 0;
      }
      this.#top += height;
      this.#page.drawLine({
        start: { x: MARGIN, y: PAGE_HEIGHT - this.#top },
        end: { x: MARGIN + WIDTH, y: PAGE_HEIGHT - this.#top },
        thickness: 0.5,
        color: RULE,
      });
    };

    row(table.headers, true);
    for (const cells of table.rows) {
      row(cells, false);
    }
  }

  /** The same line at the foot of every page: what the document is, and which page of how many. */
  footers(title: string, pageLabel: (page: number, pages: number) => string): void {
    const pages = this.#pdf.getPages();
    for (const [index, page] of pages.entries()) {
      const label = this.#clean(pageLabel(index + 1, pages.length));
      const y = MARGIN - 4;
      page.drawText(this.#clean(title), {
        x: MARGIN,
        y,
        size: SIZE.footer,
        font: this.#fonts.regular,
        color: MUTED,
      });
      page.drawText(label, {
        x: MARGIN + WIDTH - this.#fonts.regular.widthOfTextAtSize(label, SIZE.footer),
        y,
        size: SIZE.footer,
        font: this.#fonts.regular,
        color: MUTED,
      });
    }
  }
}

/**
 * The report as a PDF: A4, set in DejaVu Sans (Cyrillic and Uzbek Latin), fonts embedded as
 * subsets. `pageLabel` is passed in so that this module needs no dictionary of its own.
 */
export async function toPdf(
  document: ReportDocument,
  pageLabel: (page: number, pages: number) => string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const data = fontData();
  const regular = await pdf.embedFont(data.regular, { subset: true });
  const bold = await pdf.embedFont(data.bold, { subset: true });
  const fonts: Fonts = { regular, bold, known: knownCharacters() };

  pdf.setTitle(printable(document.title, fonts.known));
  pdf.setLanguage(document.locale);
  pdf.setCreator('MedCourse');
  pdf.setProducer('MedCourse');
  pdf.setCreationDate(document.createdAt);
  pdf.setModificationDate(document.createdAt);

  const writer = new Writer(pdf, fonts);
  writer.text(document.title, { size: SIZE.title, bold: true });
  writer.gap(8);
  writer.pairs(document.facts);

  writer.section(document.figuresTitle);
  writer.pairs(document.figures);
  writer.gap(4);
  writer.text(document.formula, { size: SIZE.body, muted: true });

  writer.table(document.medications);
  for (const table of [document.asNeeded, document.reasons, document.pauses]) {
    if (table !== null) {
      writer.table(table);
    }
  }
  writer.table(document.log);

  writer.gap(10);
  for (const note of document.notes) {
    writer.text(note, { size: SIZE.footer, muted: true });
  }
  writer.footers(document.title, pageLabel);
  return pdf.save();
}
