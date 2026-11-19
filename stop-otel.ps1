Push-Location $PSScriptRoot
try { docker compose --env-file ticket-service/.env -f compose.yaml -f compose.otel.yaml stop } finally { Pop-Location }
