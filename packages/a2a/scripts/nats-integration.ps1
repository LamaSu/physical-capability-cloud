# packages/a2a/scripts/nats-integration.ps1
#
# Windows PowerShell sibling of nats-integration.sh. Brings up a single-
# container NATS JetStream server via docker compose, waits for healthy,
# runs the @pcc/a2a integration suite with NATS_INTEGRATION=1, then tears
# down via a try/finally regardless of test outcome.
#
# Usage:
#   pwsh packages/a2a/scripts/nats-integration.ps1
# or via the package script (works cross-platform through pnpm):
#   pnpm --filter @pcc/a2a test:nats
#
# Requirements: docker compose v2, PowerShell 7+ (`pwsh`).

[CmdletBinding()]
param(
    [string]$NatsHttpUrl = "http://localhost:8222/healthz?js-enabled-only=true",
    [int]$WaitTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgDir = Resolve-Path (Join-Path $ScriptDir "..")
$ComposeFile = Join-Path $PkgDir "docker-compose.nats.yml"

Write-Host "[nats-integration] compose file: $ComposeFile"
Write-Host "[nats-integration] healthcheck:  $NatsHttpUrl"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "[nats-integration] ERROR: docker not found in PATH"
    exit 127
}

function Stop-NatsContainer {
    Write-Host "[nats-integration] tearing down NATS container..."
    # Suppress noisy output and any error from teardown — best-effort cleanup.
    & docker compose -f $ComposeFile down -v --remove-orphans *> $null
}

try {
    Write-Host "[nats-integration] starting NATS JetStream..."
    & docker compose -f $ComposeFile up -d
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up failed (exit $LASTEXITCODE)"
    }

    Write-Host "[nats-integration] waiting for healthy (up to ${WaitTimeoutSeconds}s)..."
    $deadline = (Get-Date).AddSeconds($WaitTimeoutSeconds)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $NatsHttpUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        } catch {
            # Not ready yet; swallow and retry.
        }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) {
        Write-Host "[nats-integration] ERROR: NATS did not become healthy within ${WaitTimeoutSeconds}s"
        & docker compose -f $ComposeFile logs --tail=200 nats
        exit 1
    }
    Write-Host "[nats-integration] NATS healthy."

    Write-Host "[nats-integration] running integration suite (NATS_INTEGRATION=1)..."
    Push-Location $PkgDir
    try {
        $env:NATS_INTEGRATION = "1"
        & pnpm test -- nats-backend
        $testExit = $LASTEXITCODE
    } finally {
        Remove-Item Env:NATS_INTEGRATION -ErrorAction SilentlyContinue
        Pop-Location
    }

    Write-Host "[nats-integration] suite exit code: $testExit"
    exit $testExit
}
finally {
    Stop-NatsContainer
}
