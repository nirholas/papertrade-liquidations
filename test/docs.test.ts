import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseFrontMatter, render, slug } from '../scripts/build-docs.mjs';

describe('docs builder', () => {
  it('parses front matter', () => {
    const { meta, body } = parseFrontMatter('---\ntitle: A\norder: 2\n---\n# A\n');
    expect(meta).toEqual({ title: 'A', order: '2' });
    expect(body).toBe('# A\n');
  });

  it('gives headings stable ids, a toc, copy buttons and escapes code', () => {
    const { html, toc } = render('# T\n\n## Hello World\n\n```bash\necho "<x>"\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(slug('Hello World')).toBe('hello-world');
    expect(toc).toEqual([{ depth: 2, id: 'hello-world', text: 'Hello World' }]);
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('class="copy"');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('<table>');
  });

  it('every docs page has front matter and no em or en dashes', () => {
    for (const f of readdirSync('docs').filter((n) => n.endsWith('.md'))) {
      const text = readFileSync(`docs/${f}`, 'utf8');
      expect(parseFrontMatter(text).meta.title, f).toBeTruthy();
      expect(/[–—]/.test(text), f).toBe(false);
    }
  });
});
