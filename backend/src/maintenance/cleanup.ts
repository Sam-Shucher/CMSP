// Runs the housekeeping sweep once, by hand. The server already does this
// every hour; this is for checking what it would do, or cleaning up right away.
//
//   npm --prefix backend run cleanup -- --dry-run   # list what would be removed
//   npm --prefix backend run cleanup                # remove it
import './loadEnv';
import { pool } from '../db/connection';
import { purgeEndedSessions } from '../db/sessions';
import { sweepOrphanedUploads } from './housekeeping';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const uploads = await sweepOrphanedUploads({ dryRun });
  if (uploads.skippedReason) {
    console.log(`Photos: skipped — ${uploads.skippedReason}`);
  } else {
    console.log(`Photos: ${dryRun ? 'would remove' : 'removed'} ${uploads.deleted.length}, kept ${uploads.kept}`);
    for (const name of uploads.deleted) console.log(`  ${name}`);
  }

  if (dryRun) {
    console.log('Sessions: (dry run — ended sessions not purged)');
  } else {
    console.log(`Sessions: removed ${await purgeEndedSessions()} ended session(s)`);
  }
}

main()
  .catch((err: unknown) => {
    console.error('Cleanup failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
