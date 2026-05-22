#!/usr/bin/env bash
# Abre o gerenciador interativo de backups.
# Uso: bash deploy/backup.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../backend"
node scripts/sync-manager.js
