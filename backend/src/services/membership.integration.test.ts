import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection';
import { removeMember } from './membership';
import {
  assertDatabaseReachable, resetDatabase, createCollection, createUser, createMini, joinCollection, TestUser,
} from '../test/dbHelpers';

// Removing someone from ONE group must leave every other group they belong to
// exactly as it was. Nothing in cart_items, holds, or hold_watchers carries a
// collection of its own — it's derived from the mini each row points at — so
// every clean-up query has to join through minis and filter on collection_id.
// A query simplified to "WHERE user_id = ?" would still pass every other test
// in the suite while quietly emptying a second group's cart. That's what this
// file is here to catch.
//
// Requires: docker compose -f docker-compose.test.yml up -d

let chicago: number;
let dojo: number;
let ada: TestUser;      // the two-group member being removed from Chicago
let adaInDojo: TestUser;
let olivia: TestUser;   // owns minis in Chicago
let dmitri: TestUser;   // owns minis in dojo

// Minis other people own, one per group, for ada to put in her cart.
let chicagoMini: number;
let dojoMini: number;
// Minis ada owns herself, one per group.
let adaChicagoMini: number;
let adaDojoMini: number;

async function countRows(sql: string, params: (string | number)[]): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(sql, params);
  return Number(rows[0].n);
}

const cartRowsFor = (userId: number, collectionId: number): Promise<number> => countRows(
  `SELECT COUNT(*) AS n FROM cart_items ci JOIN minis m ON m.id = ci.mini_id
   WHERE ci.user_id = ? AND m.collection_id = ?`,
  [userId, collectionId]
);

const holdRowsFor = (userId: number, collectionId: number): Promise<number> => countRows(
  `SELECT COUNT(*) AS n FROM holds h JOIN minis m ON m.id = h.mini_id
   WHERE h.user_id = ? AND m.collection_id = ?`,
  [userId, collectionId]
);

const watcherRowsFor = (userId: number, collectionId: number): Promise<number> => countRows(
  `SELECT COUNT(*) AS n FROM hold_watchers hw JOIN minis m ON m.id = hw.mini_id
   WHERE hw.user_id = ? AND m.collection_id = ?`,
  [userId, collectionId]
);

const miniExists = (id: number): Promise<number> =>
  countRows('SELECT COUNT(*) AS n FROM minis WHERE id = ?', [id]);

beforeAll(assertDatabaseReachable);
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDatabase();
  chicago = await createCollection('Chicago');
  dojo = await createCollection('dojo');

  ada = await createUser('ada', chicago);
  adaInDojo = await joinCollection(ada, dojo);
  olivia = await createUser('olivia', chicago);
  dmitri = await createUser('dmitri', dojo);

  chicagoMini = await createMini(olivia, 'Dire Wolf');
  dojoMini = await createMini(dmitri, 'Sensei Frog');
  adaChicagoMini = await createMini(ada, 'Ada\'s Owlbear');
  adaDojoMini = await createMini(adaInDojo, 'Ada\'s Beholder');

  // Ada is waiting on, and has carted, something in each group. Inserted
  // directly: what's being tested is the clean-up's reach, not how these
  // rows come to exist (that's covered in holds.integration.test.ts).
  for (const miniId of [chicagoMini, dojoMini]) {
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [ada.userId, miniId]);
    await pool.execute('INSERT INTO holds (mini_id, user_id) VALUES (?, ?)', [miniId, ada.userId]);
    await pool.execute('INSERT INTO hold_watchers (mini_id, user_id) VALUES (?, ?)', [miniId, ada.userId]);
  }
});

describe('removeMember — a member of two groups, removed from one', () => {
  it('empties her cart in that group and leaves the other group\'s alone', async () => {
    expect(await cartRowsFor(ada.userId, chicago)).toBe(1);
    expect(await cartRowsFor(ada.userId, dojo)).toBe(1);

    const result = await removeMember(ada.userId, chicago);

    expect(result).toMatchObject({ ok: true });
    expect(await cartRowsFor(ada.userId, chicago)).toBe(0);
    expect(await cartRowsFor(ada.userId, dojo), 'her dojo cart was emptied too').toBe(1);
  });

  it('drops her place in line in that group only', async () => {
    await removeMember(ada.userId, chicago);

    expect(await holdRowsFor(ada.userId, chicago)).toBe(0);
    expect(await holdRowsFor(ada.userId, dojo), 'her dojo hold was dropped too').toBe(1);
  });

  it('stops her watching minis in that group only', async () => {
    await removeMember(ada.userId, chicago);

    expect(await watcherRowsFor(ada.userId, chicago)).toBe(0);
    expect(await watcherRowsFor(ada.userId, dojo), 'she stopped watching in dojo too').toBe(1);
  });

  it('removes the minis she owns in that group and keeps the ones in the other', async () => {
    await removeMember(ada.userId, chicago);

    expect(await miniExists(adaChicagoMini)).toBe(0);
    expect(await miniExists(adaDojoMini), 'her dojo mini was deleted too').toBe(1);
  });

  it('leaves her a member of the other group, with her account intact', async () => {
    const result = await removeMember(ada.userId, chicago);

    expect(result).toMatchObject({ ok: true, accountDeleted: false });
    expect(await countRows(
      'SELECT COUNT(*) AS n FROM collection_memberships WHERE user_id = ?', [ada.userId]
    )).toBe(1);
    expect(await countRows('SELECT COUNT(*) AS n FROM users WHERE id = ?', [ada.userId])).toBe(1);
  });

  it('touches nobody else\'s rows', async () => {
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [olivia.userId, adaChicagoMini]);
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [dmitri.userId, dojoMini]);

    await removeMember(ada.userId, chicago);

    // Olivia's cart row pointed at a mini that has now gone, so the row goes
    // with it (foreign key) — but dmitri's, in the other group, must remain.
    expect(await cartRowsFor(dmitri.userId, dojo)).toBe(1);
    expect(await countRows(
      'SELECT COUNT(*) AS n FROM collection_memberships WHERE collection_id = ?', [dojo]
    )).toBe(2); // ada and dmitri
  });

  // The other direction, so the test can't pass just by doing nothing.
  it('does delete the account when the group removed from was her last', async () => {
    await removeMember(ada.userId, chicago);
    const result = await removeMember(ada.userId, dojo);

    expect(result).toMatchObject({ ok: true, accountDeleted: true });
    expect(await countRows('SELECT COUNT(*) AS n FROM users WHERE id = ?', [ada.userId])).toBe(0);
    expect(await cartRowsFor(ada.userId, dojo)).toBe(0);
  });
});
