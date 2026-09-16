import 'dotenv/config'; // loads .env file into process.env before anything else
import { createApp } from './app';
import { verifyConnection } from './db/connection';

const app = createApp();
const PORT = process.env.PORT ?? 3001;

// Verify the database is reachable before accepting traffic.
// process.exit(1) stops the server entirely if the DB isn't available.
verifyConnection()
  .then(() => {
    app.listen(PORT, () => console.log(`Mini Library API running on port ${PORT}`));
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to connect to database:', message);
    process.exit(1);
  });
