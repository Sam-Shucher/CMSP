import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../db/connection';
import { purgeEndedSessions } from '../db/sessions';
import { purgeExpiredNotifications } from '../db/notifications';
import { notifyOverdueLoans } from '../services/loanEvents';
import { promoteStrandedHolds } from '../services/holds';
import { purgeArchivedMinis } from '../services/membership';
import { sweepOrphanedUploads, runHousekeeping, startHousekeeping, ORPHAN_MIN_AGE_MS } from './housekeeping';

// The sweep's SQL is checked against real MariaDB in
// housekeeping.integration.test.ts. These tests cover its safety rules.

const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;
const HOUR = 60 * 60 * 1000;
let dir: string;

function addFile(name: string, ageMs: number): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
}

const referenced = (...names: string[]) => [names.map(n => ({ image_path: `/uploads/${n}` }))];
const quiet = () => {};

beforeEach(() => {
  execute.mockReset();
  vi.mocked(purgeEndedSessions).mockReset().mockResolvedValue(0);
  vi.mocked(purgeExpiredNotifications).mockReset().mockResolvedValue(0);
  vi.mocked(notifyOverdueLoans).mockReset().mockResolvedValue(0);
  vi.mocked(promoteStrandedHolds).mockReset().mockResolvedValue(0);
  vi.mocked(purgeArchivedMinis).mockReset().mockResolvedValue(0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeping-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sweepOrphanedUploads', () => {
  it('waits at least an hour before treating an unused file as abandoned', () => {
    expect(ORPHAN_MIN_AGE_MS).toBe(HOUR);
  });

  it('deletes old files no mini uses, and keeps the ones minis do use', async () => {
    addFile('used.png', 2 * HOUR);
    addFile('orphan.png', 2 * HOUR);
    execute.mockResolvedValueOnce(referenced('used.png'));

    const result = await sweepOrphanedUploads({ uploadsDir: dir, log: quiet });

    expect(result.deleted).toEqual(['orphan.png']);
    expect(fs.readdirSync(dir)).toEqual(['used.png']);
  });

  it('never deletes a recent file — it may belong to an upload still being saved', async () => {
    addFile('keep-me.png', 10 * 60 * 1000);
    addFile('also-used.png', 2 * HOUR);
    execute.mockResolvedValueOnce(referenced('also-used.png'));

    const result = await sweepOrphanedUploads({ uploadsDir: dir, log: quiet });

    expect(result.deleted).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'keep-me.png'))).toBe(true);
  });

  it('only previews in dry-run mode', async () => {
    addFile('used.png', 2 * HOUR);
    addFile('orphan.png', 2 * HOUR);
    execute.mockResolvedValueOnce(referenced('used.png'));

    const result = await sweepOrphanedUploads({ uploadsDir: dir, dryRun: true, log: quiet });

    expect(result.deleted).toEqual(['orphan.png']);
    expect(fs.readdirSync(dir).sort()).toEqual(['orphan.png', 'used.png']);
  });

  it('leaves hidden files and folders alone', async () => {
    addFile('.gitkeep', 2 * HOUR);
    fs.mkdirSync(path.join(dir, 'subfolder'));
    addFile('used.png', 2 * HOUR);
    execute.mockResolvedValueOnce(referenced('used.png'));

    await sweepOrphanedUploads({ uploadsDir: dir, log: quiet });

    expect(fs.readdirSync(dir).sort()).toEqual(['.gitkeep', 'subfolder', 'used.png']);
  });

  it('deletes nothing if it can\'t read the database — unknown is not the same as unused', async () => {
    addFile('photo.png', 2 * HOUR);
    execute.mockRejectedValueOnce(new Error('connection lost'));

    await expect(sweepOrphanedUploads({ uploadsDir: dir, log: quiet })).rejects.toThrow();

    expect(fs.existsSync(path.join(dir, 'photo.png'))).toBe(true);
  });

  // Pointing the app at the wrong (or an empty) database would make EVERY
  // photo look unused. Losing a whole collection's photos is far worse than
  // skipping a sweep, so that situation is refused.
  it('refuses to delete every photo at once when there are more than a few', async () => {
    for (let i = 0; i < 11; i++) addFile(`photo${i}.png`, 2 * HOUR);
    execute.mockResolvedValueOnce([[]]);
    const log = vi.fn();

    const result = await sweepOrphanedUploads({ uploadsDir: dir, log });

    expect(result.deleted).toEqual([]);
    expect(result.skippedReason).toMatch(/every photo/i);
    expect(fs.readdirSync(dir)).toHaveLength(11);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped/i));
  });

  it('still cleans up when only a handful of files exist and none are used', async () => {
    addFile('a.png', 2 * HOUR);
    addFile('b.png', 2 * HOUR);
    execute.mockResolvedValueOnce([[]]);

    const result = await sweepOrphanedUploads({ uploadsDir: dir, log: quiet });

    expect(result.deleted.sort()).toEqual(['a.png', 'b.png']);
  });

  it('copes with a missing uploads folder', async () => {
    execute.mockResolvedValueOnce([[]]);

    const result = await sweepOrphanedUploads({ uploadsDir: path.join(dir, 'nope'), log: quiet });

    expect(result.deleted).toEqual([]);
  });
});

describe('runHousekeeping', () => {
  it('sweeps uploads, purges ended sessions and read notifications, announces overdue loans, promotes stranded holds, and purges archived minis', async () => {
    addFile('orphan.png', 2 * HOUR);
    addFile('used.png', 2 * HOUR);
    execute.mockResolvedValueOnce(referenced('used.png'));
    vi.mocked(purgeEndedSessions).mockResolvedValueOnce(4);
    vi.mocked(purgeExpiredNotifications).mockResolvedValueOnce(3);
    vi.mocked(notifyOverdueLoans).mockResolvedValueOnce(2);
    vi.mocked(promoteStrandedHolds).mockResolvedValueOnce(1);
    vi.mocked(purgeArchivedMinis).mockResolvedValueOnce(5);

    const result = await runHousekeeping({ uploadsDir: dir, log: quiet });

    expect(result).toEqual({
      uploadsDeleted: 1, sessionsPurged: 4, notificationsPurged: 3, overdueAnnounced: 2, holdsPromoted: 1, archivedMinisPurged: 5,
    });
  });

  it('never throws — a failed step is logged, the others still run, and it\'s tried again next time', async () => {
    execute.mockRejectedValue(new Error('connection lost'));
    vi.mocked(purgeEndedSessions).mockRejectedValue(new Error('connection lost'));
    vi.mocked(purgeExpiredNotifications).mockRejectedValue(new Error('connection lost'));
    vi.mocked(notifyOverdueLoans).mockRejectedValue(new Error('connection lost'));
    vi.mocked(promoteStrandedHolds).mockResolvedValueOnce(1);
    vi.mocked(purgeArchivedMinis).mockRejectedValue(new Error('connection lost'));
    const log = vi.fn();

    await expect(runHousekeeping({ uploadsDir: dir, log })).resolves.toEqual({
      uploadsDeleted: 0, sessionsPurged: 0, notificationsPurged: 0, overdueAnnounced: 0, holdsPromoted: 1, archivedMinisPurged: 0,
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed/i));
  });
});

describe('startHousekeeping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs shortly after startup and then every hour, until stopped', async () => {
    execute.mockResolvedValue([[]]);
    const stop = startHousekeeping({ uploadsDir: dir, log: quiet });

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(purgeEndedSessions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(purgeEndedSessions).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(purgeEndedSessions).toHaveBeenCalledTimes(2);
  });
});
