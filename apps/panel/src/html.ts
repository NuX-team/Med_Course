/**
 * The panel's pages are plain HTML built on the server: no client-side script at all. Every
 * value that reaches a page goes through `html`, which escapes it; the only way to put markup
 * into a page is to build it with `html` too. There is no "raw" escape hatch on purpose: with
 * names typed by people and codes coming from Telegram, one forgotten escape is an injection.
 */

/** A piece of markup that is already safe to put into a page. */
export class Markup {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export type Child = Markup | string | number | null | undefined | false | readonly Child[];

function render(child: Child): string {
  if (child === null || child === undefined || child === false) {
    return '';
  }
  if (child instanceof Markup) {
    return child.value;
  }
  if (typeof child === 'string') {
    return escapeHtml(child);
  }
  if (typeof child === 'number') {
    return String(child);
  }
  return child.map(render).join('');
}

/** A template whose interpolated values are escaped unless they are markup built the same way. */
export function html(strings: TemplateStringsArray, ...values: Child[]): Markup {
  let out = strings[0] ?? '';
  for (const [index, value] of values.entries()) {
    out += render(value) + (strings[index + 1] ?? '');
  }
  return new Markup(out);
}

/** Several pieces, one after another. */
export function join(parts: readonly Child[]): Markup {
  return new Markup(render(parts));
}

/** The whole document. `body` is markup; everything else is escaped here. */
export function page(options: { lang: string; title: string; body: Markup }): string {
  return html`<!doctype html>
    <html lang="${options.lang}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${options.title}</title>
        <link rel="stylesheet" href="/static/panel.css" />
      </head>
      <body>
        ${options.body}
      </body>
    </html> `.value;
}

/** The one stylesheet, served from memory. Plain and readable; nothing loaded from elsewhere. */
export const STYLESHEET = `
:root { color-scheme: light dark; --ink: #1c2430; --paper: #f7f8fa; --line: #d5dae1; --accent: #1f6feb; --warn: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6e9ee; --paper: #14181e; --line: #343b46; --accent: #6ea8ff; --warn: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
header, main { max-width: 64rem; margin: 0 auto; padding: 1rem; }
header { border-bottom: 1px solid var(--line); }
header p { margin: 0.25rem 0; }
nav a { display: inline-block; margin: 0 1rem 0.25rem 0; }
a { color: var(--accent); }
h1 { font-size: 1.4rem; margin: 0.5rem 0; }
h2 { font-size: 1.15rem; margin: 1.5rem 0 0.5rem; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { font-weight: 600; }
.wide { overflow-x: auto; }
form { margin: 0.25rem 0; }
label { display: block; margin: 0.4rem 0 0.15rem; }
input[type="text"], select, textarea { width: 100%; max-width: 32rem; padding: 0.4rem; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 4px; }
button { font: inherit; padding: 0.4rem 0.9rem; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent); color: #fff; cursor: pointer; }
button.quiet { background: transparent; color: var(--accent); }
.notice { padding: 0.6rem 0.8rem; border: 1px solid var(--line); border-left: 4px solid var(--accent); margin: 0.75rem 0; }
.notice.bad { border-left-color: var(--warn); }
.muted { opacity: 0.75; font-size: 0.92rem; }
`;
