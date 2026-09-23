import path from 'path';

// What goes inside "Export my minis" (routes/export.ts): the file layout and
// the CSV. Kept apart from the route so the formatting can be tested without
// a database or a zip in the way.

export interface ExportLoan {
  borrower: string;
  handedOffAt: string;
  returnedAt: string | null;
  outcome: 'adventuring' | 'returned' | 'lost' | 'critically_wounded';
}

export interface ExportMini {
  name: string;
  description: string | null;
  tags: string[];
  price: number | null; // null: the group has prices turned off
  set: string | null;
  addedAt: string;
  condition: string | null;
  conditionSince: string | null;
  onQuest: boolean;
  photos: string[];     // paths inside the zip
  lendingHistory: ExportLoan[];
}

// A spreadsheet runs a cell starting with one of these as a formula — and a
// mini's name can have been typed by someone else before it was transferred.
// The leading apostrophe is how a spreadsheet itself says "this is text";
// Bulk Add takes it off again on the way back in.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",;\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// One row per mini. name, description, tags and price are exactly Bulk Add's
// columns (frontend/src/utils/bulkImport.ts), so this file can be dropped
// straight back onto that page — in this group or another — and the extra
// set/photos columns are simply noted and skipped there. A byte-order mark
// up front so Excel reads the accents as UTF-8; Bulk Add strips it.
export function minisCsv(minis: ExportMini[], { withPrice }: { withPrice: boolean }): string {
  const columns = withPrice
    ? ['name', 'description', 'tags', 'price', 'set', 'photos']
    : ['name', 'description', 'tags', 'set', 'photos'];
  const lines = [columns.join(',')];
  for (const mini of minis) {
    const cells = [mini.name, mini.description ?? '', mini.tags.join(', ')];
    if (withPrice) cells.push(mini.price === null ? '' : mini.price.toFixed(2));
    cells.push(mini.set ?? '', mini.photos.join('; '));
    lines.push(cells.map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// Letters and digits in any language, dashes between words — nothing that
// could climb out of the photos/ folder or upset a file system.
function slug(text: string, fallback: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return cleaned || fallback;
}

const PHOTO_EXTENSIONS = new Set(['.jpg', '.png', '.gif', '.webp']);

// photos/001-dire-wolf-1.jpg — the mini's place in the export, its name, and
// which of its photos. Saved uploads only ever have these extensions (the
// upload pipeline names them from their real bytes); anything else is a
// .jpg rather than trusted.
export function photoEntryName(miniNumber: number, miniName: string, position: number, imagePath: string): string {
  const extension = path.extname(imagePath).toLowerCase();
  const safeExtension = PHOTO_EXTENSIONS.has(extension) ? extension : '.jpg';
  return `photos/${String(miniNumber).padStart(3, '0')}-${slug(miniName, 'mini')}-${position + 1}${safeExtension}`;
}

export function exportFilename(groupName: string, day: string): string {
  return `mini-library-${slug(groupName, 'group')}-${day}.zip`;
}

export function readme(groupName: string, exportedAt: string, missingPhotos: number): string {
  const lines = [
    `Your minis in ${groupName}, exported ${exportedAt}.`,
    '',
    'minis.csv   One row per mini. Opens in any spreadsheet, and can be dropped',
    '            onto the Bulk Add page to add them all again.',
    'minis.json  Everything, including when each was added, its condition, and',
    '            who has borrowed it and when.',
    'photos/     Every photo, named after its mini.',
  ];
  if (missingPhotos > 0) {
    lines.push('', `${missingPhotos} photo${missingPhotos === 1 ? ' was' : 's were'} missing from the server and could not be included.`);
  }
  return `${lines.join('\r\n')}\r\n`;
}
