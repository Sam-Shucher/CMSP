#!/usr/bin/env bash
#
# One-time setup for running Mini Library on a Raspberry Pi.
# Run as your normal user (NOT with sudo — the script sudos where needed):
#
#   bash scripts/rpi-setup.sh
#
# What it does:
#   1. Installs Node.js 20, MariaDB, and cloudflared
#   2. Creates the mini_library database + a dedicated DB user
#   3. Writes backend/.env with generated secrets (PORT=4269)
#   4. Installs npm dependencies and builds the frontend + backend
#   5. Installs a systemd service so the app starts on boot
#   6. Prints the remaining manual Cloudflare Tunnel steps
#
# Safe to re-run: every step checks whether it's already done.

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this script as your normal user, not with sudo." >&2
  exit 1
fi

APP_PORT=4269
DB_NAME=mini_library
DB_USER=mini_library_user
SERVICE_NAME=mini-library
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$USER"

echo "==> Repo: $REPO_DIR (running as $RUN_USER)"

# --- 1. System packages ------------------------------------------------------

echo "==> Updating apt package lists"
sudo apt-get update -qq

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  echo "==> Installing Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "==> Node.js $(node -v) already installed"
fi

if ! command -v mariadb >/dev/null 2>&1; then
  echo "==> Installing MariaDB (Raspberry Pi OS's MySQL-compatible server)"
  sudo apt-get install -y mariadb-server
  sudo systemctl enable --now mariadb
else
  echo "==> MariaDB already installed"
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "==> Installing cloudflared"
  ARCH="$(dpkg --print-architecture)" # arm64 on Pi 3/4/5 with 64-bit OS, armhf on 32-bit
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  sudo dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
else
  echo "==> cloudflared already installed"
fi

# --- 2. Database -------------------------------------------------------------

ENV_FILE="$REPO_DIR/backend/.env"

if [ -f "$ENV_FILE" ]; then
  echo "==> backend/.env already exists — reusing its DB password"
  DB_PASS="$(grep '^DB_PASS=' "$ENV_FILE" | cut -d= -f2-)"
else
  DB_PASS="$(openssl rand -hex 16)"
fi

echo "==> Creating database and user (no-op if they already exist)"
sudo mariadb <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME}
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> Importing schema (tables use IF NOT EXISTS, so re-running is safe)"
sudo mariadb "$DB_NAME" < "$REPO_DIR/backend/src/db/schema.sql"

# --- 3. Environment file -----------------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Writing backend/.env"
  JWT_SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
DB_HOST=localhost
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}
DB_NAME=${DB_NAME}
JWT_SECRET=${JWT_SECRET}
PORT=${APP_PORT}
FRONTEND_URL=http://localhost:${APP_PORT}
NODE_ENV=production
EOF
  chmod 600 "$ENV_FILE"
else
  echo "==> Keeping existing backend/.env"
fi

# --- 4. Install dependencies and build ---------------------------------------

echo "==> Installing npm dependencies and building"
bash "$REPO_DIR/scripts/rpi-update.sh" --no-restart

# --- 5. systemd service ------------------------------------------------------

echo "==> Installing systemd service '${SERVICE_NAME}'"
sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<EOF
[Unit]
Description=Mini Library (Express API + built React frontend)
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}/backend
ExecStart=$(command -v node) dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}
sleep 2
sudo systemctl --no-pager status ${SERVICE_NAME} || true

# --- 6. Cloudflare Tunnel instructions ----------------------------------------

cat <<EOF

==============================================================================
Setup complete. The app is listening on http://localhost:${APP_PORT}
(and on http://$(hostname -I | awk '{print $1}'):${APP_PORT} from your LAN).

To expose it through Cloudflare, run these once (login opens a browser link):

  cloudflared tunnel login
  cloudflared tunnel create ${SERVICE_NAME}
  cloudflared tunnel route dns ${SERVICE_NAME} minis.YOURDOMAIN.com

Then create ~/.cloudflared/config.yml:

  tunnel: ${SERVICE_NAME}
  credentials-file: /home/${RUN_USER}/.cloudflared/<TUNNEL-ID>.json
  ingress:
    - hostname: minis.YOURDOMAIN.com
      service: http://localhost:${APP_PORT}
    - service: http_status:404

And install it as a service so it survives reboots:

  sudo cloudflared --config ~/.cloudflared/config.yml service install
  sudo systemctl enable --now cloudflared

Finally, update FRONTEND_URL in backend/.env to https://minis.YOURDOMAIN.com
and restart: sudo systemctl restart ${SERVICE_NAME}

After each git pull, run:  bash scripts/rpi-update.sh
==============================================================================
EOF
