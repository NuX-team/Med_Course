import { describe, expect, it } from 'vitest';
import { Markup, escapeHtml, html, join, page } from './html';

describe('escapeHtml', () => {
  it('neutralises every character that can open a tag, an entity or leave an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('leaves ordinary text, Cyrillic and Uzbek letters alone', () => {
    expect(escapeHtml('Азиза Каримова, oʻzbek, 500 mg')).toBe('Азиза Каримова, oʻzbek, 500 mg');
  });
});

describe('html', () => {
  it('escapes what is put into it, in text and in attributes alike', () => {
    const name = '"><script>alert(1)</script>';
    expect(
      html`<input value="${name}" />
        <p>${name}</p>`.value.replace(/>\s+</g, '><'),
    ).toBe(
      '<input value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" />' +
        '<p>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('keeps markup that was built the same way, however deep it is nested', () => {
    const cell = html`<td>${'a & b'}</td>`;
    const row = html`<tr>
      ${[cell, cell]}
    </tr>`;
    expect(
      html`<table>
        ${row}
      </table>`.value.replace(/\s+/g, ''),
    ).toBe('<table><tr><td>a&amp;b</td><td>a&amp;b</td></tr></table>');
  });

  it('does not mistake a string that looks like markup for markup', () => {
    const forged = String(new Markup('<b>bold</b>'));
    expect(html`${forged}`.value).toBe('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('writes numbers as they are and nothing for an absent value', () => {
    expect(html`[${0}|${42}|${null}|${undefined}|${false}|${''}]`.value).toBe('[0|42||||]');
  });
});

describe('join', () => {
  it('puts pieces one after another, escaping the plain ones', () => {
    expect(join([html`<h1>${'A'}</h1>`, '<i>', null, [html`<p></p>`, 7]]).value).toBe(
      '<h1>A</h1>&lt;i&gt;<p></p>7',
    );
  });
});

describe('page', () => {
  it('is a whole document in the given language, with an escaped title and no script', () => {
    const document = page({ lang: 'uz', title: 'A <b> & c', body: html`<main>${'x'}</main>` });
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(document).toContain('<html lang="uz">');
    expect(document).toContain('<title>A &lt;b&gt; &amp; c</title>');
    expect(document).toContain('<main>x</main>');
    expect(document).toContain('<link rel="stylesheet" href="/static/panel.css" />');
    expect(document).toContain('name="robots" content="noindex, nofollow"');
    expect(document).not.toContain('<script');
  });
});
