#!/usr/bin/env bash
# Backup local do Postgres do Nimbus.
#
# Roda pg_dump do container nimbus-postgres e salva em backend/backups/
# como db-YYYYMMDD-HHMMSS.sql.gz. Rotaciona mantendo os últimos N (default 48).
#
# Uso:
#   bash backend/scripts/backup-db.sh                  # backup + rotação
#   BACKUP_RETAIN_LOCAL=96 bash .../backup-db.sh       # mantém 96 (4 dias se 1/hora)
#
# Exige Docker rodando com o container nimbus-postgres up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUPS_DIR="$BACKEND_DIR/backups"
RETAIN="${BACKUP_RETAIN_LOCAL:-48}"
CONTAINER="${POSTGRES_CONTAINER:-nimbus-postgres}"
PG_USER="${POSTGRES_USER:-nimbus}"
PG_DB="${POSTGRES_DB:-nimbus}"

mkdir -p "$BACKUPS_DIR"

TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUPS_DIR/db-$TS.sql.gz"

# Detecta se precisa de sudo no docker (depende do grupo do user)
if docker ps >/dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="sudo docker"
fi

if ! $DOCKER ps --format '{{.Names}}' | grep -q "^$CONTAINER$"; then
  echo "[backup-db] container $CONTAINER nao esta rodando. Aborta." >&2
  exit 1
fi

echo "[backup-db] pg_dump $PG_DB -> $OUT"
$DOCKER exec "$CONTAINER" pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup-db] OK ($SIZE)"

# Rotação local
COUNT=$(find "$BACKUPS_DIR" -maxdepth 1 -type f -name 'db-*.sql.gz' | wc -l)
if [[ "$COUNT" -gt "$RETAIN" ]]; then
  REMOVE=$((COUNT - RETAIN))
  echo "[backup-db] rotação: $COUNT dumps, removendo os $REMOVE mais antigos (retain=$RETAIN)"
  find "$BACKUPS_DIR" -maxdepth 1 -type f -name 'db-*.sql.gz' -printf '%T@ %p\n' \
    | sort -n | head -n "$REMOVE" | cut -d' ' -f2- \
    | xargs -r rm -v
fi
