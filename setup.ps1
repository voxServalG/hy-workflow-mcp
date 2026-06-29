#!/usr/bin/env pwsh
# hy-workflow: Windows PowerShell compatibility entrypoint.
# The canonical bootstrap implementation is the bash setup script.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SetupUrl = "https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup"

function Resolve-GitBash {
    $candidates = @()
    $cmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and ($cmd.Source -notlike "*\Windows\System32\bash.exe")) {
        $candidates += $cmd.Source
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "Git\bin\bash.exe")
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe")
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }
    return $null
}

$bash = Resolve-GitBash
if (-not $bash) {
    Write-Error "Git for Windows bash.exe was not found. Install Git for Windows, or open Git Bash/WSL and run: curl -fsSL $SetupUrl | bash"
    exit 1
}

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) {
    Write-Error "curl.exe was not found. Use Git Bash/WSL instead: curl -fsSL $SetupUrl | bash"
    exit 1
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hy-workflow-setup-" + [Guid]::NewGuid().ToString("N") + ".sh")
try {
    & $curl.Source -fsSL $SetupUrl -o $tmp
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    & $bash $tmp
    exit $LASTEXITCODE
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
