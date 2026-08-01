import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStorage } from './adapters/fs';
import { Journal } from './journal';
import { Cache } from './storage';
import { contentHash } from './index';

describe('Journal', () => {
  let dir: string;
  let journal: Journal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keco-journal-'));
    journal = new Journal(new Cache(new FsStorage(dir)));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const collect = async (afterId?: string | null) => {
    const events = [];
    for await (const event of journal.read({ afterId })) events.push(event);
    return events;
  };

  it('replays every event for a consumer with no checkpoint', async () => {
    await journal.append({ type: 'RepoDiscovered', repo: 'ahmetb/kubectx', source: 'krew' });
    await journal.append({
      type: 'RepoFetched',
      repo: 'ahmetb/kubectx',
      content_hash: 'abc',
      changed: true,
    });

    const events = await collect();
    expect(events.map((e) => e.type)).toEqual(['RepoDiscovered', 'RepoFetched']);
  });

  it('resumes strictly after a checkpoint', async () => {
    const first = await journal.append({
      type: 'RepoDiscovered',
      repo: 'derailed/k9s',
      source: 'cncf',
    });
    await journal.append({ type: 'RepoSkipped', repo: 'some/fork', reason: 'fork' });

    await journal.advance('analyzer', first.id);
    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).toBe(first.id);

    const events = await collect(checkpoint.last_event_id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('RepoSkipped');
  });

  it('reset makes a consumer replay from the beginning', async () => {
    const event = await journal.append({ type: 'RepoDiscovered', repo: 'a/b', source: 'seed' });
    await journal.advance('projector', event.id);
    await journal.reset('projector');

    const checkpoint = await journal.checkpoint('projector');
    expect(checkpoint.last_event_id).toBeNull();
    expect(await collect(checkpoint.last_event_id)).toHaveLength(1);
  });
});

describe('contentHash', () => {
  const repo = { description: 'kubectx', topics: ['kubernetes'], default_branch: 'main' };

  it('ignores star churn — only what changes what we say about a repo', () => {
    const a = contentHash({ repo, readme: '# kubectx', treePaths: ['README.md'] });
    const b = contentHash({ repo, readme: '# kubectx', treePaths: ['README.md'] });
    expect(a).toBe(b);
  });

  it('changes when the tree changes', () => {
    const before = contentHash({ repo, readme: '# k', treePaths: ['README.md'] });
    const after = contentHash({ repo, readme: '# k', treePaths: ['README.md', 'Chart.yaml'] });
    expect(after).not.toBe(before);
  });

  it('is order-independent for topics and tree paths', () => {
    const a = contentHash({ repo: { ...repo, topics: ['a', 'b'] }, readme: null, treePaths: ['x', 'y'] });
    const b = contentHash({ repo: { ...repo, topics: ['b', 'a'] }, readme: null, treePaths: ['y', 'x'] });
    expect(a).toBe(b);
  });
});
