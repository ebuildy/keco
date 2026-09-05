import { Cache, type Storage } from '@keco/cache';
import { repoKeys } from '@keco/cache/keys';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { deriveIconSizes, updateIcon, type IconMeta } from './icon';

/** A source image of a known size, built rather than committed — no binary fixture to review. */
const square = (size: number): Promise<Buffer> =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 50, g: 108, b: 229, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

const wide = (): Promise<Buffer> =>
  sharp({
    create: { width: 400, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

describe('deriveIconSizes', () => {
  it('emits one PNG per declared size', async () => {
    const derived = await deriveIconSizes(await square(460));
    expect([...derived.keys()]).toEqual([32, 64, 160]);
    for (const buffer of derived.values()) {
      expect((await sharp(buffer).metadata()).format).toBe('png');
    }
  });

  it('fits each one inside its box', async () => {
    const derived = await deriveIconSizes(await square(460));
    const metadata = await sharp(derived.get(64)!).metadata();
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(64);
  });

  // Aspect ratio is preserved rather than padded to a square: plenty of project marks are
  // wordmarks, and the portal boxes them with `object-contain`.
  it('keeps a wide wordmark wide', async () => {
    const derived = await deriveIconSizes(await wide());
    const metadata = await sharp(derived.get(160)!).metadata();
    expect(metadata.width).toBe(160);
    expect(metadata.height).toBe(40);
  });

  it('rasterises SVG, which is what makes an untrusted logo safe to serve', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
        '<script>alert(1)</script><rect width="200" height="200" fill="#326ce5"/></svg>',
    );
    const derived = await deriveIconSizes(svg);
    const png = derived.get(160)!;
    expect((await sharp(png).metadata()).format).toBe('png');
    expect(png.includes(Buffer.from('script'))).toBe(false);
  });

  it('preserves transparency rather than flattening it onto white', async () => {
    const derived = await deriveIconSizes(await wide());
    expect((await sharp(derived.get(32)!).metadata()).hasAlpha).toBe(true);
  });

  it('throws on something that is not an image at all', async () => {
    await expect(deriveIconSizes(Buffer.from('not an image'))).rejects.toThrow();
  });
});

/** An in-memory Storage, so no test touches a `.cache` directory. */
function memoryStorage(): Storage & { keys(): string[] } {
  const files = new Map<string, Buffer>();
  return {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => {
      files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
    has: async (key) => files.has(key),
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)).sort(),
    delete: async (key) => {
      files.delete(key);
    },
    keys: () => [...files.keys()].sort(),
  };
}

const NOW = new Date('2026-08-24T12:00:00.000Z');
const KEYS = repoKeys('acme/widget');

const inputsFor = (over: Partial<Parameters<typeof updateIcon>[1]> = {}) => ({
  repo: 'acme/widget',
  defaultBranch: 'main',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42',
  treePaths: ['logo.png'],
  readme: '',
  ...over,
});

const okResponse = (body: Buffer, contentType = 'image/png', etag = '"v1"') =>
  new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': contentType, etag },
  });

describe('updateIcon', () => {
  it('stores the fetched bytes verbatim and writes all three derivatives', async () => {
    const storage = memoryStorage();
    const source = await square(460);
    const meta = await updateIcon(new Cache(storage), inputsFor(), {
      fetch: async () => okResponse(source),
      now: () => NOW,
    });

    expect(await storage.get(KEYS.iconSource)).toEqual(source);
    expect(storage.keys()).toContain(KEYS.icon(32));
    expect(storage.keys()).toContain(KEYS.icon(160));
    expect(meta).toMatchObject({
      source: 'repo-logo',
      source_url: 'https://raw.githubusercontent.com/acme/widget/main/logo.png',
      content_type: 'image/png',
      bytes: source.byteLength,
      etag: '"v1"',
      sizes: [32, 64, 160],
      fetched_at: NOW.toISOString(),
      error: null,
    });
  });

  it('records the metadata in the cache, so the next run can be conditional', async () => {
    const storage = memoryStorage();
    const cache = new Cache(storage);
    await updateIcon(cache, inputsFor(), {
      fetch: async () => okResponse(await square(200)),
      now: () => NOW,
    });
    expect(await cache.getJSON<IconMeta>(KEYS.iconMeta)).toMatchObject({ etag: '"v1"' });
  });

  it('sends If-None-Match and short-circuits on 304 without re-deriving', async () => {
    const storage = memoryStorage();
    const cache = new Cache(storage);
    await updateIcon(cache, inputsFor(), {
      fetch: async () => okResponse(await square(200)),
      now: () => NOW,
    });
    const before = await storage.get(KEYS.icon(64));

    let sentHeader: string | null = null;
    const meta = await updateIcon(cache, inputsFor(), {
      fetch: async (_url, init) => {
        sentHeader = new Headers(init?.headers).get('if-none-match');
        return new Response(null, { status: 304 });
      },
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });

    expect(sentHeader).toBe('"v1"');
    expect(meta.source).toBe('repo-logo');
    expect(await storage.get(KEYS.icon(64))).toEqual(before);
  });

  it('abandons a body over the 512 KB cap rather than truncating it', async () => {
    const storage = memoryStorage();
    const huge = Buffer.alloc(600 * 1024, 1);
    const meta = await updateIcon(new Cache(storage), inputsFor(), {
      fetch: async () => okResponse(huge, 'image/png'),
      now: () => NOW,
    });

    expect(meta.source).toBeNull();
    expect(meta.error).toMatch(/too large/i);
    expect(storage.keys()).not.toContain(KEYS.iconSource);
  });

  it('refuses a non-image content type', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => okResponse(Buffer.from('<html>'), 'text/html'),
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toMatch(/content type/i);
  });

  // Degrade, never fail (§4.2). A dead CDN must not stall a crawl.
  it('records a failed fetch instead of throwing', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toContain('ECONNRESET');
  });

  it('records a 404 without retrying it forever', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => new Response(null, { status: 404 }),
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toContain('404');
  });

  // A transient blip must not blank an icon whose bytes are still sitting in the cache.
  it('keeps a previously good icon when a later run fails', async () => {
    const cache = new Cache(memoryStorage());
    await updateIcon(cache, inputsFor(), {
      fetch: async () => okResponse(await square(200)),
      now: () => NOW,
    });

    const meta = await updateIcon(cache, inputsFor(), {
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });

    expect(meta.source).toBe('repo-logo');
    expect(meta.sizes).toEqual([32, 64, 160]);
    expect(meta.error).toContain('500');
  });

  it('records that there was nothing to fetch when no tier matched', async () => {
    const meta = await updateIcon(
      new Cache(memoryStorage()),
      inputsFor({ treePaths: [], avatarUrl: null }),
      {
        fetch: async () => {
          throw new Error('must not be called');
        },
        now: () => NOW,
      },
    );
    expect(meta.source).toBeNull();
    expect(meta.error).toMatch(/no candidate/i);
  });

  it('records a source that is not decodable as an image', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => okResponse(Buffer.from('nope'), 'image/png'),
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toBeTruthy();
  });
});
