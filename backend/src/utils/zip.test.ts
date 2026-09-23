import { describe, it, expect } from 'vitest';
import { ZipWriter, crc32 } from './zip';
import { readZip } from '../test/readZip';

async function build(files: [string, string | Buffer][]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const zip = new ZipWriter(async chunk => { chunks.push(chunk); });
  for (const [name, data] of files) await zip.add(name, Buffer.from(data));
  await zip.finish();
  return Buffer.concat(chunks);
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for nothing', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('ZipWriter', () => {
  it('writes an archive whose entries read back byte for byte', async () => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0xff, 0xd9]);

    const entries = readZip(await build([
      ['minis.csv', 'name\r\nDire Wolf\r\n'],
      ['photos/001-dire-wolf-1.jpg', photo],
    ]));

    expect(entries.map(e => e.name)).toEqual(['minis.csv', 'photos/001-dire-wolf-1.jpg']);
    expect(entries[0].data.toString()).toBe('name\r\nDire Wolf\r\n');
    expect(entries[1].data.equals(photo)).toBe(true);
    for (const entry of entries) expect(entry.crc).toBe(crc32(entry.data));
  });

  it('marks names as UTF-8, so a café or 🐉 name survives', async () => {
    const [entry] = readZip(await build([['photos/café-🐉.png', 'x']]));

    expect(entry.name).toBe('photos/café-🐉.png');
    expect(entry.flags & 0x0800).toBe(0x0800);
  });

  it('writes a valid empty archive', async () => {
    const zip = await build([]);

    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('refuses anything after finishing', async () => {
    const zip = new ZipWriter(async () => {});
    await zip.finish();

    await expect(zip.add('late.txt', Buffer.from('x'))).rejects.toThrow();
  });
});
