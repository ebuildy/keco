import { Cache, type Storage } from '@keco/cache';
import { FALLBACK_KIND } from '@keco/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepo, type AnalyzeInput } from './analyze';
import type { LlmVerdict } from './llm';

function memoryStorage(): Storage {
  const files = new Map<string, Buffer>();
  return {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => void files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body)),
    has: async (key) => files.has(key),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key) => void files.delete(key),
  };
}

const NOW = new Date('2026-08-01T00:00:00.000Z');

const CERT_MANAGER: AnalyzeInput = {
  repo: 'cert-manager/cert-manager',
  content_hash: 'abc123',
  name: 'cert-manager',
  description: 'Automatically provision and manage TLS certificates in Kubernetes',
  topics: ['kubernetes-operator', 'security'],
  tree: ['config/crd/bases/foo.yaml', 'PROJECT', 'main.go'],
  manifests: {},
  language: 'Go',
  readme: '# cert-manager',
  derived: {
    owner: 'cert-manager',
    owner_type: 'Organization',
    license_spdx: 'Apache-2.0',
    archived: false,
    created_at: '2016-01-01T00:00:00.000Z',
    pushed_at: '2026-07-01T00:00:00.000Z',
    latest_release_at: '2026-06-01T00:00:00.000Z',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analyzeRepo', () => {
  it('settles a confident, well-topic-tagged repo with rules alone — no LLM call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const llmClient = { messages: { create: vi.fn() } };

    const analysis = await analyzeRepo(CERT_MANAGER, {
      cache,
      forceRefresh: null,
      llm: { apiKey: 'unused', model: 'unused', client: llmClient },
      now: NOW,
    });

    expect(analysis.method).toBe('rules');
    expect(analysis.kind).toBe('operator');
    expect(analysis.domains).toEqual(['security']);
    expect(analysis.runtime).toBe('in-cluster');
    expect(analysis.license_class).toBe('permissive');
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.9);
    expect(analysis.needs_review).toBe(false);
    expect(analysis.summary).toBe(CERT_MANAGER.description!.slice(0, 400));
    expect(llmClient.messages.create).not.toHaveBeenCalled();
  });

  it('picks up a CNCF Landscape hit from pass 2 and reflects it in governance and maturity', async () => {
    const landscapeYaml = `
landscape:
  - category:
      name: Certificates
      subcategories:
        - subcategory:
            name: Automation
            items:
              - item:
                  name: cert-manager
                  project: graduated
                  repo_url: https://github.com/cert-manager/cert-manager
`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('raw.githubusercontent.com'))
          return new Response(landscapeYaml, { status: 200 });
        return new Response('not found', { status: 404 });
      }),
    );
    const cache = new Cache(memoryStorage());

    const analysis = await analyzeRepo(CERT_MANAGER, {
      cache,
      forceRefresh: null,
      llm: null,
      now: NOW,
    });

    expect(analysis.maturity).toBe('cncf-graduated');
    expect(analysis.governance).toBe('foundation');
  });

  it('calls the LLM when pass 1 is ambiguous, and uses its verdict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const verdict: LlmVerdict = {
      summary: 'A mystery tool.',
      kind: 'service',
      domains: ['dev-experience'],
      confidence: 0.6,
      needs_review: true,
    };
    const llmClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: verdict }] }),
      },
    };

    const ambiguous: AnalyzeInput = {
      ...CERT_MANAGER,
      repo: 'someone/mystery',
      name: 'mystery',
      topics: [],
      tree: ['main.go'],
      description: 'does a thing',
    };

    const analysis = await analyzeRepo(ambiguous, {
      cache,
      forceRefresh: null,
      llm: { apiKey: 'unused', model: 'unused', client: llmClient },
      now: NOW,
    });

    expect(analysis.method).toBe('llm');
    expect(analysis.kind).toBe('service');
    expect(analysis.confidence).toBe(0.6);
    expect(analysis.needs_review).toBe(true);
    expect(analysis.summary).toBe(verdict.summary);
    expect(llmClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the honest low-confidence answer, with an empty summary, when the LLM fails twice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    // Neither attempt returns a `tool_use` block, so `classifyWithLlm` exhausts its one retry
    // and returns null — the caller's degrade path, not the LLM's verdict.
    const llmClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'text' }] }),
      },
    };

    const ambiguous: AnalyzeInput = {
      ...CERT_MANAGER,
      repo: 'someone/mystery',
      name: 'mystery',
      topics: [],
      tree: ['main.go'],
    };

    const analysis = await analyzeRepo(ambiguous, {
      cache,
      forceRefresh: null,
      llm: { apiKey: 'unused', model: 'unused', client: llmClient },
      now: NOW,
    });

    expect(llmClient.messages.create).toHaveBeenCalledTimes(2);
    expect(analysis.method).toBe('llm');
    expect(analysis.summary).toBe('');
    expect(analysis.kind).toBe(FALLBACK_KIND);
    expect(analysis.confidence).toBe(0.3);
    expect(analysis.needs_review).toBe(true);
  });

  it('still calls the LLM — and takes its kind and domains — when kind is confident but domains are empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const verdict: LlmVerdict = {
      summary: 'A cert-manager-shaped operator, but not for certificates.',
      kind: 'controller',
      domains: ['storage'],
      confidence: 0.8,
      needs_review: false,
    };
    const llmClient = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: verdict }] }),
      },
    };

    // Same strong structural signal as CERT_MANAGER (config/crd/ + PROJECT ⇒ operator, 0.95
    // confidence) but topics that map to no domain alias — `ruleDomains.length === 0` alone
    // must be enough to trigger pass 3, independent of how confident pass 1's kind was.
    const confidentKindNoDomains: AnalyzeInput = {
      ...CERT_MANAGER,
      repo: 'someone/confident-but-domainless',
      name: 'confident-but-domainless',
      topics: ['some-random-tag'],
    };

    const analysis = await analyzeRepo(confidentKindNoDomains, {
      cache,
      forceRefresh: null,
      llm: { apiKey: 'unused', model: 'unused', client: llmClient },
      now: NOW,
    });

    expect(llmClient.messages.create).toHaveBeenCalledTimes(1);
    expect(analysis.method).toBe('llm');
    // The LLM's verdict wins outright — not pass 1's 'operator' — because once invoked it owns
    // the whole classification package, not just the domains that triggered it.
    expect(analysis.kind).toBe('controller');
    expect(analysis.domains).toEqual(['storage']);
  });

  it('falls back to the honest low-confidence answer when no LLM is configured and pass 1 is ambiguous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());

    const ambiguous: AnalyzeInput = {
      ...CERT_MANAGER,
      repo: 'someone/mystery',
      name: 'mystery',
      topics: [],
      tree: ['main.go'],
    };

    const analysis = await analyzeRepo(ambiguous, {
      cache,
      forceRefresh: null,
      llm: null,
      now: NOW,
    });

    expect(analysis.method).toBe('rules');
    expect(analysis.domains).toEqual(['dev-experience']);
    expect(analysis.needs_review).toBe(true);
    // No LLM configured — the honest fallback still gets the description-based summary, not an
    // empty one: this branch is "we don't have prose from an LLM", not "we're unsure".
    expect(analysis.summary).toBe(ambiguous.description!.slice(0, 400));
  });

  it('always validates against AnalysisSchema before returning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());

    const analysis = await analyzeRepo(CERT_MANAGER, {
      cache,
      forceRefresh: null,
      llm: null,
      now: NOW,
    });

    // AnalysisSchema.parse already ran inside analyzeRepo; re-parsing must be a no-op.
    const { AnalysisSchema } = await import('@keco/core');
    expect(() => AnalysisSchema.parse(analysis)).not.toThrow();
  });
});
