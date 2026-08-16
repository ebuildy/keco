import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, FsStorage, discoveryKeys, legacyDiscoveryStateKey } from '@keco/cache';
import type { SearchItem } from '@keco/github';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryStore, toDetail } from './store';

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    id: 20038725,
    full_name: 'ahmetb/kubectx',
    name: 'kubectx',
    owner: { login: 'ahmetb' },
    description: 'Faster way to switch between clusters',
    homepage: 'https://kubectx.dev',
    stargazers_count: 18234,
    forks_count: 1180,
    open_issues_count: 41,
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
    topics: ['kubectl', 'kubernetes'],
    archived: false,
    fork: false,
    default_branch: 'master',
    created_at: '2014-05-22T12:00:00Z',
    updated_at: '2026-07-20T08:11:00Z',
    pushed_at: '2026-07-14T19:02:00Z',
    ...overrides,
  }) as SearchItem;

describe('toDetail', () => {
  it('flattens the search item into the documented shape', () => {
    const doc = toDetail(item(), 'kubernetes stars:>5000', '2026-08-02T09:30:00Z');

    expect(doc.owner).toBe('ahmetb');
    expect(doc.stars).toBe(18234);
    expect(doc.license).toBe('Apache-2.0');
    expect(doc.discovered_via).toBe('kubernetes stars:>5000');
    expect(doc.discovered_at).toBe('2026-08-02T09:30:00Z');
    expect(doc.payload_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('excludes discovered_at from the hash, or every file would look changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'q', '2026-09-14T22:00:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('changes the hash when the repo really changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item({ stargazers_count: 18999 }), 'q', '2026-08-02T09:30:00Z');
    expect(a.payload_hash).not.toBe(b.payload_hash);
  });

  it('excludes discovered_via from the hash, so a re-sighting is not a rewrite', () => {
    // A window over 1000 contributes its probe items under the parent's query and then
    // subdivides, so a child re-sees them under a different query. With `via` hashed, a resume
    // rewrote every one of those documents. The stored value stays the first sighting's.
    const a = toDetail(item(), 'kubernetes stars:>5000', 'now');
    const b = toDetail(item(), 'kubernetes stars:>5000 created:2020-01-01..2020-12-31', 'now');
    expect(a.payload_hash).toBe(b.payload_hash);
    expect(a.discovered_via).toBe('kubernetes stars:>5000');
  });

  it('sorts topics so their order cannot churn the hash', () => {
    const a = toDetail(item({ topics: ['a', 'b'] }), 'q', 'now');
    const b = toDetail(item({ topics: ['b', 'a'] }), 'q', 'now');
    expect(a.payload_hash).toBe(b.payload_hash);
  });
});

describe('DiscoveryStore', () => {
  // Every key below is namespaced by query; `keys` is this suite's "kubernetes" namespace.
  const keys = discoveryKeys('kubernetes');
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keco-discovery-'));
    cache = new Cache(new FsStorage(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a detail document at its bucket path and reports it as new', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');

    expect(await store.record(item(), 'kubernetes stars:>5000')).toBe('new');

    const raw = await cache.getText(keys.detail('ahmetb/kubectx'));
    expect(raw).not.toBeNull();
    expect(parse(raw!).full_name).toBe('ahmetb/kubectx');
  });

  it('skips the write when the payload is unchanged', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item(), 'q')).toBe('unchanged');
  });

  it('rewrites when the payload changed', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item({ stargazers_count: 19000 }), 'q')).toBe('changed');

    const raw = await cache.getText(keys.detail('ahmetb/kubectx'));
    expect(parse(raw!).stars).toBe(19000);
  });

  it('writes the full list as id, path and name only, sorted by path', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item({ id: 2, full_name: 'zz/last', name: 'last' }), 'q');
    await store.record(item({ id: 1, full_name: 'aa/first', name: 'first' }), 'q');
    await store.flush();

    const list = parse((await cache.getText(keys.fullList))!);
    expect(list).toEqual([
      { id: 1, path: 'aa/first', name: 'first' },
      { id: 2, path: 'zz/last', name: 'last' },
    ]);
  });

  it('deduplicates by repo id across windows, keeping the first sighting', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');

    expect(await store.record(item(), 'window-a')).toBe('new');
    // The same repo turning up in an overlapping window must not rewrite the document just
    // because discovered_via would differ — that would be a wasted write per duplicate.
    expect(await store.record(item(), 'window-b')).toBe('unchanged');
    await store.flush();

    expect(store.size).toBe(1);
    expect(parse((await cache.getText(keys.fullList))!)).toHaveLength(1);

    const raw = await cache.getText(keys.detail('ahmetb/kubectx'));
    expect(parse(raw!).discovered_via).toBe('window-a');
  });

  it('resumes the pending queue and completed windows', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    store.state.pending_windows = [{ base: 'kubernetes', stars: '0', created: null }];
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(resumed.state.pending_windows).toHaveLength(1);
    expect(resumed.state.completed_windows).toEqual(['kubernetes stars:>5000']);
  });

  it('lets two queries share one cache without either corpus touching the other', async () => {
    // Before per-query namespacing this was the hazard the store had to *guard* against by
    // throwing: every query wrote the same three keys, so sweeping "istio" over a "kubernetes"
    // cache merged the two corpora. The paths no longer overlap, so both sweeps just work.
    const istioKeys = discoveryKeys('istio');

    const k8s = await DiscoveryStore.open(cache, 'kubernetes');
    k8s.state.completed_windows = ['kubernetes stars:>5000'];
    await k8s.record(item(), 'kubernetes stars:>5000');
    await k8s.flush();

    const istio = await DiscoveryStore.open(cache, 'istio');
    expect(istio.size).toBe(0);
    expect(istio.state.query).toBe('istio');
    expect(istio.state.completed_windows).toEqual([]);
    istio.state.completed_windows = ['istio stars:>5000'];
    await istio.record(item({ id: 99, full_name: 'istio/istio', name: 'istio' }), 'istio');
    await istio.flush();

    // Each query has its own full list, hash index and state.
    expect(parse((await cache.getText(keys.fullList))!)).toEqual([
      { id: 20038725, path: 'ahmetb/kubectx', name: 'kubectx' },
    ]);
    expect(parse((await cache.getText(istioKeys.fullList))!)).toEqual([
      { id: 99, path: 'istio/istio', name: 'istio' },
    ]);
    expect(Object.keys(JSON.parse((await cache.getText(keys.hashes))!))).toEqual([
      'ahmetb/kubectx',
    ]);
    expect(Object.keys(JSON.parse((await cache.getText(istioKeys.hashes))!))).toEqual([
      'istio/istio',
    ]);
    expect(await cache.getText(keys.detail('ahmetb/kubectx'))).not.toBeNull();
    expect(await cache.getText(istioKeys.detail('ahmetb/kubectx'))).toBeNull();

    // And the kubernetes sweep still resumes exactly where it left off.
    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(resumed.size).toBe(1);
    expect(resumed.state.query).toBe('kubernetes');
    expect(resumed.state.completed_windows).toEqual(['kubernetes stars:>5000']);
    expect(await resumed.record(item(), 'kubernetes stars:>5000')).toBe('unchanged');
  });

  it('scopes --fresh to the query being swept, leaving other corpora alone', async () => {
    const istioKeys = discoveryKeys('istio');

    const k8s = await DiscoveryStore.open(cache, 'kubernetes');
    await k8s.record(item(), 'q');
    await k8s.flush();
    const istio = await DiscoveryStore.open(cache, 'istio');
    await istio.record(item({ id: 99, full_name: 'istio/istio', name: 'istio' }), 'q');
    await istio.flush();

    const refreshed = await DiscoveryStore.open(cache, 'istio', { fresh: true });
    expect(refreshed.size).toBe(0);
    await refreshed.flush();

    expect(parse((await cache.getText(istioKeys.fullList))!)).toEqual([]);
    expect(parse((await cache.getText(keys.fullList))!)).toHaveLength(1);
    const untouched = await DiscoveryStore.open(cache, 'kubernetes');
    expect(untouched.size).toBe(1);
  });

  it('refuses a query that has no cache namespace, before doing any I/O', async () => {
    await expect(DiscoveryStore.open(cache, '   ')).rejects.toThrow(/alphanumeric/);
  });

  it('warns about a cache written before per-query namespacing', async () => {
    // Those files are unreachable now: the sweep would report an empty corpus and silently
    // re-run for hours. They are never read, moved or deleted — just named, once, on stderr.
    await cache.putJSON(legacyDiscoveryStateKey, { query: 'kubernetes' });

    const logger = { warn: vi.fn() };
    const store = await DiscoveryStore.open(cache, 'kubernetes', { logger });

    expect(store.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: legacyDiscoveryStateKey }),
      expect.stringContaining('per-query'),
    );
  });

  it('says nothing about a legacy cache when there is none', async () => {
    const logger = { warn: vi.fn() };
    await DiscoveryStore.open(cache, 'kubernetes', { logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('starts over when opened fresh', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.flush();

    const fresh = await DiscoveryStore.open(cache, 'kubernetes', { fresh: true });
    expect(fresh.size).toBe(0);
    expect(fresh.state.completed_windows).toEqual([]);
  });

  it('rewrites a detail document whose entry is missing from the list', async () => {
    // Guards a torn flush: hashes landed, the list did not.
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();
    await cache.putText(keys.fullList, '[]');

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item(), 'q')).toBe('new');
    expect(resumed.size).toBe(1);
  });

  describe('degrade-on-load', () => {
    it('starts a fresh sweep and warns when the state file is truncated JSON', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.record(item(), 'q');
      store.state.completed_windows = ['kubernetes stars:>5000'];
      await store.flush();

      const raw = (await cache.getText(keys.state))!;
      await cache.putText(keys.state, raw.slice(0, Math.floor(raw.length * 0.6)));

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });

      expect(resumed.state.completed_windows).toEqual([]);
      // The corpus isn't trusted either — list.yaml/hashes.json carry no query of their own,
      // and with state unreadable there is nothing to confirm they belong to "kubernetes".
      expect(resumed.size).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: keys.state }),
        expect.stringContaining('fresh sweep'),
      );
    });

    it('starts a fresh sweep when the state file fails schema validation (missing pending_windows)', async () => {
      await cache.putJSON(keys.state, { query: 'kubernetes', started_at: 'now' });

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });

      expect(resumed.state.pending_windows).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('starts a fresh sweep rather than crashing on a pending window with the wrong field types', async () => {
      // { base: 'k', stars: null } used to reach queryOf()/split() unvalidated and throw —
      // before this file's try/catch even runs, per the review that flagged this.
      await cache.putJSON(keys.state, {
        query: 'kubernetes',
        started_at: 'now',
        pending_windows: [{ base: 'k', stars: null, created: null }],
        completed_windows: [],
        failed_windows: [],
        repos_seen: 0,
        pages_fetched: 0,
      });

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });

      expect(resumed.state.pending_windows).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('starts a fresh sweep rather than silently rendering `created:undefined` for an unknown Created kind', async () => {
      await cache.putJSON(keys.state, {
        query: 'kubernetes',
        started_at: 'now',
        pending_windows: [{ base: 'k', stars: '0', created: { kind: 'bogus' } }],
        completed_windows: [],
        failed_windows: [],
        repos_seen: 0,
        pages_fetched: 0,
      });

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });

      expect(resumed.state.pending_windows).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('treats a corrupt hash index as empty rather than crashing, when state and list are fine', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.record(item(), 'q');
      await store.flush();

      const raw = (await cache.getText(keys.hashes))!;
      await cache.putText(keys.hashes, raw.slice(0, Math.floor(raw.length * 0.6)));

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });

      expect(resumed.size).toBe(1); // list.yaml still loaded fine
      expect(await resumed.record(item(), 'q')).toBe('changed'); // known, but hash is gone
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: keys.hashes }),
        expect.any(String),
      );
    });

    it('drops a malformed row from the full list rather than round-tripping it back to disk', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.record(item(), 'q');
      await store.flush();

      // Simulates a torn write leaving a row without `path` — this used to throw inside
      // flush()'s sort once it made it back onto disk.
      await cache.putText(
        keys.fullList,
        stringify([
          { id: 1, path: 'ahmetb/kubectx', name: 'kubectx' },
          { id: 2, name: 'incomplete' },
        ]),
      );

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });
      expect(resumed.size).toBe(1);

      await resumed.flush();
      expect(parse((await cache.getText(keys.fullList))!)).toEqual([
        { id: 1, path: 'ahmetb/kubectx', name: 'kubectx' },
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ dropped: 1 }),
        expect.any(String),
      );
    });

    it('drops non-object rows without crashing (the corpus index reduced to one garbage string)', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.flush();
      await cache.putText(keys.fullList, stringify(['i']));

      const logger = { warn: vi.fn() };
      const resumed = await DiscoveryStore.open(cache, 'kubernetes', { logger });
      expect(resumed.size).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('flush cadence', () => {
    const at = (iso: string) => new Date(iso);

    it('does not flush before 25 windows or 30s have passed', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes', { now: at('2026-08-02T00:00:00Z') });
      await store.record(item(), 'q');

      for (let i = 0; i < 24; i += 1) {
        expect(await store.windowCompleted(at('2026-08-02T00:00:05Z'))).toBe(false);
      }
      expect(await cache.getText(keys.fullList)).toBeNull();
    });

    it('flushes on the 25th completed window', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes', { now: at('2026-08-02T00:00:00Z') });
      await store.record(item(), 'q');

      let flushed = false;
      for (let i = 0; i < 25; i += 1) {
        flushed = await store.windowCompleted(at('2026-08-02T00:00:05Z'));
      }
      expect(flushed).toBe(true);
      expect(await cache.getText(keys.fullList)).not.toBeNull();
    });

    it('flushes once 30 seconds have passed, even with only one window done', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes', { now: at('2026-08-02T00:00:00Z') });
      await store.record(item(), 'q');

      expect(await store.windowCompleted(at('2026-08-02T00:00:31Z'))).toBe(true);
      expect(await cache.getText(keys.fullList)).not.toBeNull();
    });

    it('resets the window count after a flush, so the next 25 start counting from zero', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes', { now: at('2026-08-02T00:00:00Z') });
      await store.record(item(), 'q');
      await store.flush(at('2026-08-02T00:00:00Z'));

      for (let i = 0; i < 24; i += 1) {
        expect(await store.windowCompleted(at('2026-08-02T00:00:05Z'))).toBe(false);
      }
    });

    it('flush() always writes, regardless of cadence', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.record(item(), 'q');
      await store.flush();
      expect(await cache.getText(keys.fullList)).not.toBeNull();
    });
  });

  describe('flush crash-safety', () => {
    it('writes the full list, then the hash index, then the state file, in that order', async () => {
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.record(item(), 'q');

      const putText = vi.spyOn(cache, 'putText');
      const putJSON = vi.spyOn(cache, 'putJSON');

      await store.flush();

      const calls = [
        ...putText.mock.calls.map((args, i) => ({
          key: args[0] as string,
          order: putText.mock.invocationCallOrder[i]!,
        })),
        ...putJSON.mock.calls.map((args, i) => ({
          key: args[0] as string,
          order: putJSON.mock.invocationCallOrder[i]!,
        })),
      ].sort((a, b) => a.order - b.order);

      expect(calls.map((c) => c.key)).toEqual([keys.fullList, keys.hashes, keys.state]);

      putText.mockRestore();
      putJSON.mockRestore();
    });

    it('a flush killed right after the list write still recovers every repo on the next sweep', async () => {
      // First flush lands completely: repo A is fully durable everywhere.
      const store = await DiscoveryStore.open(cache, 'kubernetes');
      await store.record(item({ id: 1, full_name: 'a/a', name: 'a' }), 'q');
      await store.flush();

      // Second flush: repo B is recorded (its detail file is durable — see the "missing
      // from list" test above), but the shared-artifact flush is killed right after the
      // list write lands — hashes.json and _state.json stay at their first-flush values.
      await store.record(item({ id: 2, full_name: 'b/b', name: 'b' }), 'q');
      const putJSON = vi.spyOn(cache, 'putJSON').mockImplementationOnce(() => {
        throw new Error('simulated kill mid-flush');
      });
      await expect(store.flush()).rejects.toThrow('simulated kill mid-flush');
      putJSON.mockRestore();

      // list.yaml already has both repos — that put ran, for real, before the mocked failure.
      expect(parse((await cache.getText(keys.fullList))!)).toHaveLength(2);

      // The orchestrator's window retry re-records the same item on resume; nothing must be
      // lost, and the store must correctly see it needs rewriting since its hash never landed.
      const resumed = await DiscoveryStore.open(cache, 'kubernetes');
      expect(resumed.size).toBe(2);
      expect(await resumed.record(item({ id: 2, full_name: 'b/b', name: 'b' }), 'q')).toBe(
        'changed',
      );
      await resumed.flush();

      const finalList = parse((await cache.getText(keys.fullList))!) as {
        path: string;
      }[];
      expect(finalList.map((e) => e.path).sort()).toEqual(['a/a', 'b/b']);
    });
  });
});
