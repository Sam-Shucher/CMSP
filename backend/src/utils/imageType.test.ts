import { describe, it, expect } from 'vitest';
import { detectImageType } from './imageType';

const bytes = (...parts: Array<number[] | string>) =>
  Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

describe('detectImageType — what a file really is, whatever it claims', () => {
  it.each([
    ['a JPEG', bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), '.jpg'],
    ['a PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), '.png'],
    ['a GIF (89a)', bytes('GIF89a', [1, 0, 1, 0]), '.gif'],
    ['a GIF (87a)', bytes('GIF87a', [1, 0, 1, 0]), '.gif'],
    ['a WebP', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '), '.webp'],
  ])('recognizes %s', (_what, head, ext) => {
    expect(detectImageType(head)).toBe(ext);
  });

  it.each([
    ['a text file renamed .png', bytes('this is my shopping list')],
    ['HTML renamed .jpg', bytes('<html><script>alert(1)</script>')],
    ['an empty file', Buffer.alloc(0)],
    ['an iPhone HEIC photo', bytes([0, 0, 0, 0x18], 'ftypheic')],
    ['an SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['a RIFF file that isn\'t WebP (a WAV)', bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ')],
    ['only the start of a PNG signature', bytes([0x89, 0x50, 0x4e])],
  ])('rejects %s', (_what, head) => {
    expect(detectImageType(head)).toBeNull();
  });
});
