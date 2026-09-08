import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A test about a package.json string, which looks absurd until you read
 * `src/lib/shutdown.ts:28-33`.
 *
 * The `tsx` CLI is a supervisor: it spawns the real process as a child and tears it down about
 * 110ms after a group signal, far short of the ~500ms a 50k-repo discovery flush takes (~950ms
 * at 100k). Under it, no shutdown handler can win and Ctrl-C silently discards the entire
 * sweep — the corpus batch buffered since the last flush, and the run record. As a *loader*
 * (`node --import tsx`) there is one process and the signal reaches the handler directly.
 *
 * When seven scripts became one, this stopped being discovery's private concern and became the
 * property of every command. Nothing else would catch a regression: it produces no error, no
 * failing test and no log line — just a sweep that quietly stops persisting.
 */
describe('the kecoctl npm script', () => {
  it('runs tsx as a loader, never as the supervising CLI', async () => {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.kecoctl).toBe('node --import tsx src/cli.ts');
  });

  it('has no leftover per-worker scripts', async () => {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(Object.keys(manifest.scripts).sort()).toEqual(['check', 'kecoctl']);
  });
});
