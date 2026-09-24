import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { rows, firstValue } from '../db/query';
import { requireAuth } from '../middleware/requireAuth';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import { rateLimit } from '../middleware/rateLimit';
import { uploadsDir } from '../middleware/uploads';
import { route } from '../utils/route';
import { optionalId } from '../utils/inputs';
import { todayInApp } from '../utils/appTime';
import { ZipWriter } from '../utils/zip';
import {
  ExportMini, ExportLoan, minisCsv, photoEntryName, exportFilename, readme,
} from '../utils/exportFormat';

// GET /api/export — "Export my minis": everything a member has put into this
// group, as one .zip they keep. A spreadsheet of their minis in Bulk Add's
// own columns (so it can go straight back in, here or in another group), the
// full record as JSON (condition, sets, who has borrowed each and when), and
// every photo. Doubles as a backup that doesn't depend on the Pi's SD card.
//
// Only the caller's own minis, only in the group they're in — the same line
// every other route draws. An archived mini isn't theirs to see any more.
const router = Router();
router.use(requireAuth, requireCollectionMembership);

// Each export reads every photo someone has off the SD card, on the one core,
// so it's a thing to do now and then — not in a loop.
export const EXPORTS_PER_HOUR = 6;
const exportLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: EXPORTS_PER_HOUR,
  key: req => `export:${(req as CollectionRequest).user?.userId ?? req.ip}`,
  message: retryAfterSeconds => `You've exported a few times already — try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
});

interface OwnMiniRow {
  id: number;
  name: string;
  description: string | null;
  price: string;
  created_at: Date;
  condition_flag: string | null;
  condition_since: Date | null;
  on_quest_since: Date | null;
  set_name: string | null;
  tags: string | null;
}

interface OwnImageRow {
  mini_id: number;
  image_path: string;
}

interface OwnLoanRow {
  mini_id: number;
  borrower_name: string;
  handed_off_at: Date;
  returned_at: Date | null;
  status: ExportLoan['outcome'];
}

class DownloadCancelled extends Error {}

// res.write, waiting when the connection is full — so a slow phone download
// holds back the reading of the next photo instead of piling them up in memory.
function writerFor(res: Response): (chunk: Buffer) => Promise<void> {
  return chunk => new Promise<void>((resolve, reject) => {
    if (res.destroyed) {
      reject(new DownloadCancelled());
      return;
    }
    if (res.write(chunk)) {
      resolve();
      return;
    }
    const onDrain = (): void => { res.off('close', onClose); resolve(); };
    const onClose = (): void => { res.off('drain', onDrain); reject(new DownloadCancelled()); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

async function readPhoto(imagePath: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(path.join(uploadsDir, path.basename(imagePath)));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

router.get('/', exportLimit, route(async (req, res) => {
  // The download is a real browser navigation (a link), not a fetch — so the
  // file streams to disk instead of into a phone's memory — which means no
  // X-Collection-Id header. The page puts its group in the link instead, and a
  // mismatch is refused the same way the header's is: switching groups in
  // another tab mustn't hand over the other group's minis under this one's name.
  const pageGroup = optionalId(req.query.group, 'Group');
  if (!pageGroup.ok) {
    res.status(400).json({ error: pageGroup.error });
    return;
  }
  if (pageGroup.value !== null && pageGroup.value !== req.collectionId) {
    res.status(409).json({
      error: 'You switched groups in another tab — go back and export again from the group you want.',
      code: 'group_changed',
    });
    return;
  }

  const userId = req.user!.userId;
  const collectionId = req.collectionId!;
  const groupName = (await firstValue<string>('SELECT name FROM collections WHERE id = ?', [collectionId])) ?? 'group';
  const minis = await rows<OwnMiniRow>(
    `SELECT m.id, m.name, m.description, m.price, m.created_at,
            m.condition_flag, m.condition_since, m.on_quest_since,
            st.name AS set_name,
            GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags
     FROM minis m
     LEFT JOIN sets st ON st.id = m.set_id
     LEFT JOIN mini_tags mt ON mt.mini_id = m.id
     LEFT JOIN tags t ON t.id = mt.tag_id
     WHERE m.owner_id = ? AND m.collection_id = ? AND m.archived_at IS NULL
     GROUP BY m.id
     ORDER BY m.created_at, m.id`,
    [userId, collectionId]
  );
  const images = await rows<OwnImageRow>(
    `SELECT mi.mini_id, mi.image_path
     FROM mini_images mi JOIN minis m ON m.id = mi.mini_id
     WHERE m.owner_id = ? AND m.collection_id = ? AND m.archived_at IS NULL
     ORDER BY mi.mini_id, mi.position`,
    [userId, collectionId]
  );
  // The same loans GET /api/minis/:id/history shows the owner: every one that
  // reached a handoff, including from before the mini was transferred to them.
  const loans = await rows<OwnLoanRow>(
    `SELECT l.mini_id, COALESCE(u.display_name, l.removed_borrower_name) AS borrower_name,
            l.handed_off_at, l.returned_at, l.status
     FROM loans l
     JOIN minis m ON m.id = l.mini_id
     LEFT JOIN users u ON u.id = l.borrower_id
     WHERE m.owner_id = ? AND m.collection_id = ? AND m.archived_at IS NULL
       AND l.collection_id = ? AND l.handed_off_at IS NOT NULL
     ORDER BY l.handed_off_at`,
    [userId, collectionId, collectionId]
  );

  const now = new Date();
  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(groupName, todayInApp(now))}"`);
  res.setHeader('Cache-Control', 'no-store');

  const zip = new ZipWriter(writerFor(res));
  try {
    // Photos first, so the CSV and JSON list only the ones that made it in.
    const exported: ExportMini[] = [];
    let missingPhotos = 0;
    for (const [index, mini] of minis.entries()) {
      const photos: string[] = [];
      for (const image of images.filter(i => i.mini_id === mini.id)) {
        const data = await readPhoto(image.image_path);
        if (!data) {
          missingPhotos += 1;
          continue;
        }
        const entryName = photoEntryName(index + 1, mini.name, photos.length, image.image_path);
        await zip.add(entryName, data, now);
        photos.push(entryName);
      }
      exported.push({
        name: mini.name,
        description: mini.description,
        tags: mini.tags ? mini.tags.split(',') : [],
        price: req.showPrices ? Number(mini.price) : null,
        set: mini.set_name,
        addedAt: mini.created_at.toISOString(),
        condition: mini.condition_flag,
        conditionSince: mini.condition_since ? mini.condition_since.toISOString() : null,
        onQuest: mini.on_quest_since !== null,
        photos,
        lendingHistory: loans.filter(l => l.mini_id === mini.id).map(l => ({
          borrower: l.borrower_name,
          handedOffAt: l.handed_off_at.toISOString(),
          returnedAt: l.returned_at ? l.returned_at.toISOString() : null,
          outcome: l.status,
        })),
      });
    }

    await zip.add('minis.csv', Buffer.from(minisCsv(exported, { withPrice: req.showPrices! }), 'utf8'), now);
    const record = { group: groupName, exportedAt: now.toISOString(), pricesShown: req.showPrices!, minis: exported };
    await zip.add('minis.json', Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'), now);
    await zip.add('README.txt', Buffer.from(readme(groupName, now.toISOString(), missingPhotos), 'utf8'), now);
    await zip.finish();
    res.end();
  } catch (err: unknown) {
    // Headers are gone, so there's no error reply to send — cutting the
    // connection is what tells the browser the download failed, rather than
    // leaving a truncated file that looks finished.
    res.destroy();
    if (err instanceof DownloadCancelled) return; // they closed the tab; nothing went wrong here
    throw err;
  }
}));

export default router;
