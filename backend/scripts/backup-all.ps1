# Backup completo do Nimbus — roda Postgres (pg_dump via Docker) + cópia da pasta data/.
# Mantém os últimos 96 snapshots de cada (≈ 24h de histórico rodando a cada 15min).
#
# Uso manual:
#   powershell -ExecutionPolicy Bypass -File backend\scripts\backup-all.ps1
#
# Agendado: Windows Task Scheduler chama este script a cada 15min.

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Split-Path -Parent $ScriptDir
$BackupDir  = Join-Path $BackendDir "backups"
$DataDir    = Join-Path $BackendDir "data"

$Keep = 96
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

# ─── 1. pg_dump do Postgres via docker exec ───────────────────────────
$dumpFile = Join-Path $BackupDir "db-$Stamp.sql"
$t0 = Get-Date

try {
    # docker exec NAO repassa stderr como erro do PowerShell se ExitCode = 0
    $dump = docker exec nimbus-postgres pg_dump -U nimbus -d nimbus 2>$null
    if ($LASTEXITCODE -ne 0) { throw "docker exec pg_dump retornou exit code $LASTEXITCODE" }
    [System.IO.File]::WriteAllText($dumpFile, $dump, [System.Text.UTF8Encoding]::new($false))
    $size = [math]::Round((Get-Item $dumpFile).Length / 1KB, 1)
    $elapsed = [math]::Round(((Get-Date) - $t0).TotalMilliseconds, 0)
    Write-Host "[backup-pg] ok: db-$Stamp.sql ($size KB, ${elapsed}ms)"
} catch {
    Write-Host "[backup-pg] FALHOU: $_"
}

# ─── 2. Cópia da pasta backend/data/ (configs JSON residuais) ─────────
if (Test-Path $DataDir) {
    $dataTarget = Join-Path $BackupDir "data-$Stamp"
    try {
        & node (Join-Path $ScriptDir "backup-data.js") --keep $Keep
    } catch {
        Write-Host "[backup-data] FALHOU: $_"
    }
} else {
    Write-Host "[backup-data] pulado: $DataDir nao existe"
}

# ─── 3. Rotacao dos dumps SQL — manter ultimos $Keep ──────────────────
$dumps = Get-ChildItem -Path $BackupDir -Filter "db-*.sql" | Sort-Object Name
if ($dumps.Count -gt $Keep) {
    $toRemove = $dumps | Select-Object -First ($dumps.Count - $Keep)
    foreach ($f in $toRemove) {
        Remove-Item $f.FullName -Force
    }
    Write-Host "[backup-pg] rotacao: removidos $($toRemove.Count), mantidos $Keep"
}
