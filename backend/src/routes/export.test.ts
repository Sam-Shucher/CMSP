import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { authCookie } from '../test/helpers';
import { readZip, binaryBody } from '../test/readZip';

// Route logic for "Export my minis" with the database mocked: what goes in the
// zip and under what names, the group check on the link, and the limit. The
// SQL itself (only your own minis, only this group, nothing archived) is
// proven against the real database in export.integration.test.ts.
vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { createApp } from '../app';
import { EXPORTS_PER_HOUR } from './export';

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

const COLLECTION = 10;
const OWNER = { userId: 1, username: 'owner', role: 'user', collectionId: COLLECTION };

const MEMBERSHIP = [[{ role: 'user', show_prices: 1 }]];
const MEMBERSHIP_NO_PRICES = [[{ role: 'user', show_prices: 0 }]];

const PHOTO_FILE = 'export-test-photo.jpg';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function miniRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Dire Wolf',
    description: 'Big, grey',
    price: '12.50',
    created_at: new Date('2026-03-01T12:00:00Z'),
    condition_flag: null,
    condition_since: null,
    on_quest_since: null,
    set_name: 'Pack',
    tags: 'beast,wolf',
    ...overrides,
  };
}

// Membership, then the group's name, the minis, their photos, their loans.
function mockExport(
  { membership = MEMBERSHIP, minis = [miniRow()], images = [] as unknown[], loans = [] as unknown[] } = {}
): void {
  execute
    .mockResolvedValueOnce(membership)
    .mockResolvedValueOnce([[{ name: 'Chicago' }]])
    .mockResolvedValueOnce([minis])
    .mockResolvedValueOnce([images])
    .mockResolvedValueOnce([loans]);
}

function download(query = '') {
  return request(app).get(`/api/export${query}`).set('Cookie', authCookie(OWNER)).buffer(true).parse(binaryBody);
}

function entry(zip: Buffer, name: string): string {
  const found = readZip(zip).find(e => e.name === name);
  if (!found) throw new Error(`${name} is not in the zip`);
  return found.data.toString('utf8');
}

beforeEach(() => {
  execute.mockReset();
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR!, PHOTO_FILE), PHOTO_BYTES);
});

afterEach(() => {
  fs.rmSync(path.join(process.env.UPLOADS_DIR!, PHOTO_FILE), { force: true });
});

