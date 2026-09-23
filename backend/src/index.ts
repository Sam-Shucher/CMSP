import 'dotenv/config'; // loads .env file into process.env before anything else
import { createApp } from './app';
import { verifyConnection, databaseClockSkewMinutes } from './db/connection';
import { jwtSecret, listenHosts, pushConfig } from './config';
import { startHousekeeping } from './maintenance/housekeeping';

// Refuse to start with a missing or guessable login-signing secret, rather
// than silently running a server anyone could forge admin cookies for.
try {
  jwtSecret();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Phone notifications are optional — the site runs either way — but say
// plainly in the journal why they're off, so it isn't a mystery on the phone.
const push = pushConfig();
console.log(push.enabled ? 'Phone notifications: on' : `Phone notifications: off — ${push.reason}`);

const app = createApp();
const PORT = Number(process.env.PORT ?? 3001);
const HOSTS = listenHosts();

// Verify the database is reachable before accepting traffic.
// process.exit(1) stops the server entirely if the DB isn't available.
verifyConnection()
  .then(async () => {
    // Said loudly rather than refused: the site still works, but overdue
    // notices, sessions and "archived N days ago" would all be hours off.
    const skew = await databaseClockSkewMinutes().catch(() => 0);
    if (skew > 5) {
      console.error(
        `WARNING: the database's clock reads ${Math.round(skew / 60)}h ${skew % 60}m away from this server's. ` +
        'Run MariaDB in the same timezone as the app (the Pi\'s system timezone), or times will be off.'
      );
    }

    // Hourly: delete photos no mini uses any more, and old ended sessions.
    startHousekeeping();

    if (!HOSTS) {
      app.listen(PORT, () => console.log(`Mini Library API running on port ${PORT}`));
      return;
    }
    for (const host of HOSTS) {
      const server = app.listen(PORT, host, () => console.log(`Mini Library API running on ${host} port ${PORT}`));
      // e.g. IPv6 disabled on this machine — fine as long as another address works.
      server.on('error', (err: NodeJS.ErrnoException) => {
        console.error(`Could not listen on ${host}: ${err.code ?? err.message}`);
        if (HOSTS.length === 1) process.exit(1);
      });
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to connect to database:', message);
    process.exit(1);
  });
