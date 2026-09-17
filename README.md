# Mini Library

A small, invite-only web app for tracking and sharing a tabletop miniatures
collection — browse minis, upload your own, and tag them. Built to run
full-time on a Raspberry Pi.

## Stack

- **Backend:** Node.js + Express + TypeScript, talking to MySQL/MariaDB
- **Frontend:** React + Vite + TypeScript
- **Auth:** email allow-list + JWT cookie (only pre-approved emails can register)
- **Deployment:** systemd service on the Pi, exposed to the internet via a
  Cloudflare Tunnel (no port forwarding needed)

## Collections (groups)

The app supports any number of separate collections (shown to users as
"groups" — e.g. "Chicago", "Coast2Coast", "dojo"). Each is fully isolated:
its minis, invite list, and admin panel are invisible to anyone who isn't a
member. Someone in exactly one collection goes straight into it; someone in
several picks which one to enter (and can switch from the nav).

- Invites (`approved_emails`) are scoped per collection. Registering joins
  every collection whose invite list contains that email.
- Roles are per collection (`collection_memberships.role`): you can be an
  admin of Chicago and a regular member of dojo. What you see — including the
  admin panel — depends on your role in the collection you've entered.
  Admins can't change their own role, so every collection keeps an admin.
  Adding someone to a *second* collection they're already registered in is
  a manual `INSERT INTO collection_memberships (user_id, collection_id) …`
  for now (no dedicated UI yet).
- To add a new collection: `INSERT INTO collections (name) VALUES ('Name');`
  then invite people into it the normal way from an admin who's a member.

## Project layout

```
backend/    Express API (auth, minis, admin routes) + MySQL schema
frontend/   React app (dashboard, upload, login/register, admin pages)
scripts/    Raspberry Pi setup/update scripts
```

## Local development

Requires Node.js 20+ and a MySQL/MariaDB server running locally.

```bash
npm run install:all        # installs root, backend, and frontend deps
```

1. Create the database:
   ```bash
   mysql -u root -p < backend/src/db/schema.sql
   ```
2. Copy `backend/.env.example` to `backend/.env` and fill in your local DB
   credentials and a random `JWT_SECRET`.
3. Create a collection and add your own email to its invite list so you can register:
   ```sql
   INSERT INTO collections (name) VALUES ('Chicago');
   INSERT INTO approved_emails (email, collection_id) VALUES ('your@email.com', (SELECT id FROM collections WHERE name = 'Chicago'));
   ```
4. Start both servers:
   ```bash
   npm run dev
   ```
   The frontend runs at `http://localhost:5173` and proxies API requests to
   the backend on `http://localhost:3001`.

After registering your first account, make yourself an admin of that collection:

```sql
UPDATE collection_memberships SET role = 'admin'
  WHERE user_id = (SELECT id FROM users WHERE email = 'your@email.com')
    AND collection_id = (SELECT id FROM collections WHERE name = 'Chicago');
```

## Sessions and cleanup

- Logins are server-side sessions: they end after **2 days unused** or **7 days**
  total (`SESSION_IDLE_DAYS` / `SESSION_LIFETIME_DAYS` in `backend/src/config.ts`).
  Logging out — or "Log out everywhere" on the profile page — ends them immediately.
- Photos from rejected uploads are deleted straight away. Every hour the server
  also removes photo files no mini uses any more (older than an hour) and old
  ended sessions. To preview or run that by hand on the Pi:
  ```bash
  npm --prefix backend run cleanup -- --dry-run   # list what would be removed
  npm --prefix backend run cleanup                # remove it
  ```

## Testing

```bash
npm --prefix backend run test        # unit tests — mocked DB, fast
npm --prefix backend run test:integration   # real MariaDB, catches SQL bugs mocks can't
npm --prefix frontend run test
```

The unit tests mock the database, so they verify route logic (permissions,
validation) but can't catch SQL that's only broken against a real server —
a bad `GROUP BY`, a missing column, a `sql_mode` mismatch. The integration
suite runs the same routes against a real, disposable MariaDB in Docker:

```bash
docker compose -f docker-compose.test.yml up -d   # starts MariaDB on localhost:3307
npm --prefix backend run test:integration
docker compose -f docker-compose.test.yml down -v  # tear it down when done
```

