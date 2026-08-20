import { describe, expect, it } from 'vitest';
import type { ToolDocument } from '@keco/core';
import { isSafeFullName, robotsTxt, sitemapXml, toolPageHtml } from './html';

const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <title>Keco — the Kubernetes ecosystem search engine</title>',
  '    <meta name="description" content="Search the Kubernetes ecosystem." />',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '    <script type="module" src="/assets/main-abc123.js"></script>',
  '  </body>',
  '</html>',
].join('\n');

const tool = {
  id: 'ahmetb__kubectx',
  owner: 'ahmetb',
  name: 'kubectx',
  full_name: 'ahmetb/kubectx',
  description: 'Faster way to switch between clusters and namespaces in kubectl',
  summary: 'Fast context and namespace switching for kubectl.',
  repo_url: 'https://github.com/ahmetb/kubectx',
  homepage: null,
  license: 'Apache-2.0',
  stars: 18000,
  kind: 'cli',
  domains: ['dev-experience'],
  readme_excerpt: 'kubectx is a tool to switch between contexts in your kubeconfig.',
  indexed_at: '2026-08-18T00:00:00.000Z',
} as unknown as ToolDocument;

const html = toolPageHtml(SHELL, { tool, markup: '<main><h1>ahmetb/kubectx</h1></main>', siteUrl: 'https://keco.dev' });

describe('toolPageHtml', () => {
  it('puts the tool in the title', () => {
    expect(html).toContain('<title>ahmetb/kubectx · Keco</title>');
    expect(html).not.toContain('the Kubernetes ecosystem search engine</title>');
  });

  it('replaces the shell meta description with the tool summary', () => {
    expect(html).toContain('content="Fast context and namespace switching for kubectl."');
    expect(html).not.toContain('content="Search the Kubernetes ecosystem."');
  });

  it('inlines the rendered markup inside #root so a crawler sees an h1', () => {
    expect(html).toContain('<div id="root"><main><h1>ahmetb/kubectx</h1></main></div>');
  });

  it('emits a canonical link', () => {
    expect(html).toContain('<link rel="canonical" href="https://keco.dev/tools/ahmetb/kubectx"');
  });

  it('emits JSON-LD describing a SoftwareApplication', () => {
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const jsonLd = JSON.parse(match![1]!);
    expect(jsonLd['@type']).toBe('SoftwareApplication');
    expect(jsonLd.name).toBe('ahmetb/kubectx');
    expect(jsonLd.codeRepository).toBe('https://github.com/ahmetb/kubectx');
  });

  it('embeds the document so the client hydrates over matching markup', () => {
    expect(html).toContain('window.__KECO_DATA__=');
    expect(html).toContain('ahmetb/kubectx');
  });

  it('escapes a closing script tag in the embedded data', () => {
    // A summary containing </script> would otherwise break out of the script element and
    // become markup — the corpus is derived from 30k strangers' repositories.
    const hostile = { ...tool, summary: 'ends the tag </script><img src=x onerror=alert(1)>' };
    const output = toolPageHtml(SHELL, { tool: hostile, markup: '', siteUrl: 'https://keco.dev' });
    expect(output).not.toContain('</script><img');
    expect(output).toContain('\\u003c/script');
  });

  it('escapes quotes in the meta description', () => {
    const quoted = { ...tool, summary: 'a "quoted" summary' };
    const output = toolPageHtml(SHELL, { tool: quoted, markup: '', siteUrl: 'https://keco.dev' });
    expect(output).toContain('&quot;quoted&quot;');
  });

  it('throws when the shell no longer contains what it replaces', () => {
    // A silent no-op here ships a portal Google cannot read, which §9 calls a blocking
    // regression. Fail the build instead.
    expect(() =>
      toolPageHtml('<html><head></head><body></body></html>', {
        tool,
        markup: '',
        siteUrl: 'https://keco.dev',
      }),
    ).toThrow(/shell/i);
  });
});

describe('sitemapXml', () => {
  it('lists the home page and every prerendered tool', () => {
    const xml = sitemapXml('https://keco.dev', [tool]);
    expect(xml).toContain('<loc>https://keco.dev</loc>');
    expect(xml).toContain('<loc>https://keco.dev/tools/ahmetb/kubectx</loc>');
    expect(xml).toContain('<lastmod>2026-08-18T00:00:00.000Z</lastmod>');
  });

  it('is valid XML with a single urlset root', () => {
    const xml = sitemapXml('https://keco.dev', []);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml.match(/<urlset/g)).toHaveLength(1);
  });
});

describe('robotsTxt', () => {
  it('points at the sitemap and keeps /admin out of the index', () => {
    const txt = robotsTxt('https://keco.dev');
    expect(txt).toContain('Sitemap: https://keco.dev/sitemap.xml');
    expect(txt).toContain('Disallow: /admin');
  });
});

describe('isSafeFullName', () => {
  it('accepts real owner/repo names', () => {
    for (const name of ['ahmetb/kubectx', 'kubernetes-sigs/krew-index', 'a/b.c', 'x/y_z-1']) {
      expect(isSafeFullName(name), name).toBe(true);
    }
  });

  it('rejects the traversal that escaped dist before this existed', () => {
    // Verified: full_name '../../../../PWNED' wrote HTML outside apps/web/dist entirely.
    // The prerender turns this field into a filename, so it is a boundary (AGENTS.md §13)
    // even though the projector is the only writer of the read model.
    for (const name of [
      '../../../../PWNED',
      'a/../../b',
      '../x/y',
      'a/b/../../../c',
      'a/..',
      '/etc/passwd',
      'a//b',
      'a/b/c',
      '',
      'a/',
      '/b',
    ]) {
      expect(isSafeFullName(name), name).toBe(false);
    }
  });
});
