import Link from 'next/link';
import { searchTools, whatsHot } from '@keco/query';
import { query } from '@/lib/query';
import { chipRows } from '@/lib/topics';
import { TopicChips } from './topic-chips';

/**
 * Home — RSC (§9). Keep request-scoped APIs (cookies(), headers()) out of portal routes:
 * touching one silently turns the route dynamic and `revalidate` stops meaning anything.
 */
export const revalidate = 900;

export default async function HomePage() {
  // hitsPerPage: 0 buys the facet distribution for every family without paying for hits.
  const [hot, browse] = await Promise.all([
    whatsHot(query, { limit: 12 }),
    searchTools(query, { hitsPerPage: 0 }),
  ]);

  return (
    <main>
      <h1>Keco</h1>
      <p>Find the right Kubernetes tool in 10 seconds, not 10 browser tabs.</p>

      <form action="/search">
        <label htmlFor="q">Search the Kubernetes ecosystem</label>
        {/* Works with JS disabled — the search page reads the same URL state (§15.5). */}
        <input id="q" name="q" type="search" placeholder="ingress controller, cost, backup…" />
        <button type="submit">Search</button>
      </form>

      {/* Renders nothing until the first crawl has filled the index. */}
      <TopicChips rows={chipRows(browse.facets)} />

      {/* "Momentum", never "trending this week": there is no history to measure (§4.3). */}
      <h2>Highest momentum</h2>
      <ul>
        {hot.map((tool) => (
          <li key={tool.id}>
            <Link href={`/tools/${tool.full_name}`}>{tool.full_name}</Link> — {tool.summary}
          </li>
        ))}
      </ul>
    </main>
  );
}
