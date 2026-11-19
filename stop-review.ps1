$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path 'review.local.json')) { throw 'This directory was not created by setup-review.ps1.' }
    docker compose --env-file ticket-service/.env -f compose.yaml -f compose.otel.yaml -f compose.review.local.json stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop backend.' }
    docker stop openclaw-box keycloak synapse
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop all review containers.' }
    Write-Host 'Containers stopped; data retained. Press Ctrl+C in the Element terminal too.'
} finally { Pop-Location }
