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
3. Add your own email to the invite list so you can register:
   ```sql
   INSERT INTO approved_emails (email) VALUES ('your@email.com');
   ```
4. Start both servers:
   ```bash
   npm run dev
   ```
   The frontend runs at `http://localhost:5173` and proxies API requests to
   the backend on `http://localhost:3001`.

After registering your first account, promote yourself to admin:

```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

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
