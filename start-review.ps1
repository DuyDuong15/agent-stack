$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path 'compose.review.local.json')) { throw 'Run setup-review.ps1 first.' }
    & "$PSScriptRoot\start-keycloak.ps1"
    docker compose --env-file ticket-service/.env -f compose.yaml -f compose.otel.yaml -f compose.review.local.json up -d --build --wait
    if ($LASTEXITCODE -ne 0) { throw 'Backend startup failed.' }
    & "$PSScriptRoot\start-openclaw.ps1"
    Write-Host 'Element: http://localhost:8080 | Jaeger: http://localhost:16686'
    Write-Host 'Passwords are in local-credentials.json and keycloak.local.json. Keep this terminal open.'
    & "$PSScriptRoot\start-chat.ps1"
} finally { Pop-Location }
