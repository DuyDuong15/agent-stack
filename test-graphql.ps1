$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'ticket-service')
try { node --env-file=.env demo-graphql.mjs } finally { Pop-Location }
