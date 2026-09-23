// Just enough of the ZIP format to hand someone a folder of files in one
// download (routes/export.ts) — no dependency, and nothing compressed: the
// bulk of an export is photos, which are JPEG/PNG/WebP and don't shrink, and
// the Pi's one core has better things to do than try. Entries are written one
// at a time as they're added, so only one photo is ever held in memory.
//
// Limits of the plain (non-ZIP64) format: 65,535 entries and 4 GB in total.
// One member's minis are nowhere near either; going over throws rather than
// writing an archive that won't open.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// The checksum every ZIP entry carries. (Node has zlib.crc32, but only from
// 20.15/22.2 — not something to assume of the Pi.)
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UTF8_NAMES = 0x0800; // general-purpose flag bit 11: names are UTF-8
const VERSION = 20;        // 2.0 — plain stored files
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

// MS-DOS date and time, the only kind the basic format has (2-second steps).
function dosDateTime(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

interface Written {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private readonly entries: Written[] = [];
  private offset = 0;
  private finished = false;

  // `write` is where the bytes go; the next write waits for it, so a slow
  // download holds the reading of the next photo back instead of buffering it.
  constructor(private readonly write: (chunk: Buffer) => Promise<void>) {}

  async add(name: string, data: Buffer, modified: Date = new Date()): Promise<void> {
    if (this.finished) throw new Error('The archive is already finished');
    if (this.entries.length >= MAX_ENTRIES) throw new Error('Too many files for one archive');

    const nameBytes = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(modified);
    const entry: Written = { name: nameBytes, crc: crc32(data), size: data.length, offset: this.offset, time, date };
    if (entry.offset + 30 + nameBytes.length + data.length > MAX_OFFSET) throw new Error('The archive is too large');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(data.length, 18); // compressed size = size, stored as-is
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // no extra field

    await this.emit(Buffer.concat([header, nameBytes]));
    await this.emit(data);
    this.entries.push(entry);
  }

  // The central directory — the table of contents unzip tools read first.
  async finish(): Promise<void> {
    if (this.finished) throw new Error('The archive is already finished');
    this.finished = true;

    const directoryAt = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(VERSION, 4); // made by
      header.writeUInt16LE(VERSION, 6); // needed
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      // extra, comment, disk, internal and external attributes: all zero
      header.writeUInt32LE(entry.offset, 42);
      await this.emit(Buffer.concat([header, entry.name]));
    }
    const directorySize = this.offset - directoryAt;
    if (this.offset > MAX_OFFSET) throw new Error('The archive is too large');

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryAt, 16);
    await this.emit(end);
  }

  private async emit(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    await this.write(chunk);
  }
}
