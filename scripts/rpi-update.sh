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

echo "==> Installing dependencies (root, backend, frontend)"
npm run install:all

echo "==> Building frontend (frontend/dist)"
npm --prefix frontend run build

echo "==> Building backend (backend/dist)"
npm --prefix backend run build

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
