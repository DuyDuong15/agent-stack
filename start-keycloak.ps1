$ErrorActionPreference = 'Stop'
docker start keycloak
if ($LASTEXITCODE -ne 0) { throw 'Run node setup-keycloak.mjs for first-time setup.' }
Write-Host 'Keycloak: http://localhost:8180 (startup may take a moment)'
