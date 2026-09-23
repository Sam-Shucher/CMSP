import { expect } from 'vitest';

// Reads an archive back the way an unzip tool does: from the end-of-directory
// record at the tail, through the central directory, to each entry's local
// header and bytes. If this can read it, so can Explorer, Finder and unzip.
export function readZip(zip: Buffer): { name: string; data: Buffer; crc: number; flags: number }[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  let at = zip.readUInt32LE(end + 16);
  expect(at + directorySize).toBe(end);

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(at + 8);
    expect(zip.readUInt16LE(at + 10)).toBe(0); // stored, not deflated
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    expect(zip.readUInt32LE(at + 24)).toBe(size);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);

    expect(zip.readUInt32LE(localAt)).toBe(0x04034b50);
    expect(zip.readUInt32LE(localAt + 14)).toBe(crc);
    const localNameLength = zip.readUInt16LE(localAt + 26);
    const localExtraLength = zip.readUInt16LE(localAt + 28);
    expect(zip.toString('utf8', localAt + 30, localAt + 30 + localNameLength)).toBe(name);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;

    entries.push({ name, data: zip.subarray(dataAt, dataAt + size), crc, flags });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