describe('GET /api/export', () => {
  it('downloads a zip named after the group and the day', async () => {
    mockExport();

    const res = await download();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="mini-library-chicago-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(readZip(res.body as Buffer).map(e => e.name)).toEqual(['minis.csv', 'minis.json', 'README.txt']);
  });

  it('asks only for the caller\'s own minis in the group they\'re in', async () => {
    mockExport();

    await download();

    const [minisSql, minisParams] = execute.mock.calls[2] as [string, unknown[]];
    expect(minisSql).toMatch(/m\.owner_id = \?/);
    expect(minisSql).toMatch(/m\.archived_at IS NULL/);
    expect(minisParams).toEqual([OWNER.userId, COLLECTION]);
  });

  it('puts each photo in photos/, named after its mini, and lists it in the CSV and JSON', async () => {
    mockExport({ images: [{ mini_id: 7, image_path: `/uploads/${PHOTO_FILE}` }] });

    const zip = (await download()).body as Buffer;

    const photo = readZip(zip).find(e => e.name === 'photos/001-dire-wolf-1.jpg');
    expect(photo?.data.equals(PHOTO_BYTES)).toBe(true);
    expect(entry(zip, 'minis.csv')).toContain('Dire Wolf,"Big, grey","beast, wolf",12.50,Pack,photos/001-dire-wolf-1.jpg');
    expect(JSON.parse(entry(zip, 'minis.json')).minis[0].photos).toEqual(['photos/001-dire-wolf-1.jpg']);
  });

  it('skips a photo that has gone missing from disk, and says so in the README', async () => {
    mockExport({ images: [{ mini_id: 7, image_path: '/uploads/not-there.jpg' }] });

    const zip = (await download()).body as Buffer;

    expect(readZip(zip).some(e => e.name.startsWith('photos/'))).toBe(false);
    expect(JSON.parse(entry(zip, 'minis.json')).minis[0].photos).toEqual([]);
    expect(entry(zip, 'README.txt')).toMatch(/1 photo was missing/);
  });

  it('only ever reads a photo from the uploads folder, whatever the stored path says', async () => {
    mockExport({ images: [{ mini_id: 7, image_path: `/uploads/../../somewhere/${PHOTO_FILE}` }] });

    const zip = (await download()).body as Buffer;

    // basename() of that path is the photo in the uploads folder itself.
    expect(readZip(zip).find(e => e.name.startsWith('photos/'))?.data.equals(PHOTO_BYTES)).toBe(true);
  });

  it('keeps the full record in the JSON: condition, quest, lending history', async () => {
    mockExport({
      minis: [miniRow({ condition_flag: 'critically_wounded', condition_since: new Date('2026-05-01T00:00:00Z') })],
      loans: [{
        mini_id: 7, borrower_name: 'Bruno', status: 'critically_wounded',
        handed_off_at: new Date('2026-04-01T00:00:00Z'), returned_at: new Date('2026-05-01T00:00:00Z'),
      }],
    });

    const record = JSON.parse(entry((await download()).body as Buffer, 'minis.json'));

    expect(record.group).toBe('Chicago');
    expect(record.pricesShown).toBe(true);
    expect(record.minis[0]).toMatchObject({
      name: 'Dire Wolf',
      tags: ['beast', 'wolf'],
      price: 12.5,
      set: 'Pack',
      addedAt: '2026-03-01T12:00:00.000Z',
      condition: 'critically_wounded',
      conditionSince: '2026-05-01T00:00:00.000Z',
      onQuest: false,
      lendingHistory: [{
        borrower: 'Bruno',
        handedOffAt: '2026-04-01T00:00:00.000Z',
        returnedAt: '2026-05-01T00:00:00.000Z',
        outcome: 'critically_wounded',
      }],
    });
  });

  it('leaves prices out entirely in a group that has them turned off', async () => {
    mockExport({ membership: MEMBERSHIP_NO_PRICES });

    const zip = (await download()).body as Buffer;

    expect(entry(zip, 'minis.csv').split('\r\n')[0]).not.toContain('price');
    expect(entry(zip, 'minis.csv')).not.toContain('12.50');
    expect(JSON.parse(entry(zip, 'minis.json')).minis[0].price).toBeNull();
  });

  it('exports an empty list when you have no minis here', async () => {
    mockExport({ minis: [] });

    const zip = (await download()).body as Buffer;

    expect(entry(zip, 'minis.csv')).toBe('﻿name,description,tags,price,set,photos\r\n');
    expect(JSON.parse(entry(zip, 'minis.json')).minis).toEqual([]);
  });

  it('refuses a link made for another group (switched in another tab)', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP);

    const res = await download(`?group=${COLLECTION + 1}`);

    expect(res.status).toBe(409);
    expect(JSON.parse((res.body as Buffer).toString()).code).toBe('group_changed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts a link made for this group', async () => {
    mockExport();

    expect((await download(`?group=${COLLECTION}`)).status).toBe(200);
  });

  it('refuses a group that isn\'t an id', async () => {
    execute.mockResolvedValueOnce(MEMBERSHIP);

    expect((await download('?group=abc')).status).toBe(400);
  });

  it(`allows ${EXPORTS_PER_HOUR} exports an hour, then asks them to wait`, async () => {
    for (let i = 0; i < EXPORTS_PER_HOUR; i += 1) {
      mockExport();
      expect((await download()).status).toBe(200);
    }
    execute.mockResolvedValueOnce(MEMBERSHIP);

    const res = await download();

    expect(res.status).toBe(429);
    expect(JSON.parse((res.body as Buffer).toString()).error).toMatch(/exported a few times/);
  });
});
