#!/usr/bin/env bash
#
# Rebuild and restart Mini Library after pulling new code.
# Hook this into whatever runs your automatic `git pull`:
#
#   bash scripts/rpi-update.sh
#
# Pass --no-restart to skip the systemd restart (used by rpi-setup.sh
# before the service exists).

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

if [ "${1:-}" != "--no-restart" ]; then
  if systemctl list-unit-files --quiet "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    echo "==> Restarting ${SERVICE_NAME}"
    sudo systemctl restart "${SERVICE_NAME}"
  else
    echo "==> Service ${SERVICE_NAME} not installed yet — run scripts/rpi-setup.sh first"
  fi
fi

echo "==> Done"
