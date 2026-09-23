import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection';
import { removeMember, purgeArchivedMinis } from './membership';
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
let admin: TestUser;    // the admin doing the removing, for audit_log's actor

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

const bookingRowsFor = (userId: number, collectionId: number): Promise<number> => countRows(
  'SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND collection_id = ?',
  [userId, collectionId]
);

async function book(miniId: number, who: TestUser, collectionId: number): Promise<void> {
  await pool.execute(
    `INSERT INTO bookings (mini_id, collection_id, user_id, starts_on, ends_on)
     VALUES (?, ?, ?, CURDATE() + INTERVAL 7 DAY, CURDATE() + INTERVAL 8 DAY)`,
    [miniId, collectionId, who.userId]
  );
}

const miniExists = (id: number): Promise<number> =>
  countRows('SELECT COUNT(*) AS n FROM minis WHERE id = ?', [id]);

const isArchived = async (id: number): Promise<boolean> => {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT archived_at FROM minis WHERE id = ?', [id]);
  return rows[0]?.archived_at !== null;
};

const latestAuditLog = async (collectionId: number): Promise<RowDataPacket | undefined> => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM audit_log WHERE collection_id = ? ORDER BY id DESC LIMIT 1', [collectionId]
  );
  return rows[0];
};

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
  admin = await createUser('boss', chicago, 'admin');
  await joinCollection(admin, dojo, 'admin');

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

    const result = await removeMember(ada.userId, chicago, admin.userId);

    expect(result).toMatchObject({ ok: true });
    expect(await cartRowsFor(ada.userId, chicago)).toBe(0);
    expect(await cartRowsFor(ada.userId, dojo), 'her dojo cart was emptied too').toBe(1);
  });

  it('drops her place in line in that group only', async () => {
    await removeMember(ada.userId, chicago, admin.userId);

    expect(await holdRowsFor(ada.userId, chicago)).toBe(0);
    expect(await holdRowsFor(ada.userId, dojo), 'her dojo hold was dropped too').toBe(1);
  });

  it('stops her watching minis in that group only', async () => {
    await removeMember(ada.userId, chicago, admin.userId);

    expect(await watcherRowsFor(ada.userId, chicago)).toBe(0);
    expect(await watcherRowsFor(ada.userId, dojo), 'she stopped watching in dojo too').toBe(1);
  });

  // She keeps another collection, so her mini here is archived (recoverable
  // for MINI_ARCHIVE_GRACE_DAYS), not deleted outright — see the "last
  // collection" test below for the case where it really is gone right away.
  it('archives the mini she owns in that group and leaves the other group\'s alone', async () => {
    await removeMember(ada.userId, chicago, admin.userId);

    expect(await miniExists(adaChicagoMini), 'archived, not deleted').toBe(1);
    expect(await isArchived(adaChicagoMini)).toBe(true);
    expect(await isArchived(adaDojoMini), 'her dojo mini was untouched').toBe(false);
  });

  // Nobody can still be queued on a mini they can no longer get to.
  it('clears holds, watchers, and cart entries — anyone\'s — on the mini it archives', async () => {
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [olivia.userId, adaChicagoMini]);
    await pool.execute('INSERT INTO holds (mini_id, user_id) VALUES (?, ?)', [adaChicagoMini, olivia.userId]);
    await pool.execute('INSERT INTO hold_watchers (mini_id, user_id) VALUES (?, ?)', [adaChicagoMini, olivia.userId]);

    await removeMember(ada.userId, chicago, admin.userId);

    expect(await cartRowsFor(olivia.userId, chicago)).toBe(0);
    expect(await holdRowsFor(olivia.userId, chicago)).toBe(0);
    expect(await watcherRowsFor(olivia.userId, chicago)).toBe(0);
  });

  // Feature 13: a booking by someone no longer in the group would come due
  // and find nobody to hand the mini to.
  it('drops her bookings in that group only', async () => {
    await book(chicagoMini, ada, chicago);
    await book(dojoMini, adaInDojo, dojo);

    await removeMember(ada.userId, chicago, admin.userId);

    expect(await bookingRowsFor(ada.userId, chicago)).toBe(0);
    expect(await bookingRowsFor(ada.userId, dojo), 'her dojo booking was dropped too').toBe(1);
  });

  it('clears anyone\'s bookings on the mini it archives, and leaves bookings on other minis alone', async () => {
    await book(adaChicagoMini, olivia, chicago);
    await book(chicagoMini, admin, chicago);

    await removeMember(ada.userId, chicago, admin.userId);

    expect(await countRows('SELECT COUNT(*) AS n FROM bookings WHERE mini_id = ?', [adaChicagoMini])).toBe(0);
    expect(await bookingRowsFor(admin.userId, chicago), 'a booking on someone else\'s mini went too').toBe(1);
  });

  // Her sets go the same way her minis do: archived, not left behind empty
  // on the Sets page under the name of someone who isn't in the group.
  it('archives her sets in that group, and leaves her sets in the other group alone', async () => {
    const [chicagoSet] = await pool.execute<import('mysql2').ResultSetHeader>(
      'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Owlbear pack', ada.userId, chicago]
    );
    const [dojoSet] = await pool.execute<import('mysql2').ResultSetHeader>(
      'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Beholder court', ada.userId, dojo]
    );
    await pool.execute('UPDATE minis SET set_id = ? WHERE id = ?', [chicagoSet.insertId, adaChicagoMini]);

    await removeMember(ada.userId, chicago, admin.userId);

    // null means "not archived", so a missing row has to be told apart from it.
    const archivedAt = async (id: number): Promise<Date | null | 'gone'> => {
      const [found] = await pool.execute<RowDataPacket[]>('SELECT archived_at FROM sets WHERE id = ?', [id]);
      return found.length === 0 ? 'gone' : (found[0].archived_at as Date | null);
    };
    expect(await archivedAt(chicagoSet.insertId)).toBeInstanceOf(Date);
    expect(await archivedAt(dojoSet.insertId), 'her dojo set was archived too').toBeNull();
    // The mini keeps pointing at it, so a restore to her can bring both back.
    expect(await countRows('SELECT COUNT(*) AS n FROM minis WHERE id = ? AND set_id = ?', [adaChicagoMini, chicagoSet.insertId])).toBe(1);
  });

  it('purges her archived sets along with her archived minis once the grace period is over', async () => {
    const [set] = await pool.execute<import('mysql2').ResultSetHeader>(
      'INSERT INTO sets (name, owner_id, collection_id) VALUES (?, ?, ?)', ['Owlbear pack', ada.userId, chicago]
    );
    await removeMember(ada.userId, chicago, admin.userId);
    await pool.execute('UPDATE sets SET archived_at = NOW() - INTERVAL 31 DAY WHERE id = ?', [set.insertId]);
    await pool.execute('UPDATE minis SET archived_at = NOW() - INTERVAL 31 DAY WHERE id = ?', [adaChicagoMini]);

    await purgeArchivedMinis();

    expect(await countRows('SELECT COUNT(*) AS n FROM sets WHERE id = ?', [set.insertId])).toBe(0);
    expect(await miniExists(adaChicagoMini)).toBe(0);
  });

  it('leaves her a member of the other group, with her account intact', async () => {
    const result = await removeMember(ada.userId, chicago, admin.userId);

    expect(result).toMatchObject({ ok: true, accountDeleted: false });
    expect(await countRows(
      'SELECT COUNT(*) AS n FROM collection_memberships WHERE user_id = ?', [ada.userId]
    )).toBe(1);
    expect(await countRows('SELECT COUNT(*) AS n FROM users WHERE id = ?', [ada.userId])).toBe(1);
  });

  it('records who removed her, and that her mini was archived, in the audit log', async () => {
    const result = await removeMember(ada.userId, chicago, admin.userId);

    expect(result).toMatchObject({ ok: true, minisRemoved: 1 });
    const entry = await latestAuditLog(chicago);
    expect(entry).toMatchObject({
      action: 'member_removed', actor_name: 'boss display', target_name: 'ada display',
    });
    expect(entry?.details).toMatch(/archived their 1 mini here/i);
  });

  it('touches nobody else\'s rows', async () => {
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [olivia.userId, adaChicagoMini]);
    await pool.execute('INSERT INTO cart_items (user_id, mini_id) VALUES (?, ?)', [dmitri.userId, dojoMini]);

    await removeMember(ada.userId, chicago, admin.userId);

    // Olivia's cart row pointed at a mini that's now archived, so it's
    // explicitly cleared (the mini itself no longer being deleted, there's no
    // foreign key left to do it for free) — dmitri's, in the other group,
    // must remain untouched either way.
    expect(await cartRowsFor(dmitri.userId, dojo)).toBe(1);
    expect(await countRows(
      'SELECT COUNT(*) AS n FROM collection_memberships WHERE collection_id = ?', [dojo]
    )).toBe(3); // ada, dmitri, and the admin
  });

  // The other direction, so the test can't pass just by doing nothing.
  it('does delete the account AND the mini outright when the group removed from was her last', async () => {
    await removeMember(ada.userId, chicago, admin.userId);
    const result = await removeMember(ada.userId, dojo, admin.userId);

    expect(result).toMatchObject({ ok: true, accountDeleted: true });
    expect(await countRows('SELECT COUNT(*) AS n FROM users WHERE id = ?', [ada.userId])).toBe(0);
    expect(await cartRowsFor(ada.userId, dojo)).toBe(0);
    expect(await miniExists(adaDojoMini), 'no grace period on the account\'s last collection').toBe(0);

    const entry = await latestAuditLog(dojo);
    expect(entry?.details).toMatch(/last one.*account and their 1 mini here were deleted/i);
  });
});
