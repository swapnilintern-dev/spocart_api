#!/usr/bin/env bash
# One-time VPS setup for the SPOCART API (Ubuntu 22.04 / 24.04, run as root).
#   curl -fsSL https://raw.githubusercontent.com/swapnilintern-dev/spocart_api/main/deploy/setup.sh | bash
set -euo pipefail

REPO="https://github.com/swapnilintern-dev/spocart_api.git"
APP_DIR="/opt/spocart-api"

echo "==> System update + basics"
apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades

echo "==> Firewall: only SSH, HTTP, HTTPS"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo
  echo "!!! Edit $APP_DIR/.env with the production values, then run:"
  echo "    cd $APP_DIR && docker compose up -d --build"
  exit 0
fi

cd "$APP_DIR" && docker compose up -d --build
echo "==> Done. Check: curl -s https://\${API_DOMAIN:-api.spocart.info}/health"
