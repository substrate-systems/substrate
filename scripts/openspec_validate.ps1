# OpenSpec validation script for pre-push hook and CI
# Runs from repo root via lefthook or npm script

$ErrorActionPreference = "Stop"

# Ensure we're at repo root
$repoRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not in a git repository"
    exit 1
}
Push-Location $repoRoot

try {
    # Check for bypass
    if ($env:OPENSPEC_BYPASS -eq "1") {
        Write-Warning "OPENSPEC_BYPASS=1 detected. Skipping validation."
        Write-Warning "Only use bypass for non-behavior changes (docs, formatting, etc.)"
        exit 0
    }

    # Run validation via npm (uses repo-local openspec)
    Write-Host "Running OpenSpec validation..." -ForegroundColor Cyan
    npm run -s openspec:validate
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        Write-Error "OpenSpec validation failed. Fix errors or set OPENSPEC_BYPASS=1 for emergency bypass."
        exit $exitCode
    }

    Write-Host "OpenSpec validation passed." -ForegroundColor Green
    exit 0
}
finally {
    Pop-Location
}
