param([ValidateSet('employee', 'ticket')][string]$Service = 'employee')
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'ticket-service')
try {
    node setup-local.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Local setup failed' }
    node --env-file=.env server.mjs $Service
} finally { Pop-Location }
