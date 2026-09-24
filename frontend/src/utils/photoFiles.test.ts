import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shrinkPhoto, preparePhotos, PHOTO_MAX_SIDE, KEEP_AS_IS_BYTES } from './photoFiles';
import { LIMITS } from '../limits';

// jsdom can't decode or draw an image, so these stand in for the browser: an
// <img> of a given size, and a canvas that records what it was asked to draw
// and hands back an encoded file of a given size.

let imageSize = { width: 4000, height: 3000 };
let decodeFails = false;
let encodedBytes = 400_000;
// What the browser can encode — Safari before 17 can't make WebP, and hands
// back a PNG instead when asked.
let encodes = (type: string): string => type;
let decodesInProgress = 0;
let mostDecodesAtOnce = 0;

class FakeImage {
  src = '';
  get naturalWidth(): number { return imageSize.width; }
  get naturalHeight(): number { return imageSize.height; }
  async decode(): Promise<void> {
    decodesInProgress++;
    mostDecodesAtOnce = Math.max(mostDecodesAtOnce, decodesInProgress);
    await new Promise(resolve => setTimeout(resolve, 5));
    decodesInProgress--;
    if (decodeFails) throw new Error('EncodingError');
  }
}

const drawn: { width: number; height: number }[] = [];
const encodedAs: { type: string; quality: number | undefined }[] = [];

function fakeCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (_img: unknown, _x: number, _y: number, width: number, height: number) => drawn.push({ width, height }),
    }),
    toBlob: (done: (blob: Blob | null) => void, type: string, quality?: number) => {
      encodedAs.push({ type, quality });
      done(new Blob([new Uint8Array(encodedBytes)], { type: encodes(type) }));
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

function photo(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const MB = 1024 * 1024;

beforeEach(() => {
  imageSize = { width: 4000, height: 3000 };
  decodeFails = false;
  encodedBytes = 400_000;
  encodes = type => type;
  decodesInProgress = 0;
  mostDecodesAtOnce = 0;
  drawn.length = 0;
  encodedAs.length = 0;
  vi.stubGlobal('Image', FakeImage);
  // Its presence is what says "this is a browser that can draw images".
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: () => {} })));
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    (tag === 'canvas' ? fakeCanvas() : createElement(tag))) as typeof document.createElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shrinkPhoto', () => {
  // A 12-megapixel phone photo is 3–5 MB and shown in a 180px card; thirty
  // of them was enough for mobile Safari to kill the tab.
  it('redraws a big photo with its longest side at the most the app ever shows', async () => {
    const result = await shrinkPhoto(photo('owlbear.jpg', 'image/jpeg', 4 * MB));

    expect(drawn).toEqual([{ width: PHOTO_MAX_SIDE, height: 1200 }]);
    expect(result.size).toBe(400_000);
    expect(result.type).toBe('image/jpeg');
    expect(result.name).toBe('owlbear.jpg'); // Bulk Add names minis from it
  });

  it('keeps a portrait photo upright, scaling by its height', async () => {
    imageSize = { width: 3000, height: 4000 };

    await shrinkPhoto(photo('tall.jpg', 'image/jpeg', 4 * MB));

    expect(drawn).toEqual([{ width: 1200, height: PHOTO_MAX_SIDE }]);
  });

  it('re-encodes a photo that is small on screen but heavy on disk, at its own size', async () => {
    imageSize = { width: 1200, height: 900 };

    const result = await shrinkPhoto(photo('heavy.jpg', 'image/jpeg', 3 * MB));

    expect(drawn).toEqual([{ width: 1200, height: 900 }]);
    expect(result.size).toBe(400_000);
  });

  it('leaves a photo that is already small in pixels and bytes exactly as it is', async () => {
    imageSize = { width: 1200, height: 900 };
    const original = photo('small.jpg', 'image/jpeg', KEEP_AS_IS_BYTES - 1);

    expect(await shrinkPhoto(original)).toBe(original);
    expect(drawn).toEqual([]);
  });

  // Re-encoding would keep only the first frame of an animation.
  it('leaves a GIF alone', async () => {
    const original = photo('spin.gif', 'image/gif', 4 * MB);

    expect(await shrinkPhoto(original)).toBe(original);
    expect(drawn).toEqual([]);
  });

  // A PNG may have see-through parts (a cut-out render); JPEG would paint them black.
  it('turns a big PNG into WebP, which keeps transparency', async () => {
    const result = await shrinkPhoto(photo('cutout.png', 'image/png', 6 * MB));

    expect(encodedAs[0].type).toBe('image/webp');
    expect(result.type).toBe('image/webp');
    expect(result.name).toBe('cutout.webp');
  });

  it('names the file for what the browser actually made, when it couldn\'t make WebP', async () => {
    encodes = () => 'image/png';

    const result = await shrinkPhoto(photo('cutout.png', 'image/png', 6 * MB));

    expect(result.type).toBe('image/png');
    expect(result.name).toBe('cutout.png');
  });

  it('keeps the original when the redrawn copy would be no smaller', async () => {
    encodedBytes = 5 * MB;
    const original = photo('noisy.jpg', 'image/jpeg', 4 * MB);

    expect(await shrinkPhoto(original)).toBe(original);
  });

  // Not a picture after all, or one this browser can't read — the original
  // goes on to the usual checks, which say what's wrong with it.
  it('hands back the original when it can\'t be read as an image', async () => {
    decodeFails = true;
    const original = photo('notes.jpg', 'image/jpeg', 4 * MB);

    expect(await shrinkPhoto(original)).toBe(original);
  });

  it('does nothing where images can\'t be drawn at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const original = photo('owlbear.jpg', 'image/jpeg', 4 * MB);

    expect(await shrinkPhoto(original)).toBe(original);
  });
});

describe('preparePhotos', () => {
  // The size cap is on what's uploaded: a phone photo over it is fine once
  // it's been shrunk, and shouldn't be refused for what it was before.
  it('accepts a photo over the size cap once shrinking brings it under', async () => {
    const [checked] = await preparePhotos([photo('huge.jpg', 'image/jpeg', LIMITS.photoBytes + MB)]);

    expect(checked.problem).toBeNull();
    expect(checked.file.size).toBe(400_000);
  });

  it('still refuses what shrinking can\'t help', async () => {
    const [heic, text] = await preparePhotos([
      photo('IMG_1.HEIC', 'image/heic', MB),
      photo('notes.txt', 'text/plain', 100),
    ]);

    expect(heic.problem).toMatch(/HEIC/);
    expect(text.problem).toMatch(/isn't a JPG/);
    expect(drawn).toEqual([]);
  });

  // Each full-size decode is ~48 MB of memory on a phone; a pile of thirty
  // dropped on Bulk Add all at once would be well over a gigabyte.
  it('works through a pile of photos one at a time, in order', async () => {
    const files = Array.from({ length: 5 }, (_, i) => photo(`p${i}.jpg`, 'image/jpeg', 4 * MB));

    const checked = await preparePhotos(files);

    expect(mostDecodesAtOnce).toBe(1);
    expect(checked.map(c => c.file.name)).toEqual(['p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);
  });
});
