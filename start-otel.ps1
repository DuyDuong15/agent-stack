$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    node backup-backend.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Backup failed' }
    docker compose --env-file ticket-service/.env -f compose.yaml -f compose.otel.yaml up -d --build --wait
    if ($LASTEXITCODE -ne 0) { throw 'Tracing stack startup failed' }
    Write-Host 'Jaeger UI: http://localhost:16686'
} finally { Pop-Location }
