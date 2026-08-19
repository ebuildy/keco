import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { readBootstrap } from '../lib/bootstrap';
import { findAlternatives, getTool } from '../lib/search';
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
  const [tool, setTool] = useState<ToolDocument | null>(() => readBootstrap().tool ?? null);
  const [loading, setLoading] = useState(tool === null);
  const [related, setRelated] = useState<ToolDocument[]>([]);
  const [readmeHtml, setReadmeHtml] = useState<string | null>(null);

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

    void findAlternatives(tool, 6).then((next) => !cancelled && setRelated(next));

    fetch(`/api/readme/${tool.full_name}`)
      .then((response) => (response.ok ? (response.json() as Promise<ReadmeResponse>) : null))
      .then((body) => !cancelled && setReadmeHtml(body?.html ?? null))
      // No cached README is an ordinary state before the crawler reaches a repo, not an error.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [tool?.full_name]);

  if (loading) return <main aria-busy="true">Loading {fullName}…</main>;
  if (!tool) return <NotFoundPage />;

  return (
    <main>
      <h1>{tool.full_name}</h1>
      <p>{tool.summary}</p>

      <section>
        <h2>Install</h2>
        {tool.install_methods.length === 0 ? (
          // Unprovable ⇒ not listed. A wrong `brew install` line is the worst bug this
          // project can ship — people paste these into a terminal (§6).
          <p>No install method verified against a registry.</p>
        ) : (
          <ul>
            {tool.install_methods.map((method) => (
              <li key={method.method}>
                <code>{method.command}</code>{' '}
                <a href={method.source_url} rel="noreferrer">
                  proof
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Health</h2>
        <dl>
          <dt>Score</dt>
          <dd>{tool.score.total.toFixed(2)}</dd>
          <dt>Quality coverage</dt>
          {/* 0.9 from four signals and 0.9 from one are not the same claim (§4.3). */}
          <dd>{Math.round(tool.score.quality_coverage * 100)}% of signals present</dd>
          <dt>Momentum</dt>
          <dd>{tool.score.momentum.toFixed(2)}</dd>
        </dl>
      </section>

      <aside>
        <ul>
          <li>★ {tool.stars}</li>
          <li>{tool.language ?? 'unknown language'}</li>
          <li>{tool.license ?? 'no license'}</li>
          <li>Last commit {new Date(tool.pushed_at).toDateString()}</li>
          <li>
            <a href={tool.repo_url} rel="noreferrer">
              Source on GitHub
            </a>
          </li>
        </ul>
      </aside>

      <section>
        <h2>README</h2>
        {readmeHtml === null ? (
          // The excerpt is in the document, so it is in the prerendered HTML too — this is the
          // indexable prose on the page until the full README arrives.
          <p>{tool.readme_excerpt}</p>
        ) : (
          // Sanitised by apps/api with rehype-sanitize before it ever reached the browser
          // (§9, §14). Never do this to raw markdown.
          <div dangerouslySetInnerHTML={{ __html: readmeHtml }} />
        )}
      </section>

      {related.length > 0 && (
        <section>
          <h2>Related</h2>
          <ul>
            {related.map((other) => (
              <li key={other.id}>
                <Link to={`/tools/${other.full_name}`}>{other.full_name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer>Data from GitHub, updated {new Date(tool.indexed_at).toISOString()}.</footer>
    </main>
  );
}
