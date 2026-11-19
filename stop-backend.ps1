Push-Location $PSScriptRoot
try { docker compose --env-file ticket-service/.env stop } finally { Pop-Location }
