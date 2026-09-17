#!/usr/bin/env bash
# Redeploy the latest main branch on the VPS (run on the server, or via
# `ssh root@VPS 'bash /opt/spocart-api/deploy/deploy.sh'`).
set -euo pipefail
cd /opt/spocart-api
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
curl -fsS http://localhost:80/health -H "Host: ${API_DOMAIN:-api.spocart.info}" >/dev/null 2>&1 && echo "health ok" || echo "health check via caddy pending (DNS/TLS)"
