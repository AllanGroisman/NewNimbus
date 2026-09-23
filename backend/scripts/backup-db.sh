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

# Grava em .partial e só renomeia depois de validar: um pg_dump que morre no meio
# deixava o .sql.gz truncado em disco, e o backup-remote.js da hora seguinte o
# subia pro B2 como se fosse bom. O .partial não casa com db-*.sql.gz, então nem o
# upload nem a rotação o enxergam.
PARTIAL="$OUT.partial"
trap 'rm -f "$PARTIAL"' EXIT

echo "[backup-db] pg_dump $PG_DB -> $OUT"
$DOCKER exec "$CONTAINER" pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$PARTIAL"

if ! gzip -t "$PARTIAL"; then
  echo "[backup-db] dump corrompido (gzip -t falhou). Aborta." >&2
  exit 1
fi
if ! zcat "$PARTIAL" | tail -c 4096 | grep -q "PostgreSQL database dump complete"; then
  echo "[backup-db] dump incompleto (sem o marcador de fim do pg_dump). Aborta." >&2
  exit 1
fi
mv "$PARTIAL" "$OUT"

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
