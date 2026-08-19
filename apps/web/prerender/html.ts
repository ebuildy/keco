import type { ToolDocument } from '@keco/core';

/**
 * Pure assembly of the prerendered artifacts (AGENTS.md §9). No I/O and no React, so it is
 * testable on a fixture document — `index.ts` does the querying, rendering and writing.
 *
 * Every substitution is asserted. A shell edit that silently stops matching would ship tool
 * pages with an empty `#root` and the generic title, which is exactly the blocking SEO
 * regression §9 describes; failing the build is the only acceptable behaviour.
 */
const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

/**
 * Serialises data for an inline `<script>`. The corpus is derived from 30k strangers'
 * repositories, so a summary containing `</script>` must not be able to close the element.
 */
const serialize = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/**
 * Replaces `pattern` exactly once, or throws — a silent miss is a shipped regression.
 *
 * Detects the miss by whether the callback ran, not by comparing the strings before and
 * after: when `replacement` happens to equal the matched text (e.g. an empty `markup`
 * against an already-empty `<div id="root"></div>`), a before/after string comparison is a
 * false positive that would throw on a perfectly good match.
 */
function replaceOnce(html: string, pattern: RegExp | string, replacement: string, what: string): string {
  let matched = false;
  const next = html.replace(pattern, () => {
    matched = true;
    return replacement;
  });
  if (!matched) {
    throw new Error(
      `prerender: the built shell no longer contains ${what}. index.html and prerender/html.ts have to agree — see AGENTS.md §9.`,
    );
  }
  return next;
}

export type ToolPageOptions = {
  tool: ToolDocument;
  /** `renderToString` output for this route. */
  markup: string;
  siteUrl: string;
};

export function toolPageHtml(shell: string, options: ToolPageOptions): string {
  const { tool, markup, siteUrl } = options;
  const url = `${siteUrl}/tools/${tool.full_name}`;
  const description = truncate(tool.summary || tool.description || `${tool.full_name} on Keco`, 155);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: tool.full_name,
    description: tool.summary,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows',
    url,
    codeRepository: tool.repo_url,
    license: tool.license,
    // Eventual consistency is the contract; freshness is published, not hidden (§2.7).
    dateModified: tool.indexed_at,
  };

  const head = [
    `<link rel="canonical" href="${escapeAttribute(url)}" />`,
    `<script type="application/ld+json">${serialize(jsonLd)}</script>`,
    // Read by src/lib/bootstrap.ts, so the client's first render matches this markup.
    `<script>window.__KECO_DATA__=${serialize({ tool })}</script>`,
  ].join('\n    ');

  let html = replaceOnce(
    shell,
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeText(`${tool.full_name} · Keco`)}</title>`,
    'a <title> element',
  );
  html = replaceOnce(
    html,
    /<meta\s+name="description"[\s\S]*?\/?>/,
    `<meta name="description" content="${escapeAttribute(description)}" />`,
    'a <meta name="description"> element',
  );
  html = replaceOnce(html, '</head>', `  ${head}\n  </head>`, 'a </head> tag');
  html = replaceOnce(
    html,
    '<div id="root"></div>',
    `<div id="root">${markup}</div>`,
    'an empty <div id="root">',
  );

  return html;
}

export function sitemapXml(siteUrl: string, tools: ToolDocument[]): string {
  const entries = tools
    .map(
      (tool) =>
        `  <url>\n    <loc>${escapeText(`${siteUrl}/tools/${tool.full_name}`)}</loc>\n    <lastmod>${escapeText(tool.indexed_at)}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`,
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url>\n    <loc>${escapeText(siteUrl)}</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    entries,
    '</urlset>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** /admin is noindex and never prerendered (§9). */
export const robotsTxt = (siteUrl: string): string =>
  ['User-agent: *', 'Allow: /', 'Disallow: /admin', '', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join('\n');
