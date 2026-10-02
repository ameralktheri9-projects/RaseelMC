# Raseel MC - nightly database backup (NF-05)
#
# The whole database is one SQLite file (data/raseel-mc.db), so backup is just
# copying it with a timestamp. Keeps the last 30 daily backups.
#
# To schedule this nightly on Windows:
#   Open Task Scheduler -> Create Task -> Trigger: Daily at e.g. 01:30 ->
#   Action: Start a program -> powershell.exe
#   Arguments: -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\raseel-mc\scripts\backup-db.ps1"

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DbPath = Join-Path $ProjectRoot "data\raseel-mc.db"
$BackupDir = Join-Path $ProjectRoot "data\backups"
$RetentionDays = 30

if (-not (Test-Path $DbPath)) {
    Write-Error "Database not found at $DbPath"
    exit 1
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$backupPath = Join-Path $BackupDir "raseel-mc-$timestamp.db"

# SQLite's WAL mode means a plain file copy while the app is running can miss
# very recent writes still in the -wal file; copy it alongside for safety.
Copy-Item $DbPath $backupPath
if (Test-Path "$DbPath-wal") {
    Copy-Item "$DbPath-wal" "$backupPath-wal" -ErrorAction SilentlyContinue
}

Write-Output "Backed up to $backupPath"

# Prune backups older than the retention window.
Get-ChildItem $BackupDir -Filter "raseel-mc-*.db*" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
    Remove-Item -Force

Write-Output "Backup complete. Retained backups from the last $RetentionDays days."
