import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { isSortKey, selectionFromParams } from '@keco/core';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import type { Retrieval } from '../ports';

/**
 * Public REST (AGENTS.md §11): read-only, anonymous, CORS-open, IP rate-limited. A thin
 * adapter over @keco/query — REST, MCP and the portal share one retrieval implementation, so
 * a capability in one and not the others is a bug.
 *
 * CORS and the rate limiter are registered inside this plugin, not globally: /api/commands/*
 * must have neither (§12).
 */
// Mirrors `pagination.maxTotalHits` in packages/search/src/settings.ts (§5). Meilisearch
// rejects a page past this bound, so deep paging is capped here before the request goes out.
const MAX_TOTAL_HITS = 10_000;

export const v1Routes: FastifyPluginAsync<{ retrieval: Retrieval }> = async (app, options) => {
  const { retrieval } = options;

  await app.register(cors, { origin: '*', methods: ['GET', 'OPTIONS'] });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  /**
   * Meilisearch being down is a dependency failure, not a caller error: 503, and the reason
   * goes to the log rather than to the response. An internal host and a stack trace are
   * operational detail. Scoped to this plugin, so it cannot swallow errors from the admin or
   * command routes.
   *
   * `reply.statusCode` is deliberately never read here: Fastify has not yet copied
   * `error.statusCode` onto the reply when a plugin-scoped error handler runs, so it still
   * reads 200 for every error, including @fastify/rate-limit's 429 — reading it made every
   * 4xx (the rate limiter this task added among them) fall through to the 503 branch below.
   * The error object carries the real status; read that instead.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code = status === 429 ? 'rate_limited' : (error.code ?? 'bad_request');
      return reply.code(status).send({ error: code, message: error.message });
    }
    request.log.error({ err: error }, 'read model unavailable');
    return reply.code(503).send({ error: 'search_unavailable' });
  });

  app.get('/search', async (request) => {
    const params = new URLSearchParams(
      request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '',
    );

    const sort = params.get('sort') ?? '';
    const hitsPerPage = Math.min(50, Math.max(1, Math.floor(Number(params.get('limit') ?? 20)) || 20));
    // The max page for this page size, so `?page=` cannot ask past maxTotalHits regardless
    // of hitsPerPage.
    const maxPage = Math.max(1, Math.floor(MAX_TOTAL_HITS / hitsPerPage));
    const page = Math.min(maxPage, Math.max(1, Math.floor(Number(params.get('page') ?? 1)) || 1));

    const results = await retrieval.searchTools({
      q: params.get('q') ?? '',
      filters: selectionFromParams(params),
      // Narrowed, not cast: a hand-edited ?sort= must never reach Meilisearch verbatim.
      sort: isSortKey(sort) ? sort : 'relevance',
      page,
      hitsPerPage,
    });

    return {
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
        // Eventual consistency is the contract; freshness is shown, never hidden (§2.7).
        indexed_at: tool.indexed_at,
      })),
      facets: results.facets,
    };
  });

  app.get<{ Params: { owner: string; repo: string } }>('/tools/:owner/:repo', async (request, reply) => {
    const { owner, repo } = request.params;
    const tool = await retrieval.getTool(`${owner}/${repo}`);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    return tool;
  });
};
