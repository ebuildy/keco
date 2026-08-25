import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { Chip } from '../components/primitives/chip';
import { ToolIcon } from '../components/primitives/tool-icon';
import { StatusPill } from '../components/primitives/status-pill';
import { FactList } from '../components/tool/fact-list';
import { InstallTabs } from '../components/tool/install-tabs';
import { RelatedList } from '../components/tool/related-list';
import { ScoreMeters } from '../components/tool/score-meters';
import { bootstrapToolFor } from '../lib/bootstrap';
import { findAlternatives, getTool } from '../lib/search';
import { taxonomyLinks } from '../lib/tool-taxonomy';
import { NotFoundPage } from './not-found';

/**
 * Tool page — the SEO surface (AGENTS.md §9), and the one route the prerender emits as static
 * HTML. Everything above the README is rendered from the `tools` document alone, which is why
 * the prerendered file carries real content without touching the cache.
 *
 * The README is a two-stage thing on purpose. `readme_excerpt` ships inside the document, so
 * it is in the prerendered HTML a crawler reads. The full README lives in the cache, which a
 * browser cannot read, so it arrives from `GET /api/readme/:owner/:repo` — already sanitised
 * server-side, which is the only reason the HTML below is injected at all (§9, §14).
 */
type ReadmeResponse = { repo: string; html: string };

export function ToolPage() {
  const { owner, repo } = useParams<{ owner: string; repo: string }>();
  const fullName = `${owner}/${repo}`;

  // Prerendered pages already have the document; only a client-side navigation fetches it.
  // `bootstrapToolFor` refuses a bootstrap left over from a different route (§6, §9).
  const [tool, setTool] = useState<ToolDocument | null>(() => bootstrapToolFor(fullName));
  const [loading, setLoading] = useState(tool === null);

  /**
   * Both of these carry the repo they belong to, and both are matched against the current tool
   * at render time rather than cleared in an effect.
   *
   * A client navigation from A to B commits B's document — and therefore B's `<h1>` and B's
   * "README" heading — before any effect runs. State holding only `html` would put A's
   * documentation, and A's alternatives, under B's headings for a full network round trip.
   * Clearing in the effect shortens that window to one painted frame; carrying the identity
   * closes it, because the mismatch is visible during the very render that causes it.
   *
   * Attributing one repository's documentation to another is the shape of claim §1 and §6
   * exist to prevent — the corpus is 30k strangers' repos and the whole product is that the
   * data is trustworthy.
   */
  const [related, setRelated] = useState<{ repo: string; tools: ToolDocument[] } | null>(null);
  const [readme, setReadme] = useState<ReadmeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (tool?.full_name === fullName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getTool(fullName)
      .then((next) => {
        if (cancelled) return;
        setTool(next);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fullName]);

  useEffect(() => {
    if (!tool) return;
    let cancelled = false;

    const repo = tool.full_name;

    void findAlternatives(tool, 6).then(
      (next) => !cancelled && setRelated({ repo, tools: next }),
    );

    fetch(`/api/readme/${repo}`)
      .then((response) => (response.ok ? (response.json() as Promise<ReadmeResponse>) : null))
      // The endpoint echoes the repo it rendered, so the response carries its own identity and
      // a late reply for a repo the reader has already navigated away from cannot be adopted.
      .then((body) => !cancelled && body !== null && setReadme(body))
      // No cached README is an ordinary state before the crawler reaches a repo, not an error.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [tool?.full_name]);

  if (loading) {
    return (
      <main aria-busy="true" className="mx-auto max-w-[1200px] px-4 py-16 text-sm text-muted">
        Loading {fullName}…
      </main>
    );
  }
  if (!tool) return <NotFoundPage />;

  // Only shown when it belongs to the tool on screen. See the state declarations above.
  const readmeHtml = readme?.repo === tool.full_name ? readme.html : null;
  const relatedTools = related?.repo === tool.full_name ? related.tools : [];

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-6">
      <div className="grid gap-8 lg:grid-cols-[1fr_250px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2.5">
            {/* Decorative and aria-hidden, so the `<h1>` a crawler and a screen reader read
                is still the tool's name alone — the prerender contract of §9 is untouched. */}
            <ToolIcon tool={tool} size={160} className="size-16 self-center text-5xl" />
            <h1 className="text-[25px] font-bold tracking-tight text-fg">{tool.name}</h1>
            <span className="font-mono text-[12.5px] text-faint">{tool.full_name}</span>
            {tool.archived && <StatusPill tone="warn">Archived</StatusPill>}
            {tool.needs_review && <StatusPill tone="warn">Needs review</StatusPill>}
          </div>

          <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-fg-2">{tool.summary}</p>

          {/* Every classification on this page is a way into the corpus: each chip is a link
              to the search page filtered on that value, using the family's declared `param`
              (§6, §9). `taxonomyLinks` does the labelling and the hiding — see the docblock
              there for why a raw id or an `unknown` never reaches this row. */}
          <nav aria-label="Classification" className="mt-3.5">
            <ul className="flex flex-wrap gap-1.5">
              {taxonomyLinks(tool).map((link) => (
                <li key={link.id}>
                  <Chip
                    label={link.label}
                    to={link.href}
                    title={`${link.familyLabel}: ${link.description}`}
                  />
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-5">
            <InstallTabs methods={tool.install_methods} />
          </div>

          <section aria-labelledby="readme" className="mt-5">
            <h2 id="readme" className="mb-2 text-[15px] font-semibold text-fg">
              README
            </h2>
            <div className="rounded-card border border-line bg-surface p-4 shadow-card">
              {readmeHtml === null ? (
                // The excerpt is in the document, so it is in the prerendered HTML too — this is
                // the indexable prose on the page until the full README arrives.
                <p className="text-[13px] leading-relaxed text-fg-2">{tool.readme_excerpt}</p>
              ) : (
                // Sanitised by apps/api with rehype-sanitize before it ever reached the browser
                // (§9, §14). Never do this to raw markdown.
                //
                // `prose-keco` is not decoration: Tailwind's preflight strips every element
                // default, so without it this corpus-derived documentation — the indexable prose
                // on the SEO surface — renders as flat unstyled text.
                <div
                  className="prose prose-sm prose-keco dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: readmeHtml }}
                />
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-3">
          <ScoreMeters score={tool.score} />
          <FactList tool={tool} />
          <RelatedList tools={relatedTools} />
          <p className="text-[10.5px] leading-relaxed text-faint">
            Data from GitHub, indexed {new Date(tool.indexed_at).toISOString()}.
          </p>
        </aside>
      </div>
    </main>
  );
}
