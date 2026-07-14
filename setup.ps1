#!/usr/bin/env pwsh
# hy-workflow: Windows PowerShell compatibility entrypoint.
# The canonical bootstrap implementation is the bash setup script.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command hy-workflow -ErrorAction SilentlyContinue)) {
    throw "hy-workflow is not installed. Run: npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest"
}

& hy-workflow setup
exit $LASTEXITCODE
