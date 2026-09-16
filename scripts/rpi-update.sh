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
# Re-applies backend/src/db/schema.sql and restarts MariaDB on every run —
# schema.sql is all CREATE TABLE IF NOT EXISTS (never alters or drops
# anything, so it's safe to re-run), and a stale MariaDB connection was the
# cause of a production 500 once before. Note: schema.sql only adds brand
# new tables — a new COLUMN on an existing table still needs a manual
# ALTER TABLE, the same way phone/neighborhood did.

set -euo pipefail

SERVICE_NAME=mini-library
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Installing dependencies (root, backend, frontend)"
npm run install:all

echo "==> Applying database schema (safe to re-run)"
sudo mariadb < backend/src/db/schema.sql

echo "==> Building frontend (frontend/dist)"
npm --prefix frontend run build

echo "==> Building backend (backend/dist)"
npm --prefix backend run build

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
