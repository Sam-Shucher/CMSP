import { describe, it, expect } from 'vitest';
import { parseTable, draftsFromTable, nameFromFilename } from './bulkImport';

// Adding a real shelf one mini at a time is what stops people finishing. These
// turn the two ways a shelf arrives — a spreadsheet, or a pile of photos —
// into rows someone can check over before anything is saved.

describe('parseTable', () => {
  it('reads plain comma-separated lines', () => {
    expect(parseTable('name,price\nDire Wolf,12\nOwlbear,8')).toEqual([
      ['name', 'price'],
      ['Dire Wolf', '12'],
      ['Owlbear', '8'],
    ]);
  });

  it('reads quoted cells, with commas, doubled quotes and line breaks inside them', () => {
    expect(parseTable('name,tags,description\n"Wolf, Dire","undead, boss","The ""big"" one\nsecond line"')).toEqual([
      ['name', 'tags', 'description'],
      ['Wolf, Dire', 'undead, boss', 'The "big" one\nsecond line'],
    ]);
  });

  // What a spreadsheet puts on the clipboard when you copy cells.
  it('reads tab-separated text pasted from a spreadsheet', () => {
    expect(parseTable('name\ttags\nDire Wolf\tundead, boss\n')).toEqual([
      ['name', 'tags'],
      ['Dire Wolf', 'undead, boss'],
    ]);
  });

  it('copes with Windows line endings, a byte-order mark, and blank lines', () => {
    expect(parseTable('﻿name,price\r\n\r\nDire Wolf,12\r\n,\r\n')).toEqual([
      ['name', 'price'],
      ['Dire Wolf', '12'],
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(parseTable('')).toEqual([]);
    expect(parseTable('  \n \n')).toEqual([]);
  });

  // Where a comma is the decimal point (most of Europe), spreadsheets save CSV
  // with semicolons between cells instead.
  it('reads a semicolon-separated file, keeping a comma decimal inside its cell', () => {
    expect(parseTable('name;tags;price\nDire Wolf;undead, boss;12,50')).toEqual([
      ['name', 'tags', 'price'],
      ['Dire Wolf', 'undead, boss', '12,50'],
    ]);
  });

  it('still reads commas when a semicolon only turns up inside a cell', () => {
    expect(parseTable('name,description\nDire Wolf;Owlbear,two minis; one box')).toEqual([
      ['name', 'description'],
      ['Dire Wolf;Owlbear', 'two minis; one box'],
    ]);
  });

  it('keeps a quote mark in the middle of a cell as it is', () => {
    expect(parseTable('name,description\nDire Wolf,on a 2" base')).toEqual([
      ['name', 'description'],
      ['Dire Wolf', 'on a 2" base'],
    ]);
  });

  it('runs a cell with an unclosed opening quote to the end, rather than losing rows silently', () => {
    const table = parseTable('name,price\n"Dire Wolf,12\nOwlbear,8');
    // Everything after the stray quote lands in one cell, where the page's
    // checks will flag it — nothing is quietly dropped.
    expect(table).toHaveLength(2);
    expect(table[1][0]).toContain('Owlbear');
  });
});

describe('draftsFromTable — an awkward first row', () => {
  it('reads the first of two columns with the same name', () => {
    const { drafts } = draftsFromTable([['name', 'name'], ['Dire Wolf', 'Owlbear']]);
    expect(drafts[0].name).toBe('Dire Wolf');
  });

  it('reads a comma-decimal price from a semicolon file, dropping the currency sign', () => {
    const { drafts } = draftsFromTable(parseTable('name;price\nDire Wolf;€ 12,50'));
    expect(drafts[0].price).toBe('12,50'); // the page turns 12,50 into 12.50, same as the single form
  });

  it('keeps a row whose cells run out early, with blanks for the rest', () => {
    const { drafts } = draftsFromTable([['name', 'description', 'tags'], ['Dire Wolf']]);
    expect(drafts[0]).toEqual({ name: 'Dire Wolf', description: '', tags: '', price: '' });
  });

  it('ignores cells past the last named column', () => {
    const { drafts, problems } = draftsFromTable([['name'], ['Dire Wolf', 'stray', 'cells']]);
    expect(drafts).toEqual([{ name: 'Dire Wolf', description: '', tags: '', price: '' }]);
    expect(problems).toEqual([]);
  });
});

describe('draftsFromTable', () => {
  it('reads back its own "Export my minis" file, apostrophe-guarded cells and all', () => {
    const exported = '\ufeffname,description,tags,price,set,photos\r\n'
      + 'Dire Wolf,"Big, grey","beast, wolf",12.50,Pack,photos/001-dire-wolf-1.jpg\r\n'
      + "'=Cursed Idol,'-1 to hit,,0.00,,\r\n";

    const { drafts, problems } = draftsFromTable(parseTable(exported));

    expect(drafts).toEqual([
      { name: 'Dire Wolf', description: 'Big, grey', tags: 'beast, wolf', price: '12.50' },
      { name: '=Cursed Idol', description: '-1 to hit', tags: '', price: '0.00' },
    ]);
    expect(problems).toEqual(['Ignored the "set" and "photos" columns — only name, description, tags, and price are read.']);
  });

  it('keeps an apostrophe that isn\'t guarding a formula', () => {
    expect(draftsFromTable([['name'], ["'Eavy Metal Ork"]]).drafts[0].name).toBe("'Eavy Metal Ork");
  });

  it('maps the columns by their header, in any order and any case', () => {
    const { drafts, problems } = draftsFromTable([
      ['Price', 'Name', 'TAGS', 'Description'],
      ['12.50', 'Dire Wolf', 'undead, boss', 'Reaper, 28mm'],
    ]);

    expect(problems).toEqual([]);
    expect(drafts).toEqual([{ name: 'Dire Wolf', description: 'Reaper, 28mm', tags: 'undead, boss', price: '12.50' }]);
  });

  it('only needs a name column', () => {
    expect(draftsFromTable([['name'], ['Dire Wolf'], ['Owlbear']]).drafts).toEqual([
      { name: 'Dire Wolf', description: '', tags: '', price: '' },
      { name: 'Owlbear', description: '', tags: '', price: '' },
    ]);
  });

  it('accepts semicolons between tags, since a bare comma splits a CSV cell', () => {
    expect(draftsFromTable([['name', 'tags'], ['Dire Wolf', 'undead; boss ;painted']]).drafts[0].tags)
      .toBe('undead, boss, painted');
  });

  it('takes a price written the way a spreadsheet formats money', () => {
    expect(draftsFromTable([['name', 'price'], ['Dire Wolf', '$12.50'], ['Owlbear', ' 8 ']]).drafts.map(d => d.price))
      .toEqual(['12.50', '8']);
  });

  // A missing name is left for the person to fill in, not silently dropped.
  it('keeps a row whose name is blank, so it can be filled in', () => {
    expect(draftsFromTable([['name', 'price'], ['', '5']]).drafts).toEqual([
      { name: '', description: '', tags: '', price: '5' },
    ]);
  });

  it('says which columns it ignored', () => {
    const { drafts, problems } = draftsFromTable([['name', 'Box', 'painted?'], ['Dire Wolf', 'Box 3', 'yes']]);

    expect(drafts).toHaveLength(1);
    expect(problems).toEqual(['Ignored the "Box" and "painted?" columns — only name, description, tags, and price are read.']);
  });

  // A group with prices turned off: a price column is just another column
  // this page doesn't read, and it says so rather than quietly dropping it.
  it('ignores a price column, and says so, when prices are off', () => {
    const { drafts, problems } = draftsFromTable([['name', 'Price'], ['Dire Wolf', '$12.50']], { withPrice: false });

    expect(drafts).toEqual([{ name: 'Dire Wolf', description: '', tags: '', price: '' }]);
    expect(problems).toEqual(['Ignored the "Price" column — only name, description, and tags are read.']);
  });

  it('doesn\'t mention price when a header without "name" is refused, with prices off', () => {
    const { problems } = draftsFromTable([['Dire Wolf', '12']], { withPrice: false });

    expect(problems[0]).not.toMatch(/price/i);
  });

  it('refuses a table whose first row doesn\'t name a "name" column', () => {
    const { drafts, problems } = draftsFromTable([['Dire Wolf', '12'], ['Owlbear', '8']]);

    expect(drafts).toEqual([]);
    expect(problems[0]).toMatch(/first row/i);
    expect(problems[0]).toMatch(/"name"/);
  });

  it('says so when there are no rows under the header', () => {
    const { drafts, problems } = draftsFromTable([['name', 'price']]);

    expect(drafts).toEqual([]);
    expect(problems[0]).toMatch(/no minis/i);
  });

  it('says so when given nothing at all', () => {
    expect(draftsFromTable([]).problems[0]).toMatch(/nothing/i);
  });
});

describe('nameFromFilename', () => {
  it.each([
    ['dire_wolf.jpg', 'dire wolf'],
    ['Beholder (painted).PNG', 'Beholder (painted)'],
    ['owl-bear--v2.webp', 'owl bear v2'],
    // Start like a camera's name, but aren't one.
    ['imgur_dragon.png', 'imgur dragon'],
    ['Photographers Owlbear.jpg', 'Photographers Owlbear'],
    ['dire.wolf.final.jpg', 'dire.wolf.final'],
  ])('turns "%s" into a starting name', (filename, name) => {
    expect(nameFromFilename(filename)).toBe(name);
  });

  // A camera's own names say nothing about the mini — better blank than "IMG 4412".
  it.each(['.jpg', '12345.png', 'IMG_4412.JPG', 'DSC01234.jpg', 'PXL_20260101_123456789.jpg', '20260101_123456.jpg', 'image.png', 'photo 3.jpg', 'Screenshot 2026-01-01 at 10.00.00.png'])(
    'leaves a camera\'s name like "%s" blank',
    (filename) => {
      expect(nameFromFilename(filename)).toBe('');
    }
  );
});
