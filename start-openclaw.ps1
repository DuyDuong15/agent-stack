$ErrorActionPreference = 'Stop'
docker start synapse
if ($LASTEXITCODE -ne 0) { throw 'Cannot start Synapse' }
docker start openclaw-box
if ($LASTEXITCODE -ne 0) { throw 'Cannot start OpenClaw container' }
node "$PSScriptRoot\sync-bot-rules.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Cannot sync onboarding bot rules' }
docker exec openclaw-box openclaw config validate
if ($LASTEXITCODE -ne 0) { throw 'Invalid OpenClaw configuration' }
docker exec openclaw-box pgrep -f '^openclaw-gateway$' | Out-Null
if ($LASTEXITCODE -ne 0) {
    docker exec -d openclaw-box sh -c 'openclaw gateway run > /tmp/openclaw.log 2>&1'
}
Write-Host 'Gateway starting. View logs: docker exec openclaw-box tail -f /tmp/openclaw.log'