Requires Docker Desktop. This container is local-only and separate from the
Pi's database — nothing here touches production.

## Database migrations

`backend/src/db/schema.sql` only ever runs `CREATE TABLE IF NOT EXISTS` — it
builds a brand-new database, but it does **nothing** for a database that
already exists (a new column on an existing table is silently skipped).
That gap caused three separate production outages in this project's history
(the `mini_images` table, the `phone`/`neighborhood` columns, and the
collections tables/columns all shipped in code before they ever reached the
Pi's actual database).

The fix: **every schema.sql change that isn't a brand new `CREATE TABLE`
must also get a file in `backend/src/db/migrations/`**, numbered after the
last one (`004_whatever.sql`, ...). Migration files must be idempotent
(`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, guard-check
before adding a constraint) so they're safe to run any number of times.

`backend/src/db/runMigrations.ts` applies whatever hasn't run yet, tracked
in a `schema_migrations` table, and is invoked automatically by
`scripts/rpi-update.sh` and `scripts/rpi-setup.sh` on every deploy — there
is no manual step, and no order to get wrong.

`backend/src/db/migrations.integration.test.ts` is the check that actually
enforces the rule above: it builds one database from `schema.sql` directly
and a second from `schema.baseline.sql` (the project's original day-zero
schema) plus every migration file in order, then asserts the two databases
end up with identical tables, columns, and foreign keys. If a schema.sql
edit isn't matched by a migration, this test fails — that's the whole
point. It's part of `npm --prefix backend run test:integration`, so it runs
against the same Docker MariaDB as the rest of that suite.

## Running it on a Raspberry Pi

This is the intended home for the app — it runs as a systemd service and
stays up across reboots.

**First-time setup**, from a clone of this repo on the Pi:

```bash
bash scripts/rpi-setup.sh
```

Run this as your normal user, **not** with `sudo` (it calls `sudo` itself
where needed). It's safe to re-run if something fails partway through.

This one script does everything:

1. Installs Node.js 20, MariaDB, and `cloudflared`
2. Creates the `mini_library` database and a dedicated DB user
3. Writes `backend/.env` with a generated DB password and JWT secret
   (port `4233`)
4. Installs dependencies and builds both the frontend and backend
5. Installs and starts a systemd service (`mini-library`) so the app
   launches automatically on boot
6. Prints the remaining steps to expose it via a Cloudflare Tunnel

At the end, the app is already running at `http://localhost:4233` on the Pi
(and reachable from other devices on your LAN at `http://<pi-ip>:4233`).

**To make it reachable from outside your LAN**, follow the Cloudflare Tunnel
instructions printed at the end of the setup script — in short:

```bash
cloudflared tunnel login
cloudflared tunnel create mini-library
cloudflared tunnel route dns mini-library minis.yourdomain.com
```

Then create `~/.cloudflared/config.yml` pointing `minis.yourdomain.com` at
`http://localhost:4233`, install it as a service with
`cloudflared service install`, and update `FRONTEND_URL` in
`backend/.env` to your `https://` domain.

**Managing the running service:**

```bash
sudo systemctl status mini-library    # check it's running
sudo systemctl restart mini-library   # restart after manual changes
journalctl -u mini-library -f         # tail the logs
```

**After pulling new code**, rebuild and restart with:

```bash
bash scripts/rpi-update.sh
```

This also re-applies `backend/src/db/schema.sql` (safe — it only creates
tables that don't exist yet, never alters or drops anything) and restarts
MariaDB before the app reconnects. It does **not** add new columns to an
already-existing table — that still needs a manual `ALTER TABLE`, the same
way `phone`/`neighborhood` did.

## Environment variables

See `backend/.env.example` for the full list. Key ones:

| Variable       | Purpose                                            |
| -------------- | --------------------------------------------------- |
| `DB_HOST`      | MySQL/MariaDB host (`localhost` on the Pi)          |
| `DB_USER`      | Database user                                       |
| `DB_PASS`      | Database password                                   |
| `DB_NAME`      | Database name (`mini_library`)                      |
| `JWT_SECRET`   | Random secret used to sign auth cookies             |
| `PORT`         | Port the backend listens on (`4233` in production)  |
| `FRONTEND_URL` | Allowed CORS origin / public URL of the site         |
| `NODE_ENV`     | `production` makes the backend also serve the built frontend |
