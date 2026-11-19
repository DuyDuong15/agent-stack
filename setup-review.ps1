param([switch]$Check)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if ($Check) { node setup-review.mjs --check; exit $LASTEXITCODE }
    node setup-review.mjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Preflight failed. No setup changes were made.' }
    if (-not (Test-Path 'review.local.json')) {
        $secretInput = Read-Host 'OpenAI API key (hidden, stored only on this machine)' -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretInput)
        try { $env:REVIEW_OPENAI_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    node setup-review.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Setup stopped. Fix the reported problem, then run setup-review.ps1 again.' }
} finally {
    Remove-Item Env:REVIEW_OPENAI_KEY -ErrorAction SilentlyContinue
    Pop-Location
}
