$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    node backup-backend.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Database backup failed' }
    docker compose --env-file ticket-service/.env up -d --build --wait
    if ($LASTEXITCODE -ne 0) { throw 'Backend startup failed' }
} finally { Pop-Location }
