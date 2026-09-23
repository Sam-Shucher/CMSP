// Turning a whole shelf into rows for the bulk-add page (pages/BulkAddPage.tsx):
// a spreadsheet — a .csv file, or cells copied straight out of one — or a pile
// of photos named after what's in them. Nothing here saves anything; each row
// is checked over on the page and then added the same way a single mini is.

export const DRAFT_COLUMNS = ['name', 'description', 'tags', 'price'] as const;
export type DraftColumn = (typeof DRAFT_COLUMNS)[number];
export type DraftFields = Record<DraftColumn, string>;

// Rows of cells from CSV or tab-separated text. Tabs win when the first line
// has one — that's what a spreadsheet puts on the clipboard when cells are
// copied — otherwise commas, with the usual quoting: "a, b" is one cell, ""
// inside quotes is a quote, and a quoted cell may run over several lines.
// Cells are trimmed and rows with nothing in them are dropped.
export function parseTable(text: string): string[][] {
  const source = text.replace(/^﻿/, ''); // Excel's byte-order mark
  const firstLine = source.split(/\r?\n/).find(line => line.trim() !== '') ?? '';
  // Semicolons are what a spreadsheet saves as "CSV" where the comma is the
  // decimal point — told apart by a header row with semicolons and no commas.
  const delimiter = firstLine.includes('\t') ? '\t'
    : firstLine.includes(';') && !firstLine.includes(',') ? ';'
    : ',';

  const table: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      table.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  table.push(row);

  return table
    .map(cells => cells.map(c => c.trim()))
    .filter(cells => cells.some(c => c !== ''));
}

function listOf(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// A table's rows as drafts, by the column names in its first row (any order,
// any case). Only "name" is required. Unknown columns are skipped, and said so,
// rather than refusing the whole file over a "Box" column someone keeps for
// themselves. A row with a blank name is kept, to be filled in on the page.
// withPrice: false is a group with prices turned off, where a price column is
// just another one this doesn't read.
export function draftsFromTable(
  table: string[][],
  { withPrice = true }: { withPrice?: boolean } = {}
): { drafts: DraftFields[]; problems: string[] } {
  if (table.length === 0) return { drafts: [], problems: ['There was nothing to read.'] };

  const columns: readonly string[] = withPrice ? DRAFT_COLUMNS : DRAFT_COLUMNS.filter(column => column !== 'price');
  const header = table[0].map(cell => cell.trim().toLowerCase());
  if (!header.includes('name')) {
    return {
      drafts: [],
      problems: [`The first row has to name the columns, with at least a "name" column (${listOf(columns.slice(1))} are optional).`],
    };
  }

  const problems: string[] = [];
  const ignored = table[0]
    .map(cell => cell.trim())
    .filter((cell, i) => cell !== '' && !columns.includes(header[i]));
  if (ignored.length > 0) {
    problems.push(
      `Ignored the ${listOf(ignored.map(cell => `"${cell}"`))} column${ignored.length === 1 ? '' : 's'} — only ${listOf([...columns])} are read.`
    );
  }

  const drafts = table.slice(1).map((row): DraftFields => {
    const cell = (column: DraftColumn): string => {
      const at = header.indexOf(column);
      if (at === -1 || at >= row.length) return ''; // a short row just has blanks at the end
      // '=… is how a spreadsheet (and "Export my minis") keeps a cell that
      // starts like a formula from running as one; the apostrophe isn't part of it.
      return row[at].trim().replace(/^'(?=[=+\-@])/, '');
    };
    return {
      name: cell('name'),
      description: cell('description'),
      // A bare comma would split the CSV cell, so semicolons work too.
      tags: cell('tags').split(/[;,]/).map(tag => tag.trim()).filter(Boolean).join(', '),
      // "$12.50" is how a spreadsheet shows money; the server wants 12.50.
      price: withPrice ? cell('price').replace(/^[$£€]\s*/, '') : '',
    };
  });
  if (drafts.length === 0) problems.push('There were no minis under the header row.');

  return { drafts, problems };
}

// Phone and camera names say nothing about the mini — "IMG 4412" is worse than
// an empty box that asks for a name.
const CAMERA_NAME = /^(img|dsc|dscn|dscf|pxl|mvimg|vid|photo|image|screenshot|screen shot|whatsapp image)\b|^(img|dsc|dscn|dscf|pxl|mvimg|vid)[_-]?\d/i;

// A starting name from a photo's filename, when someone has already named the
// file after what's in it ("dire_wolf.jpg"); blank otherwise.
export function nameFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  if (!/\p{L}/u.test(base) || CAMERA_NAME.test(base)) return '';
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
