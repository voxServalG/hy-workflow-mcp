# hy-workflow MCP

MCP server 强制 LLM 走 **9 阶段闭环工作流**。硬规则（状态机锁定 + lint 校验）和软规则（用户 approve gate + 自定义 rubrics）结合。

## 一键部署

在项目根目录执行：

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash
```

**Windows（Git Bash / WSL）**

```bash
curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash
```

**Windows（PowerShell）**

```powershell
iwr https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup -OutFile setup.sh; bash setup.sh; rm setup.sh
```

脚本会先部署 hy-harness 项目产物（`.github/`、`codelint.json`、`doclint.json`、`docs-gardener.json`），再输出一段文字——**原样发给你的 LLM agent**，由它完成项目级 MCP 配置（hy-workflow + docs-gardener）和 `hy_init`。

`hy_init` 只做 MCP-safe finalization：校验 harness 产物、写入/更新 workflow 规则、维护本地忽略项并初始化状态；它不会再次部署 hy-harness，也不会在 MCP 内启动交互式 TUI。

之后任何代码/文档任务，agent 自动走闭环。

`hy_init` 后，通常应提交项目配置：`.github/`、`AGENTS.md`、`codelint.json`、`doclint.json`、`docs-gardener.json`。
不要提交本地或运行时目录：`.hy/`、`.opencode/`；`hy_init` 会默认把它们写入 `.gitignore`。

## 闭环流程

```
hy_status → hy_plan → hy_approve → hy_branch → hy_edit → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain
             ↑                     ↑                    ↑           ↑           ↑
         (用户驳回)           (用户许可)          (verify fail)  (CI fail)    (下游分支)
```

## 10 个工具

| Tool | 阶段 | 硬规则 | 软规则 |
|------|------|--------|--------|
| `hy_init` | init | 校验 harness configs + CI workflows，写入 workflow rules | — |
| `hy_plan` | plan | 基线扫描 | LLM 生成 scope+boundary+verify+rubs |
| `hy_approve` | approve | phase 必为 plan | **用户许可 gate** |
| `hy_branch` | branch | 命名规范校验 | — |
| `hy_edit` | edit | 锁定 scope 边界 | LLM 编写代码 |
| `hy_verify` | verify | lint+scope+boundary+platform+smoke+tests | 自定义 rubrics |
| `hy_commit` | commit | verifyHash 校验 | PR 嵌入 plan 摘要 |
| `hy_ci` | ci | 轮询 GitHub Checks | — |
| `hy_merge` | merge | 全绿才放行 | — |
| `hy_chain` | chain | — | 下游 rebase |
| `hy_status` | 任意 | — | 返回当前 phase |

## verify 的 6 层校验

```
1. lint     → doclint + codelint（由 harness 定义）
2. scope    → git diff 文件 ⊆ plan.scope 声明
3. boundary → entry_points 逐条可导入
4. platform → pip install / venv 创建
5. smoke    → 快速冒烟（<5s）
6. tests    → 完整测试套件
```

## plan 数据结构

```typescript
{
  task: "拆分 cli.py",
  scope: {
    changes: ["cli.py"],
    new_files: ["cli_utils.ts", "cli_commands.ts"],
    delete: []
  },
  boundary: {
    dependency_dag: "cli_utils ← cli",
    entry_points: ["from magshield.cli import main"],
    no_new_external: true
  },
  verify: {
    platform: {
      python_version: "3.11",
      setup: ["python -m pip install -e ."]
    },
    smoke: [
      { command: "python -c 'from magshield.cli import main'", expected_exit: 0, description: "import OK" }
    ],
    tests: [
      { command: "pytest tests/ -v", expected_exit: 0, description: "all tests" }
    ]
  },
  risks: ["函数边界切错"],
  discussion: "依赖 DAG 无循环..."
}
```

## 系统提示

LLM 连接 MCP 时会自动注入以下约束：

- 🔒 必须按固定顺序调用工具
- ❌ 禁止直接使用 git checkout/commit/push/gh pr create
- ❌ 禁止跳过 hy_verify 调 hy_commit
- 👤 hy_plan 完成后必须等待用户 hy_approve

## 自举

本项目自身也用 hy-workflow 管理。运行态状态和 scope lock 写入 Git 私有目录 `.git/hy-workflow/`，不会进入业务 diff。

## 许可

MIT
