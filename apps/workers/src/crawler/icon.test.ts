import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { deriveIconSizes } from './icon';

/** A source image of a known size, built rather than committed — no binary fixture to review. */
const square = (size: number): Promise<Buffer> =>
  sharp({
    create: { width: size, height: size, channels: 4, background: { r: 50, g: 108, b: 229, alpha: 1 } },
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
