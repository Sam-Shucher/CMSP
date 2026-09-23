import { describe, it, expect } from 'vitest';
import { csvCell, minisCsv, photoEntryName, exportFilename, ExportMini } from './exportFormat';

function mini(overrides: Partial<ExportMini> = {}): ExportMini {
  return {
    name: 'Dire Wolf',
    description: null,
    tags: [],
    price: 12.5,
    set: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    condition: null,
    conditionSince: null,
    onQuest: false,
    photos: [],
    lendingHistory: [],
    ...overrides,
  };
}

describe('csvCell', () => {
  it('leaves plain text alone', () => {
    expect(csvCell('Dire Wolf')).toBe('Dire Wolf');
  });

  it('quotes a cell with a comma, quote, semicolon or line break, doubling quotes', () => {
    expect(csvCell('wolf, dire')).toBe('"wolf, dire"');
    expect(csvCell('the "big" one')).toBe('"the ""big"" one"');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('keeps a spreadsheet from running a cell as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1')).toBe('\'+1');
    expect(csvCell('-1')).toBe('\'-1');
    expect(csvCell('@SUM(A1)')).toBe('\'@SUM(A1)');
  });
});

describe('minisCsv', () => {
  it('uses the Bulk Add columns first, so the file can be added straight back', () => {
    const csv = minisCsv([
      mini({ description: 'Big, grey', tags: ['beast', 'wolf'], set: 'Pack', photos: ['photos/001-dire-wolf-1.jpg'] }),
    ], { withPrice: true });

    expect(csv).toBe(
      '﻿name,description,tags,price,set,photos\r\n'
      + 'Dire Wolf,"Big, grey","beast, wolf",12.50,Pack,photos/001-dire-wolf-1.jpg\r\n'
    );
  });

  it('has no price column in a group with prices turned off', () => {
    const csv = minisCsv([mini({ price: null })], { withPrice: false });

    expect(csv.split('\r\n')[0]).toBe('﻿name,description,tags,set,photos');
    expect(csv.split('\r\n')[1]).toBe('Dire Wolf,,,,');
  });

  it('separates several photos with semicolons', () => {
    const csv = minisCsv([mini({ photos: ['photos/a.jpg', 'photos/b.png'] })], { withPrice: true });

    expect(csv).toContain('"photos/a.jpg; photos/b.png"');
  });
});

describe('photoEntryName', () => {
  it('names a photo after its mini, numbered so each is unique and in order', () => {
    expect(photoEntryName(1, 'Dire Wolf', 0, '/uploads/abc123.jpg')).toBe('photos/001-dire-wolf-1.jpg');
    expect(photoEntryName(42, 'Dire Wolf', 2, '/uploads/abc123.webp')).toBe('photos/042-dire-wolf-3.webp');
  });

  it('keeps letters from any language but nothing that could be a path', () => {
    expect(photoEntryName(1, '../../etc/Café Ünd 🐉', 0, '/uploads/a.png')).toBe('photos/001-etc-café-ünd-1.png');
  });

  it('falls back to "mini" for a name with no letters or digits, and only a known extension', () => {
    expect(photoEntryName(3, '🐉🐉', 0, '/uploads/a.exe')).toBe('photos/003-mini-1.jpg');
  });

  it('shortens a long name', () => {
    const name = photoEntryName(1, 'a'.repeat(200), 0, '/uploads/a.jpg');
    expect(name.length).toBeLessThan(70);
  });
});

describe('exportFilename', () => {
  it('names the download after the group and the day', () => {
    expect(exportFilename('Chicago', '2026-09-23')).toBe('mini-library-chicago-2026-09-23.zip');
  });

  it('copes with a group name that has nothing filename-safe in it', () => {
    expect(exportFilename('"/\\', '2026-09-23')).toBe('mini-library-group-2026-09-23.zip');
  });
});
