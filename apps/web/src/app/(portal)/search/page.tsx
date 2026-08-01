import Link from 'next/link';
import type { Domain, Kind } from '@keco/core';
import { searchTools } from '@keco/query';
import { query } from '@/lib/query';

/**
 * Search (§9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work. This server rendering is the no-JS
 * baseline; the interactive client component layers on top of the same URL state.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : value.split(',').filter(Boolean);

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : '';

  const results = await searchTools(query, {
    q,
    kind: list(params.kind) as Kind[],
    domains: list(params.domain) as Domain[],
    install: list(params.install),
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
