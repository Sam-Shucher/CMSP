import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { ResultSetHeader } from 'mysql2';
import { createApp } from '../app';
import { pool } from '../db/connection';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';
import { readZip } from '../test/readZip';

// "Export my minis" against the real database: the queries really do stop at
// your own minis, in the group you're in, leaving out archived ones — and the
// tags, set, photo rows and lending history come through intact.
//
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const PHOTO_FILE = 'export-integration-photo.png';
const PHOTO_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let chicago: number;
let dojo: number;
let olivia: TestUser;
let bruno: TestUser;

beforeAll(assertDatabaseReachable);
afterAll(async () => {
  fs.rmSync(path.join(process.env.UPLOADS_DIR!, PHOTO_FILE), { force: true });
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
  chicago = await createCollection('Chicago');
  dojo = await createCollection('dojo');
  olivia = await createUser('olivia', chicago);
  bruno = await createUser('bruno', chicago);
  fs.mkdirSync(process.env.UPLOADS_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR!, PHOTO_FILE), PHOTO_BYTES);
});

function binary(res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

async function exportFor(user: TestUser): Promise<{ names: string[]; csv: string; json: { minis: Record<string, unknown>[] } }> {
  const res = await request(app).get('/api/export').set('Cookie', user.cookie).buffer(true).parse(binary);
  expect(res.status).toBe(200);
  const entries = readZip(res.body as Buffer);
  const text = (name: string): string => entries.find(e => e.name === name)!.data.toString('utf8');
  return { names: entries.map(e => e.name), csv: text('minis.csv'), json: JSON.parse(text('minis.json')) };
}

async function tag(miniId: number, name: string): Promise<void> {
  await pool.execute('INSERT IGNORE INTO tags (name) VALUES (?)', [name]);
  await pool.execute('INSERT INTO mini_tags (mini_id, tag_id) SELECT ?, id FROM tags WHERE name = ?', [miniId, name]);
}

describe('GET /api/export', () => {
  it('has only your own minis in this group — not another member\'s, another group\'s, or an archived one', async () => {
    await createMini(olivia, 'Banshee');
    await createMini(bruno, 'Bruno\'s Ogre');
    await createMini(await joinCollection(olivia, dojo), 'Dojo Ronin');
    const archived = await createMini(olivia, 'Archived Ghost');
    await pool.execute('UPDATE minis SET archived_at = NOW() WHERE id = ?', [archived]);

    const { json } = await exportFor(olivia);

    expect(json.minis.map(m => m.name)).toEqual(['Banshee']);
  });

  it('brings tags, set, price, photos and lending history through the real queries', async () => {
    const banshee = await createMini(olivia, 'Banshee');
    await pool.execute('UPDATE minis SET price = 4.25 WHERE id = ?', [banshee]);
    await tag(banshee, 'aelves');
    await tag(banshee, 'ghost');
    const [set] = await pool.execute<ResultSetHeader>(
      'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Blades of Khaine', olivia.userId, chicago]
    );
    await pool.execute('UPDATE minis SET set_id = ? WHERE id = ?', [set.insertId, banshee]);
    await pool.execute('INSERT INTO mini_images (mini_id, image_path, position) VALUES (?, ?, 0)', [banshee, `/uploads/${PHOTO_FILE}`]);
    await pool.execute(
      `INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status, handed_off_at, returned_at)
       VALUES (?, ?, ?, ?, 'returned', '2026-04-01 18:00:00', '2026-04-10 18:00:00')`,
      [banshee, chicago, bruno.userId, olivia.userId]
    );
    // A request that never got as far as a handoff isn't history.
    await pool.execute(
      "INSERT INTO loans (mini_id, collection_id, borrower_id, owner_id, status) VALUES (?, ?, ?, ?, 'cancelled')",
      [banshee, chicago, bruno.userId, olivia.userId]
    );

    const { names, csv, json } = await exportFor(olivia);

    expect(names).toContain('photos/001-banshee-1.png');
    expect(csv).toContain('Banshee,,"aelves, ghost",4.25,Blades of Khaine,photos/001-banshee-1.png');
    expect(json.minis[0]).toMatchObject({
      tags: ['aelves', 'ghost'],
      price: 4.25,
      set: 'Blades of Khaine',
      photos: ['photos/001-banshee-1.png'],
      lendingHistory: [expect.objectContaining({ borrower: 'bruno display', outcome: 'returned' })],
    });
  });

  it('includes a lost or critically wounded mini — it\'s still yours', async () => {
    const wolf = await createMini(olivia, 'Dire Wolf');
    await pool.execute("UPDATE minis SET condition_flag = 'lost', condition_since = NOW() WHERE id = ?", [wolf]);

    const { json } = await exportFor(olivia);

    expect(json.minis).toEqual([expect.objectContaining({ name: 'Dire Wolf', condition: 'lost' })]);
  });
});
