#!/usr/bin/env bash
# Nightly logical backup of the paper-trading database. Keeps 14 days.
# Cron (root): 17 3 * * * /opt/polytrader/app/scripts/backup-db.sh >> /opt/polytrader/backup.log 2>&1
set -euo pipefail
cd /opt/polytrader/app
DEST=/opt/polytrader/backups
mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$DEST/polytrader-$STAMP.dump"
find "$DEST" -name 'polytrader-*.dump' -mtime +14 -print -exec rm {} \;
echo "backup written: $DEST/polytrader-$STAMP.dump"
