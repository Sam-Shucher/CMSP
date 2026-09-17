import 'dotenv/config'; // loads .env file into process.env before anything else
import { createApp } from './app';
import { verifyConnection } from './db/connection';
import { jwtSecret, listenHosts } from './config';
import { startHousekeeping } from './maintenance/housekeeping';

// Refuse to start with a missing or guessable login-signing secret, rather
// than silently running a server anyone could forge admin cookies for.
try {
  jwtSecret();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const app = createApp();
const PORT = Number(process.env.PORT ?? 3001);
const HOSTS = listenHosts();

// Verify the database is reachable before accepting traffic.
// process.exit(1) stops the server entirely if the DB isn't available.
verifyConnection()
  .then(() => {
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
