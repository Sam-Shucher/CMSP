import fs from 'fs';
import path from 'path';
import { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection';
import { purgeEndedSessions } from '../db/sessions';
import { uploadsDir as configuredUploadsDir } from '../config';

// Background cleanup ("garbage collection"). Rejected uploads are already
// deleted the moment they're rejected (see minis.ts), and deleting a mini or
// removing a photo deletes its file right away. This sweep catches whatever
// slips past those: photos left behind when an account (and so its minis) is
// deleted, a crash between saving a file and saving the mini, and so on.

// A file this new may belong to an upload whose mini hasn't been saved yet.
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

// If the sweep would delete EVERY photo and there are more than this many,
// something is misconfigured (e.g. connected to the wrong or an empty
// database) — refuse rather than wipe a whole collection's photos.
const MASS_DELETE_GUARD = 10;

type Log = (line: string) => void;

interface SweepOptions {
  uploadsDir?: string;
  minAgeMs?: number;
  dryRun?: boolean;
  log?: Log;
}

export interface SweepResult {
  deleted: string[];   // filenames removed (or that would be, in a dry run)
  kept: number;
  skippedReason?: string;
}

export async function sweepOrphanedUploads(options: SweepOptions = {}): Promise<SweepResult> {
  const dir = options.uploadsDir ?? configuredUploadsDir();
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const log = options.log ?? console.log;

  // Read what's in use FIRST. If the database can't be read this throws, and
  // nothing is deleted — "unknown" must never be treated as "unused".
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT image_path FROM mini_images
     UNION
     SELECT image_path FROM minis WHERE image_path IS NOT NULL` // legacy single-photo column
  );
  const inUse = new Set(rows.map(r => path.basename(String(r.image_path))));

  if (!fs.existsSync(dir)) return { deleted: [], kept: 0 };

  const cutoff = Date.now() - minAgeMs;
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => entry.name);

  const orphans = files.filter(name => !inUse.has(name) && fs.statSync(path.join(dir, name)).mtimeMs < cutoff);

  if (orphans.length > MASS_DELETE_GUARD && orphans.length === files.length) {
    const skippedReason = `every photo (${files.length}) looks unused — is the app connected to the right database?`;
    log(`Upload cleanup skipped: ${skippedReason}`);
    return { deleted: [], kept: files.length, skippedReason };
  }

  if (!options.dryRun) {
    for (const name of orphans) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  return { deleted: orphans, kept: files.length - orphans.length };
}

// One full pass. Never throws: a failure is logged and the next run tries again.
export async function runHousekeeping(options: SweepOptions = {}): Promise<{ uploadsDeleted: number; sessionsPurged: number }> {
  const log = options.log ?? console.log;
  let uploadsDeleted = 0;
  let sessionsPurged = 0;

  try {
    uploadsDeleted = (await sweepOrphanedUploads(options)).deleted.length;
  } catch (err: unknown) {
    log(`Upload cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    sessionsPurged = await purgeEndedSessions();
  } catch (err: unknown) {
    log(`Session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (uploadsDeleted || sessionsPurged) {
    log(`Housekeeping: removed ${uploadsDeleted} unused photo(s), ${sessionsPurged} ended session(s)`);
  }
  return { uploadsDeleted, sessionsPurged };
}

// Runs a minute after startup, then hourly. Returns a function that stops it.
export function startHousekeeping(options: SweepOptions & { intervalMs?: number } = {}): () => void {
  const intervalMs = options.intervalMs ?? HOUSEKEEPING_INTERVAL_MS;
  let interval: NodeJS.Timeout | undefined;

  const first = setTimeout(() => {
    void runHousekeeping(options);
    interval = setInterval(() => void runHousekeeping(options), intervalMs);
    interval.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.(); // never keeps the process alive on its own

  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
