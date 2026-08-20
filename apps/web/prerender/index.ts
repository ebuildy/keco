import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { createQueryClient, searchTools } from '@keco/query';
import { App } from '../src/app';
import { setBootstrap } from '../src/lib/bootstrap';
import { isSafeFullName, robotsTxt, sitemapXml, toolPageHtml } from './html';

/**
 * Build-time prerender (AGENTS.md §9). Dropping Next.js dropped server rendering, and a bare
 * SPA is not indexable enough for a portal whose acquisition channel is organic search — so
 * this is not optional, and a change that makes the top tool pages non-prerenderable is a
 * blocking regression.
 *
 * It reads the read model and nothing else. No cache, no GitHub, no running API: the README
 * that ends up in each page is `readme_excerpt`, which is already inside the `tools`
 * document. The full README is fetched client-side from apps/api.
 *
 * `renderToString` runs the same route tree the browser mounts, so what a crawler sees and
 * what a reader sees cannot drift.
 *
 * Prerendered HTML is exactly as stale as the last build; rebuild on the projector's full
 * rebuild cadence and keep `indexed_at` visible so the staleness stays honest.
 */
const TOP_N = 1000;

const dist = resolve(import.meta.dirname, '..', 'dist');
const siteUrl = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const shell = await readFile(join(dist, 'index.html'), 'utf8').catch(() => {
  throw new Error(`prerender: ${join(dist, 'index.html')} not found — run \`vite build\` first.`);
});

// Meilisearch being unreachable fails the build. An empty index does not: before the first
// crawl there is genuinely nothing to prerender, and that is a true state of the system.
const client = createQueryClient();
const top = await searchTools(client, { sort: 'score', hitsPerPage: TOP_N });

/**
 * Only documents whose `full_name` is a real `owner/repo` are emitted. Anything else is
 * skipped loudly rather than silently: a document that cannot be named cannot be linked
 * either, so dropping it is the correct outcome, but it means the projector wrote something
 * malformed and somebody should know.
 */
const prerenderRoot = join(dist, 'prerendered', 'tools');
const emitted: typeof top.hits = [];

for (const tool of top.hits) {
  if (!isSafeFullName(tool.full_name)) {
    console.warn(`prerender: skipping unsafe full_name ${JSON.stringify(tool.full_name)}`);
    continue;
  }

  // Single-threaded, one page at a time: the component tree reads this through readBootstrap().
  setBootstrap({ tool });
  const markup = renderToString(
    createElement(StaticRouter, { location: `/tools/${tool.full_name}` }, createElement(App)),
  );
  setBootstrap(null);

  const file = join(prerenderRoot, `${tool.full_name}.html`);
  // Belt and braces. isSafeFullName already makes this unreachable; if a future edit widens
  // the vocabulary, the build fails here instead of writing somewhere it should not.
  if (!resolve(file).startsWith(`${resolve(prerenderRoot)}/`)) {
    throw new Error(`prerender: ${tool.full_name} resolves outside ${prerenderRoot}`);
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, toolPageHtml(shell, { tool, markup, siteUrl }), 'utf8');
  emitted.push(tool);
}

await writeFile(join(dist, 'sitemap.xml'), sitemapXml(siteUrl, emitted), 'utf8');
await writeFile(join(dist, 'robots.txt'), robotsTxt(siteUrl), 'utf8');
// apps/api loads this at boot and serves a prerendered file only for a path it lists.
await writeFile(
  join(dist, 'prerender-manifest.json'),
  `${JSON.stringify({ paths: emitted.map((tool) => `/tools/${tool.full_name}`) }, null, 2)}\n`,
  'utf8',
);

console.log(`prerender: ${emitted.length} tool pages, sitemap and robots.txt → ${dist}`);
