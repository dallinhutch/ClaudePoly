#!/usr/bin/env bash
# Deploy/update on the VPS. Layout:
#   /opt/polytrader/.env   secrets (chmod 600, never in git)
#   /opt/polytrader/app    git clone of this repository
set -euo pipefail

APP_DIR=/opt/polytrader/app
cd "$APP_DIR"

git pull --ff-only
ln -sfn ../.env .env

docker compose build
docker compose up -d postgres
# One-off migration run; fails the script (set -e) if a migration fails.
docker compose run --rm migrate
docker compose up -d web worker
docker compose ps

# Database backup before/after deploys is handled by scripts/backup-db.sh (cron).
