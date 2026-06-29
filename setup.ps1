#!/usr/bin/env pwsh
# hy-workflow: one-command project setup (idempotent) — Windows PowerShell edition
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ┌──────────────────────────────────────┐"
Write-Host "  │  hy-workflow · 项目级 MCP 一键部署  │"
Write-Host "  └──────────────────────────────────────┘"
Write-Host ""

# ── helpers ──────────────────────────────────────────────────

$CREATED = [System.Collections.ArrayList]::new()
$SKIPPED = [System.Collections.ArrayList]::new()
$PASS = 0
$SKIP = 0

function _created($name) {
    [void]$CREATED.Add($name)
    $script:PASS++
    Write-Host "  ✓ $name (created)"
}
function _skipped($name) {
    [void]$SKIPPED.Add($name)
    $script:SKIP++
    Write-Host "  ○ $name (already exists, kept)"
}

# ── hy-harness (unified deploy engine) ──────────────────────

Write-Host "  ⏳ hy-harness ..."
try {
    npx --yes github:voxServalG/hy-harness
    if ($LASTEXITCODE -eq 0) {
        _created "hy-harness deployment"
    } else {
        Write-Host "  ✗ hy-harness exited with code $LASTEXITCODE. Ensure Node.js >= 18."
        exit 1
    }
} catch {
    Write-Host "  ✗ hy-harness failed. Ensure Node.js >= 18."
    exit 1
}

# ── MCP 配置检查（仅提醒，不改文件）─────────────────────────

$PROJECT_ROOT = $PWD.Path
$PROJECT_NAME = Split-Path $PROJECT_ROOT -Leaf

# ── Output the LLM prompt ────────────────────────────────────

Write-Host ""
Write-Host "  ═══════════════════════════════════════════════════"
Write-Host "  ✅  $PASS created, $SKIP kept · $PROJECT_NAME/"
Write-Host "  ═══════════════════════════════════════════════════"
Write-Host ""
Write-Host "  📋 请将以下文字发送给你的 LLM agent："
Write-Host "  ═══════════════════════════════════════════════════"
Write-Host ""
Write-Host "  ────── 复制以下内容发给 LLM ──────"
Write-Host ""
Write-Host "  请为项目 $PROJECT_NAME 配置 hy-workflow 和 docs-gardener MCP（项目级，非全局）。"
Write-Host ""
Write-Host "  1. 找到或创建项目根目录下的 MCP 配置文件："
Write-Host ""
Write-Host "      opencode     →  .opencode/opencode.json"
Write-Host "      Claude Dsktp →  .mcp.json"
Write-Host "      其他客户端   →  按其项目级 MCP 配置规范"
Write-Host ""
Write-Host "  2. 确保配置中包含以下两个 server 条目（若已有其他 MCP，追加合并）："
Write-Host ""
Write-Host '  {'
Write-Host '    "\$schema": "https://opencode.ai/config.json",'
Write-Host '    "mcp": {'
Write-Host '      "hy-workflow": {'
Write-Host '        "type": "local",'
Write-Host '        "command": ["npx", "-y", "--prefer-online", "github:voxServalG/hy-workflow-mcp"],'
Write-Host '        "enabled": true'
Write-Host '      },'
Write-Host '      "docs-gardener": {'
Write-Host '        "type": "local",'
Write-Host '        "command": ["npx", "-y", "--prefer-online", "github:voxServalG/docs-gardener", "mcp"],'
Write-Host '        "enabled": true'
Write-Host '      }'
Write-Host '    }'
Write-Host '  }'
Write-Host ""
Write-Host "  3. 配置完成后，调用 hy_init 初始化工作流状态。"
Write-Host ""
Write-Host "  4. 之后任何代码/文档任务自动走 9 阶段闭环："
Write-Host "     hy_plan → hy_approve → hy_branch → hy_edit → hy_verify"
Write-Host "     → hy_commit → hy_ci → hy_merge → hy_chain"
Write-Host ""
Write-Host "   ────── 复制结束 ──────"
Write-Host ""
Write-Host "   项目路径: $PROJECT_ROOT"
Write-Host ""
