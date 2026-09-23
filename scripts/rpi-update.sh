#!/usr/bin/env bash
#
# Rebuild and restart Mini Library after pulling new code.
# Hook this into whatever runs your automatic `git pull`:
#
#   bash scripts/rpi-update.sh
#
# Pass --no-restart to skip restarting MariaDB and the app service (used by
# rpi-setup.sh before the app service exists).
#
# Runs backend/src/db/migrations/*.sql in order via the migration runner,
# which tracks what's already been applied in a schema_migrations table —
# nothing is ever skipped or re-run. This replaces manually pasting SQL in
# some remembered order on the Pi, which is exactly what caused three
# separate production outages (mini_images, phone/neighborhood, collections)
# before this existed. Also still re-applies schema.sql (CREATE TABLE IF NOT
# EXISTS only — never alters or drops anything) as a defensive no-op for
# brand new tables, and restarts MariaDB before the app reconnects.

set -euo pipefail

SERVICE_NAME=mini-library
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
  # The server refuses to start with a missing, placeholder, or short
  # JWT_SECRET (anyone who knew it could forge an admin login). Replace a weak
  # one here instead of letting the deploy take the site down. Side effect:
  # everyone is logged out once and signs in again.
  CURRENT_SECRET="$(grep '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
  if [ "${#CURRENT_SECRET}" -lt 32 ] \
     || [ "$CURRENT_SECRET" = "change-me-in-production" ] \
     || [ "$CURRENT_SECRET" = "change_this_to_a_long_random_string" ]; then
    echo "==> JWT_SECRET in backend/.env is missing or weak — generating a strong one (everyone will need to sign in again)"
    NEW_SECRET="$(openssl rand -hex 32)"
    if grep -q '^JWT_SECRET=' "$ENV_FILE"; then
      sed -i "s/^JWT_SECRET=.*/JWT_SECRET=${NEW_SECRET}/" "$ENV_FILE"
    else
      echo "JWT_SECRET=${NEW_SECRET}" >> "$ENV_FILE"
    fi
  fi
  chmod 600 "$ENV_FILE" # secrets file: readable by the app's user only
fi

echo "==> Installing dependencies (root, backend, frontend)"
npm run install:all

echo "==> Building frontend (frontend/dist)"
npm --prefix frontend run build

echo "==> Building backend (backend/dist)"
npm --prefix backend run build

if [ -f "$ENV_FILE" ] && ! grep -q '^VAPID_PRIVATE_KEY=.' "$ENV_FILE"; then
  # Phone notifications need a key pair that identifies this server to the
  # push services. Made once and then kept: a new pair would silently stop
  # every phone's notifications until that phone next opens the app.
  echo "==> Generating a key pair for phone notifications (VAPID) in backend/.env"
  sed -i '/^VAPID_P[A-Z]*_KEY=/d' "$ENV_FILE" # any empty or half-written pair
  [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE" # don't glue onto an unterminated last line
  node backend/dist/maintenance/vapidKeys.js >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
if [ -f "$ENV_FILE" ] && ! grep -Eq '^(FRONTEND_URL=https://|VAPID_SUBJECT=)' "$ENV_FILE"; then
  echo "==> NOTE: phone notifications stay off until FRONTEND_URL in backend/.env is the site's https:// address"
fi

echo "==> Applying database schema (safe to re-run — only creates missing tables)"
sudo mariadb < backend/src/db/schema.sql

echo "==> Applying database migrations"
(cd backend && node dist/db/runMigrations.js)

if [ "${1:-}" != "--no-restart" ]; then
  echo "==> Restarting MariaDB (clears any stale connections before the app reconnects)"
  sudo systemctl restart mariadb
  sleep 2

  if systemctl list-unit-files --quiet "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    echo "==> Restarting ${SERVICE_NAME}"
    sudo systemctl restart "${SERVICE_NAME}"
    sleep 2
    if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
      echo "==> ${SERVICE_NAME} failed to start. Recent logs:"
      sudo journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
      exit 1
    fi
  else
    echo "==> Service ${SERVICE_NAME} not installed yet — run scripts/rpi-setup.sh first"
  fi
fi

echo "==> Done"
