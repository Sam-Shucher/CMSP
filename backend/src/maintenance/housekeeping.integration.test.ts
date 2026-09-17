import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from '../app';
import { pool } from '../db/connection';
import { uploadsDir } from '../config';
import { sweepOrphanedUploads, runHousekeeping } from './housekeeping';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, TestUser,
} from '../test/dbHelpers';

// Cleanup against the real database and the (scratch) uploads folder.
// Requires: docker compose -f docker-compose.test.yml up -d

const app = createApp();
const TWO_HOURS = 2 * 60 * 60 * 1000;
const dir = uploadsDir();

let owner: TestUser;
let other: TestUser;

function writePhoto(name: string, ageMs = TWO_HOURS): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'PHOTO');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
}

async function attach(miniId: number, name: string): Promise<void> {
  await pool.execute('INSERT INTO mini_images (mini_id, image_path, position) VALUES (?, ?, 0)', [miniId, `/uploads/${name}`]);
}

const onDisk = () => fs.readdirSync(dir).sort();
const quiet = () => {};

function tinyPng(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
    'hex'
  );
}

beforeAll(assertDatabaseReachable);
afterAll(() => pool.end());

beforeEach(async () => {
  await resetDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const chicago = await createCollection('Chicago');
  owner = await createUser('owner', chicago);
  other = await createUser('other', chicago);
});

describe('sweeping unused photos', () => {
  it('keeps photos minis use and removes old ones nothing uses', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    writePhoto('1700000000-used.png');
    await attach(wolf, '1700000000-used.png');
    writePhoto('1700000000-orphan.png');

    const result = await sweepOrphanedUploads({ log: quiet });

    expect(result.deleted).toEqual(['1700000000-orphan.png']);
    expect(onDisk()).toEqual(['1700000000-used.png']);
  });

  it('keeps photos still referenced by the old single-photo column', async () => {
    const [res] = await pool.execute<import('mysql2').ResultSetHeader>(
      'INSERT INTO minis (name, owner_id, collection_id, image_path) VALUES (?, ?, ?, ?)',
      ['Legacy Mini', owner.userId, owner.collectionId, '/uploads/1600000000-legacy.jpg']
    );
    expect(res.insertId).toBeGreaterThan(0);
    writePhoto('1600000000-legacy.jpg');

    await sweepOrphanedUploads({ log: quiet });

    expect(onDisk()).toEqual(['1600000000-legacy.jpg']);
  });

  it('cleans up the photos left behind when an account (and so its minis) is deleted', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');
    const bear = await createMini(other, 'Owlbear');
    writePhoto('1700000000-wolf.png');
    writePhoto('1700000000-bear.png');
    await attach(wolf, '1700000000-wolf.png');
    await attach(bear, '1700000000-bear.png');

    await pool.execute('DELETE FROM users WHERE id = ?', [owner.userId]); // cascades to their minis

    const result = await runHousekeeping({ log: quiet });

    expect(result.uploadsDeleted).toBe(1);
    expect(onDisk()).toEqual(['1700000000-bear.png']);
  });

  it('never touches a just-uploaded photo whose mini isn\'t saved yet', async () => {
    writePhoto('1700000000-in-flight.png', 30 * 1000);
    writePhoto('1700000000-used.png');
    await attach(await createMini(owner, 'Dire Wolf'), '1700000000-used.png');

    await sweepOrphanedUploads({ log: quiet });

    expect(onDisk()).toContain('1700000000-in-flight.png');
  });
});

describe('photos removed through the app', () => {
  it('deleting a mini deletes its photo files immediately', async () => {
    const created = await request(app).post('/api/minis').set('Cookie', owner.cookie)
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'wolf.png');
    expect(onDisk()).toHaveLength(1);

    await request(app).delete(`/api/minis/${created.body.miniId}`).set('Cookie', owner.cookie);

    await expect.poll(() => onDisk()).toEqual([]);
  });

  it('removing a photo while editing deletes that file, and keeps the rest', async () => {
    const created = await request(app).post('/api/minis').set('Cookie', owner.cookie)
      .field('name', 'Dire Wolf')
      .attach('images', tinyPng(), 'front.png')
      .attach('images', tinyPng(), 'back.png');
    const mini = await request(app).get(`/api/minis/${created.body.miniId}`).set('Cookie', owner.cookie);
    const [front, back] = mini.body.images as string[];

    await request(app).patch(`/api/minis/${created.body.miniId}`).set('Cookie', owner.cookie)
      .field('name', 'Dire Wolf')
      .field('existingImages', JSON.stringify([back]));

    await expect.poll(() => onDisk()).toEqual([path.basename(back)]);
    expect(onDisk()).not.toContain(path.basename(front));
  });

  it('a rejected upload leaves no file behind', async () => {
    const wolf = await createMini(owner, 'Dire Wolf');

    const res = await request(app).patch(`/api/minis/${wolf}`).set('Cookie', other.cookie)
      .field('name', 'Stolen')
      .attach('images', tinyPng(), 'sneaky.png');

    expect(res.status).toBe(403);
    expect(onDisk()).toEqual([]);
  });
});
