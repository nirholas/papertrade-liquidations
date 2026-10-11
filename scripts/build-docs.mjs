// Renders docs/*.md into site/public/docs/ (HTML, .md twins, search index) and writes llms.txt and llms-full.txt.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://papertrade-liquidations.pages.dev';
const srcDir = join(root, 'docs');
const outDir = join(root, 'site/public/docs');
const pub = join(root, 'site/public');

export function parseFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function render(body) {
  const toc = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slug(text);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: text.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${text}</h${depth}>\n`;
      },
      code({ text, lang }) {
        return `<div class="code"><button class="copy" type="button" aria-label="Copy code">Copy</button><pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(text)}</code></pre></div>\n`;
      },
      table({ header, rows }) {
        const cell = (c, tag) => `<${tag}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        return `<div class="table-wrap"><table><thead><tr>${header.map((c) => cell(c, 'th')).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table></div>\n`;
      },
    },
  });
  return { html: marked.parse(body), toc };
}

const plain = (md) => md.replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*\n?/g, '')).replace(/[#>*`|]/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

function shell(page, pages, i, html, toc) {
  const prev = pages[i - 1];
  const next = pages[i + 1];
  const url = `${SITE}${page.path}`;
  const nav = pages.map((p) => `<a href="${p.path}"${p === page ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('');
  const tocHtml = toc.length ? `<nav class="toc" aria-label="On this page"><p>On this page</p>${toc.map((t) => `<a class="d${t.depth}" href="#${t.id}">${esc(t.text)}</a>`).join('')}</nav>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} - Papertrade Liquidations docs</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${url}">
<link rel="alternate" type="text/markdown" href="${page.mdPath}">
<meta property="og:title" content="${esc(page.title)} - Papertrade Liquidations docs">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/docs/docs.css">
<script src="/docs/theme.js"></script>
</head>
<body class="docs">
<a class="skip" href="#content">Skip to content</a>
<header class="dtop">
  <button class="menu" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">Menu</button>
  <a class="brand" href="/" aria-label="Papertrade Liquidations, home"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="brand-text">Papertrade <b>Liquidations</b></span></a>
  <span class="tag">Docs</span>
  <div class="search"><label class="sr-only" for="q">Search the docs</label><input id="q" type="search" placeholder="Search the docs" autocomplete="off" aria-controls="results"><ul id="results" role="listbox" hidden></ul></div>
  <a class="plain" href="https://github.com/nirholas/papertrade-liquidations" rel="noopener">GitHub</a>
  <button class="theme" type="button" aria-label="Toggle light and dark theme">Theme</button>
</header>
<div class="dlayout">
  <nav id="sidebar" class="side" aria-label="Documentation">${nav}</nav>
  <main id="content" class="doc">
    <article>
${html}
    </article>
    <p class="twin"><a href="${page.mdPath}">View as markdown</a></p>
    <nav class="pager" aria-label="Pages">${prev ? `<a class="prev" href="${prev.path}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${next.path}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}</nav>
    <footer class="dfoot"><p><strong>Unofficial.</strong> Not affiliated with Papertrade. High leverage can lose your whole margin. Apache-2.0. <a href="/llms.txt">llms.txt</a> &middot; <a href="/mcp">MCP</a> &middot; <a href="/openapi.json">openapi.json</a></p></footer>
  </main>
  ${tocHtml}
</div>
<script src="/docs/docs.js" defer></script>
</body>
</html>
`;
}

export function build() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const pages = readdirSync(srcDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const name = f.replace(/\.md$/, '');
      const raw = readFileSync(join(srcDir, f), 'utf8');
      const { meta, body } = parseFrontMatter(raw);
      const path = name === 'index' ? '/docs/' : `/docs/${name}`;
      return { name, title: meta.title ?? name, description: meta.description ?? '', order: Number(meta.order ?? 99), body, path, mdPath: `/docs/${name}.md` };
    })
    .sort((a, b) => a.order - b.order);

  for (const f of ['docs.css', 'docs.js', 'theme.js']) copyFileSync(join(root, 'site/docs-assets', f), join(outDir, f));
  const index = [];
  pages.forEach((page, i) => {
    const { html, toc } = render(page.body);
    writeFileSync(join(outDir, `${page.name}.html`), shell(page, pages, i, html, toc));
    writeFileSync(join(outDir, `${page.name}.md`), `# ${page.title}\n\n> ${page.description}\n\nCanonical: ${SITE}${page.path}\n\n${page.body.replace(/^# .*\n+/, '')}`);
    index.push({ title: page.title, path: page.path, description: page.description, text: plain(page.body) });
    for (const h of toc) index.push({ title: `${page.title}: ${h.text}`, path: `${page.path}#${h.id}`, description: '', text: '' });
  });
  writeFileSync(join(outDir, 'search-index.json'), JSON.stringify(index));

  const intro = readFileSync(join(root, 'scripts/llms-intro.txt'), 'utf8').trimEnd();
  const list = pages.map((p) => `- [${p.title}](${SITE}${p.mdPath}): ${p.description}`).join('\n');
  writeFileSync(join(pub, 'llms.txt'), `${intro}\n\n## Docs\n\n${list}\n`);
  const full = pages.map((p) => `<!-- ${SITE}${p.path} -->\n\n# ${p.title}\n\n${p.body.replace(/^# .*\n+/, '')}`).join('\n\n---\n\n');
  writeFileSync(join(pub, 'llms-full.txt'), `${intro}\n\n---\n\n${full}\n`);
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pages = build();
  console.log(`docs: ${pages.length} pages`);
}
