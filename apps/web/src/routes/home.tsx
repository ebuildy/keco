import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { Kbd } from '../components/primitives/kbd';
import { Meter } from '../components/primitives/meter';
import { ToolIcon } from '../components/primitives/tool-icon';
import { TopicChips } from '../components/topic-chips';
import { formatUtcDate } from '../lib/dates';
import { browseFacets, searchErrorMessage, whatsHot } from '../lib/search';
import { SITE_SEARCH_ID } from '../lib/site-search';
import { chipRows, type ChipRow } from '../lib/topics';

/**
 * Home (AGENTS.md §9): a hero search field, then Browse — one chip row per facetable family,
 * built from the `tools` facet distribution — then Highest momentum.
 *
 * Both queries go straight to Meilisearch from the browser (§9). They are issued together
 * because neither depends on the other, and the facet query costs one request whether or not
 * the momentum list is on the page.
 */
export function HomePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ChipRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hot, setHot] = useState<ToolDocument[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([browseFacets(), whatsHot(12)])
      .then(([browse, tools]) => {
        if (cancelled) return;
        setRows(chipRows(browse.facets));
        setTotal(browse.total);
        setHot(tools);
      })
      // A blank SPA tells the reader nothing. Say what failed (§9 empty states) — and say it
      // precisely: "not configured" and "down" are different problems (§12).
      .catch((error: unknown) => !cancelled && setError(searchErrorMessage(error)))
      .finally(() => {
        // An empty index is a true state of the system before the first crawl, not a failure.
        // Distinguishing "no answer yet" from "the answer is zero" is what keeps the count
        // honest rather than flashing a zero that was never measured.
        if (!cancelled) setTotal((current) => current ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const freshest = hot[0]?.indexed_at;

  return (
    <main className="mx-auto max-w-[1200px] px-4">
      <section className="py-14 text-center">
        <h1 className="text-[32px] font-bold leading-tight tracking-tight text-fg sm:text-[40px]">
          Find the right Kubernetes tool in 10 seconds
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-muted">
          Ranked by health — maintenance, releases, security posture — not by stars.
        </p>

        <form
          className="mx-auto mt-7 flex max-w-[560px] items-center gap-2.5 rounded-card border-[1.5px] border-accent bg-surface px-3.5 py-2.5 shadow-[0_4px_14px_rgb(50_108_229/0.13)]"
          onSubmit={(event) => {
            event.preventDefault();
            const q = new FormData(event.currentTarget).get('q');
            void navigate(`/search?q=${encodeURIComponent(typeof q === 'string' ? q : '')}`);
          }}
        >
          <label htmlFor={SITE_SEARCH_ID} className="sr-only">
            Search the Kubernetes ecosystem
          </label>
          <span aria-hidden="true" className="text-accent">
            ⌕
          </span>
          {/* Shares SITE_SEARCH_ID with the header field, which is legal because the two never
              coexist: SiteHeader renders its form only when the route is not `/`. */}
          <input
            id={SITE_SEARCH_ID}
            name="q"
            type="search"
            placeholder="ingress controller, cost, backup…"
            className="min-w-0 flex-1 bg-transparent text-left text-sm outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            className="shrink-0 rounded-control bg-accent px-3 py-1 text-xs font-semibold text-accent-on"
          >
            Search
          </button>
        </form>

        {total !== null && total > 0 && (
          <p className="mt-3 text-xs text-faint">
            <span className="font-mono tabular-nums">{total.toLocaleString('en-GB')}</span>{' '}
            repositories classified
            {freshest && <> · updated {formatUtcDate(freshest)}</>}
          </p>
        )}
      </section>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-bad"
        >
          {error}
        </p>
      )}

      {/* Renders nothing until the first crawl has filled the index. */}
      <TopicChips rows={rows} />

      {hot.length > 0 && (
        <section className="py-10">
          {/* "Momentum", never "trending this week": there is no history to measure (§4.4). */}
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="text-[15px] font-bold tracking-tight text-fg">Highest momentum</h2>
            <span className="text-xs text-faint">stars per day of age, damped by activity</span>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hot.map((tool) => (
              <li key={tool.id}>
                <Link
                  to={`/tools/${tool.full_name}`}
                  className="block h-full rounded-card border border-line bg-surface p-3.5 shadow-card transition-colors hover:border-accent"
                >
                  <div className="flex items-start gap-2.5">
                    <ToolIcon tool={tool} size={32} className="size-8 text-2xl" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold text-accent-text">{tool.name}</span>
                        <span className="ml-auto font-mono text-xs tabular-nums text-muted">
                          {tool.score.total.toFixed(2)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-faint">{tool.owner}</div>
                    </div>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-fg-2">
                    {tool.summary}
                  </p>
                  <Meter
                    value={tool.score.total}
                    label={`${tool.full_name} health`}
                    className="mt-2.5"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="pb-4 text-xs text-faint">
        Press <Kbd>/</Kbd> anywhere to search.
      </p>
    </main>
  );
}
