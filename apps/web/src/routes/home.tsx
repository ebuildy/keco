import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { TopicChips } from '../components/topic-chips';
import { browseFacets, whatsHot } from '../lib/search';
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
  const [hot, setHot] = useState<ToolDocument[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([browseFacets(), whatsHot(12)])
      .then(([facets, tools]) => {
        if (cancelled) return;
        setRows(chipRows(facets));
        setHot(tools);
      })
      // A blank SPA tells the reader nothing. Say what failed (§9 empty states).
      .catch(() => !cancelled && setError('Search is unavailable right now.'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Keco</h1>
      <p>Find the right Kubernetes tool in 10 seconds, not 10 browser tabs.</p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const q = new FormData(event.currentTarget).get('q');
          void navigate(`/search?q=${encodeURIComponent(typeof q === 'string' ? q : '')}`);
        }}
      >
        <label htmlFor="q">Search the Kubernetes ecosystem</label>
        <input id="q" name="q" type="search" placeholder="ingress controller, cost, backup…" />
        <button type="submit">Search</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {/* Renders nothing until the first crawl has filled the index. */}
      <TopicChips rows={rows} />

      {hot.length > 0 && (
        <>
          {/* "Momentum", never "trending this week": there is no history to measure (§4.4). */}
          <h2>Highest momentum</h2>
          <ul>
            {hot.map((tool) => (
              <li key={tool.id}>
                <Link to={`/tools/${tool.full_name}`}>{tool.full_name}</Link> — {tool.summary}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
