import Link from 'next/link';
import { searchTools, selectionFromParams } from '@keco/query';
import { query } from '@/lib/query';

/**
 * Search (§9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work. This server rendering is the no-JS
 * baseline; the interactive client component layers on top of the same URL state.
 *
 * Every taxonomy family is readable from the URL by its declared `param`, so a new family
 * needs no change here.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : '';

  const results = await searchTools(query, {
    q,
    filters: selectionFromParams(params),
    sort: (params.sort as 'relevance' | 'stars' | 'score' | 'momentum' | 'recent') ?? 'relevance',
    page: Number(params.page ?? 1),
  });

  return (
    <main>
      <form action="/search">
        <input name="q" type="search" defaultValue={q} aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      <p>
        {results.total} tools · {results.processingTimeMs} ms
      </p>

      {results.total === 0 && (
        // Empty and zero-result states must suggest something useful (§9).
        <section>
          <h2>No matches</h2>
          <p>
            Try a broader term, or browse by <Link href="/search?kind=operator">operators</Link>,{' '}
            <Link href="/search?domain=observability">observability</Link> or{' '}
            <Link href="/search?install=krew">kubectl plugins</Link>.
          </p>
        </section>
      )}

      <ul>
        {results.hits.map((tool) => (
          <li key={tool.id}>
            <Link href={`/tools/${tool.full_name}`}>{tool.full_name}</Link>
            <p>{tool.summary}</p>
            <small>
              {tool.kind} · {tool.domains.join(', ')} · ★ {tool.stars}
              {tool.archived && ' · archived'}
            </small>
          </li>
        ))}
      </ul>
    </main>
  );
}
