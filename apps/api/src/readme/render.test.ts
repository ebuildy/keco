import { describe, expect, it } from 'vitest';
import { renderReadme, warmReadmeRenderer } from './render';

const BASE = 'https://raw.githubusercontent.com/kubernetes/kubectl/HEAD/';

// Shiki loads its grammars and themes lazily on first render — up to 6.6s under full-suite
// CPU contention, past vitest's 5s per-test default. Paying it during module import, not
// inside a test, keeps that cost off any single test's clock (see vitest.config.ts).
await warmReadmeRenderer();

describe('renderReadme', () => {
  it('renders ordinary markdown', async () => {
    const html = await renderReadme('# Title\n\nSome **bold** prose.', BASE);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('strips script tags', async () => {
    // READMEs are untrusted input from 30k strangers (§14).
    const html = await renderReadme('Hello\n\n<script>alert(1)</script>', BASE);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips inline event handlers and javascript: URLs', async () => {
    const html = await renderReadme('<img src="x" onerror="alert(1)">\n\n[go](javascript:alert(1))', BASE);
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });

  it('rewrites relative image paths against image_base_url', async () => {
    // Relative README images break unless rewritten — test with kubernetes/kubectl (§14).
    const html = await renderReadme('![logo](docs/logo.png)', BASE);
    expect(html).toContain(`${BASE}docs/logo.png`);
  });

  it('rewrites relative links but leaves absolute ones alone', async () => {
    const html = await renderReadme('[docs](docs/readme.md) and [gh](https://github.com/x/y)', BASE);
    expect(html).toContain(`${BASE}docs/readme.md`);
    expect(html).toContain('https://github.com/x/y');
  });

  it('leaves anchors alone', async () => {
    const html = await renderReadme('[top](#installation)', BASE);
    expect(html).toContain('href="#installation"');
  });

  it('drops a leading badge-only paragraph', async () => {
    const markdown = [
      '# kubectx',
      '',
      '[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example/x)',
      '[![license](https://img.shields.io/badge/license-Apache-blue)](https://example/l)',
      '',
      'Real prose starts here.',
    ].join('\n');
    const html = await renderReadme(markdown, BASE);
    expect(html).toContain('<h1>kubectx</h1>');
    expect(html).toContain('Real prose starts here.');
    expect(html).not.toContain('img.shields.io');
  });

  it('keeps a paragraph that only looks like badges but carries prose', async () => {
    const markdown = '# x\n\n![logo](logo.png) A real sentence about the project.';
    const html = await renderReadme(markdown, BASE);
    expect(html).toContain('A real sentence about the project.');
  });

  it('highlights fenced code with Shiki', async () => {
    const html = await renderReadme('```bash\nkubectl get pods\n```', BASE);
    expect(html).toContain('shiki');
    expect(html).toContain('kubectl');
  });

  it('renders GitHub-flavoured tables', async () => {
    const html = await renderReadme('| a | b |\n| - | - |\n| 1 | 2 |', BASE);
    expect(html).toContain('<table>');
  });

  it('keeps details/summary, which READMEs lean on for collapsible sections', async () => {
    const html = await renderReadme('<details><summary>More</summary>\n\nhidden\n\n</details>', BASE);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
  });

  it('strips style/title/textarea/noembed/noframes content instead of leaving it as visible page text', async () => {
    // defaultSchema.strip only lists `script`; these tags are removed but their text content
    // is kept by default, which renders e.g. `.a{color:red}` as literal text on the page.
    // Escaped, so not XSS — but a visible rendering bug worth pinning down.
    const markdown = [
      'Hello',
      '',
      '<style>.a{color:red}</style>',
      '<title>evil title</title>',
      '<textarea>leaked</textarea>',
      '<noembed>leaked-embed</noembed>',
      '<noframes>leaked-frames</noframes>',
      '',
      'World',
    ].join('\n');
    const html = await renderReadme(markdown, BASE);
    expect(html).toContain('Hello');
    expect(html).toContain('World');
    expect(html).not.toContain('.a{color:red}');
    expect(html).not.toContain('evil title');
    expect(html).not.toContain('leaked');
  });
});
