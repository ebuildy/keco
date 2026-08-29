import { describe, expect, it } from 'vitest';
import { ToolDocument } from '@keco/core';
import { MOCK_SENTINEL, parseCorpus } from './corpus';
import { assertSeedTarget, chunk, seedDocuments } from './seed';

const document = (overrides: Record<string, unknown> = {}) => ({
  id: 'mockcorp__thing',
  owner: 'mockcorp',
  name: 'thing',
  full_name: 'mockcorp/thing',
  description: null,
  homepage: null,
  repo_url: 'https://github.com/mockcorp/thing',
  stars: 1,
  forks: 0,
  open_issues: 0,
  language: null,
  license: null,
  github_topics: [],
  archived: false,
  pushed_at: '2026-08-01T00:00:00.000Z',
  created_at: '2019-03-01T00:00:00.000Z',
  discovery_source: MOCK_SENTINEL,
  summary: 'a mock',
  kind: 'service',
  domains: ['dev-experience'],
  runtime: 'in-cluster',
  license_class: 'permissive',
  openness: 'fully-open',
  maturity: 'established',
  governance: 'community',
  k8s_relevance: 0.9,
  confidence: 0.85,
  needs_review: false,
  install_methods: [],
  score: { popularity: 0.5, activity: 0.5, adoption: 0.5, quality: 0.5, quality_coverage: 0.5, total: 0.5, momentum: 0.5 },
  signals: { scorecard: null, osv: null, dependents: null },
  has_scorecard: false,
  has_release: true,
  readme_excerpt: '# thing',
  icon: null,
  analysis_method: 'rules',
  analysis_model: null,
  content_hash: 'mock-thing',
  signals_used: [],
  indexed_at: '2026-08-23T00:00:00.000Z',
  ...overrides,
});

/** The same fixture, parsed — `document()` stays raw so the rejection cases can be malformed. */
const valid = (overrides: Record<string, unknown> = {}) => ToolDocument.parse(document(overrides));

describe('parseCorpus', () => {
  it('parses a well-formed corpus', () => {
    const documents = parseCorpus(JSON.stringify([document()]));
    expect(documents).toHaveLength(1);
    expect(documents[0]?.full_name).toBe('mockcorp/thing');
  });

  it('rejects a document that is not a valid ToolDocument', () => {
    expect(() => parseCorpus(JSON.stringify([{ id: 'x' }]))).toThrow(/not a valid ToolDocument/);
  });

  it('rejects a taxonomy value the vocabulary does not declare', () => {
    expect(() => parseCorpus(JSON.stringify([document({ governance: 'vendor_backed' })]))).toThrow(
      /not a valid ToolDocument/,
    );
  });

  // The guard that keeps this seeder from ever being repurposed to push real documents: the
  // projector is the only writer to the real corpus (§4.4), and this one only writes fixtures.
  it('refuses a corpus whose documents do not carry the mock sentinel', () => {
    expect(() => parseCorpus(JSON.stringify([document({ discovery_source: 'cncf-landscape' })]))).toThrow(
      /mock sentinel/,
    );
  });

  it('refuses anything that is not an array of documents', () => {
    expect(() => parseCorpus('{"documents":[]}')).toThrow(/array/);
  });
});

describe('assertSeedTarget', () => {
  it.each(['http://localhost:7700', 'http://127.0.0.1:7700', 'http://[::1]:7700', 'http://0.0.0.0:7700'])(
    'allows %s without a flag',
    (host) => {
      expect(() => assertSeedTarget(host, false)).not.toThrow();
    },
  );

  it('refuses a remote host', () => {
    expect(() => assertSeedTarget('https://search.keco.dev', false)).toThrow(/--force/);
  });

  it('allows a remote host only when forced', () => {
    expect(() => assertSeedTarget('https://search.keco.dev', true)).not.toThrow();
  });

  it('refuses a host it cannot parse rather than assuming it is local', () => {
    expect(() => assertSeedTarget('not a url', false)).toThrow();
  });
});

describe('chunk', () => {
  it('splits into batches of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('rejects a non-positive batch size instead of looping forever', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('seedDocuments', () => {
  it('submits every document, in batches, and reports the total', async () => {
    const submitted: number[][] = [];
    const documents = Array.from({ length: 5 }, (_, index) => valid({ id: `d${index}` }));

    const total = await seedDocuments(documents, {
      batchSize: 2,
      submit: async (batch) => void submitted.push(batch.map((d) => Number(d.id.slice(1)))),
    });

    expect(total).toBe(5);
    expect(submitted).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('reports progress per batch', async () => {
    const seen: { batch: number; sent: number }[] = [];
    await seedDocuments(Array.from({ length: 3 }, () => valid()), {
      batchSize: 2,
      submit: async () => {},
      onBatch: (batch, sent) => void seen.push({ batch, sent }),
    });

    expect(seen).toEqual([
      { batch: 1, sent: 2 },
      { batch: 2, sent: 3 },
    ]);
  });

  // Writes are asynchronous (§5, §14): a failed task must stop the run loudly, not be counted.
  it('propagates a failed submission', async () => {
    await expect(
      seedDocuments([valid()], {
        batchSize: 1,
        submit: async () => {
          throw new Error('meilisearch task 7 failed');
        },
      }),
    ).rejects.toThrow(/task 7 failed/);
  });
});
