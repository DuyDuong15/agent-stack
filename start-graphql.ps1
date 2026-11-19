$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'ticket-service')
try {
    node setup-local.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Local setup failed' }
    node --env-file=.env graphql-server.mjs
} finally { Pop-Location }
