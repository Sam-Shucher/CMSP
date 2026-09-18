// How long a password hash takes on THIS machine — run it on the Pi, because
// that's the machine that has to do it on every sign-in.
//
//   npm --prefix backend run bench:hash
//
// Every step up in cost doubles the work, for us and for anyone cracking a
// stolen database. Pick the highest cost whose time you can live with at
// sign-in, and set PASSWORD_COST in backend/.env to match.
import bcrypt from 'bcryptjs';
import { passwordCost } from '../utils/passwords';

const SAMPLE = 'a representative pass phrase, 40-odd bytes';

async function timeCost(cost: number): Promise<number> {
  const started = Date.now();
  await bcrypt.hash(SAMPLE, cost);
  return Date.now() - started;
}

async function main(): Promise<void> {
  const configured = passwordCost();
  console.log(`Configured cost: ${configured}${process.env.PASSWORD_COST ? '' : ' (default — PASSWORD_COST is not set)'}\n`);

  for (const cost of [10, 11, 12, 13, 14]) {
    const ms = await timeCost(cost);
    const mark = cost === configured ? '  <- configured' : '';
    console.log(`  cost ${cost}: ${String(ms).padStart(5)} ms per sign-in${mark}`);
  }

  console.log(`
Every sign-in and registration pays this once, on one CPU core.
Somewhere around 250-750 ms is a good balance; if the configured row is much
slower than that, set a lower PASSWORD_COST in backend/.env and restart.
Existing passwords are re-hashed to the new cost as people sign in.`);
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
