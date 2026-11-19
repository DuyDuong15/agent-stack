$ErrorActionPreference = 'Stop'
$serviceDir = Join-Path $PSScriptRoot 'ticket-service'
$mcpDir = Join-Path $PSScriptRoot 'mcp-ping'
$connection = Get-NetTCPConnection -State Listen -LocalPort 8012 | Select-Object -First 1
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
if ($target.Name -ne 'node.exe' -or $target.CommandLine -notmatch 'server\.mjs\s+ticket') { throw 'Port 8012 is not the expected Ticket API; refusing to stop it.' }
$nodeBinary = (Get-Command node).Source
$previousQuestion = $env:DEMO_QUESTION
try {
    Stop-Process -Id $target.ProcessId
    $env:DEMO_QUESTION = 'Call the tool now for statistics of ALL tickets, with no filters. Do not use old results. If the service fails, report the failure instead of saying no tickets exist. Reply in Vietnamese.'
    Push-Location $mcpDir
    try { node matrix-ticket-demo.mjs } finally { Pop-Location }
} finally {
    $env:DEMO_QUESTION = $previousQuestion
    Start-Process -FilePath $nodeBinary -ArgumentList '--env-file=.env','server.mjs','ticket' -WorkingDirectory $serviceDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $serviceDir 'ticket-runtime.log') -RedirectStandardError (Join-Path $serviceDir 'ticket-runtime-error.log')
    Write-Output 'Ticket API restart requested on port 8012.'
}
