import { NextResponse } from 'next/server';
import type { Domain, Kind } from '@keco/core';
import { searchTools } from '@keco/query';
import { query } from '@/lib/query';

/**
 * Public REST (§11): read-only, anonymous, CORS-open, IP rate-limited. A thin adapter
 * over @keco/query — REST, MCP and the portal share one implementation, so a capability
 * in one and not the others is a bug.
 */
export const runtime = 'nodejs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const csv = (key: string) => params.get(key)?.split(',').filter(Boolean) ?? [];

  // TODO(api): per-IP rate limiting before this runs (§11).
  const results = await searchTools(query, {
    q: params.get('q') ?? '',
    kind: csv('kind') as Kind[],
    domains: csv('domain') as Domain[],
    install: csv('install'),
    sort: (params.get('sort') as 'relevance' | 'stars' | 'score' | 'momentum' | 'recent') ?? 'relevance',
    page: Number(params.get('page') ?? 1),
    hitsPerPage: Math.min(50, Number(params.get('limit') ?? 20)),
  });

  return NextResponse.json(
    {
      total: results.total,
      page: results.page,
      // The public identifier is owner/repo — internal ids never leak (§11).
      results: results.hits.map((tool) => ({
        repo: tool.full_name,
        summary: tool.summary,
        kind: tool.kind,
        domains: tool.domains,
        stars: tool.stars,
        score: tool.score.total,
        install_methods: tool.install_methods,
        url: `/tools/${tool.full_name}`,
        repo_url: tool.repo_url,
        indexed_at: tool.indexed_at,
      })),
      facets: results.facets,
    },
    { headers: CORS },
  );
}
