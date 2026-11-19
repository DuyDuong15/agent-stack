$ErrorActionPreference = 'Stop'
$env:NX_DAEMON = 'false'
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
$elementWebPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'element-web\apps\web'
Set-Location $PSScriptRoot
$containers = docker ps -a --format '{{.Names}}'
if ($containers -contains 'keycloak') {
    docker start keycloak
    if ($LASTEXITCODE -ne 0) { throw 'Cannot start Keycloak. Check Docker Desktop.' }
}
docker start synapse
if ($LASTEXITCODE -ne 0) { throw 'Cannot start Synapse. Check Docker Desktop.' }
npx --yes pnpm@12.18.0 --dir $elementWebPath start
