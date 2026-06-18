# hy-workflow MCP

## Configuration Source

`hy-workflow.json` is the human-maintained source of truth for project workflow config.

Shared fields live under `project`: `baseBranch`, `codeExt`, `codeDirs`, and `docsDir`. Tool-private fields stay under their tool sections: `codelint.lintDirs`, `codelint.maxLines`, `doclint.maxLines`, and `docsGardener.catalogs`.

`codelint.json`, `doclint.json`, and `docs-gardener.json` are runtime compatibility artifacts. `setup` and `hy-workflow config --apply-suggested --json` keep `hy-workflow.json` as the only editable source; verification materializes compatibility JSON only when legacy CLIs need it.

Tracked project artifacts: `.github/`, `AGENTS.md`, `.gitignore`, `hy-workflow.json`.

Local/runtime/client artifacts: `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, and MCP client-local config. Do not commit them unless explicitly requested.

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

脚本会直接部署/更新项目 bootstrap 产物（`.github/workflows/hy-workflow.yml`、`hy-workflow.json`、`.git/hy-workflow/setup.json`），再输出一段文字——**原样发给你的 LLM agent**，由它完成项目级 MCP 配置（hy-workflow + docs-gardener）和 `hy_init`。已有 JSON 配置会 preserve-first 合并，不会把 Python 等项目配置重置成默认 TypeScript。

setup 输出的 prompt 会给出 OpenCode 的 `.opencode/opencode.json` 示例和 Codex 的 `.codex/config.toml` 项目级 TOML 示例。Codex 示例中 `hy-workflow` 是 required，`docs-gardener` 是非阻塞辅助。

`hy_init` 只做 MCP-safe finalization：校验 setup/bootstrap 产物、写入/更新 workflow 规则、维护本地忽略项并初始化状态；它不会运行 setup，也不会在 MCP 内启动交互式 TUI。MCP runtime 每个 session 首次调用会只读检查 setup stamp；缺失或过期时会提示用户重新运行 setup 并重启 agent。

之后任何代码/文档任务，agent 自动走闭环。

`hy_init` 后，通常应提交项目配置：`.github/`、`AGENTS.md`、`.gitignore`、`hy-workflow.json`。
不要提交本地或运行时目录：`.hy/`、`.opencode/`、`.codex/`、`.mcp.json`；`hy_init` 会默认把它们写入 `.gitignore`。如果运行 setup 后出现 tracked diff，先单独提交 setup artifact sync PR，再继续其他任务。

## 配置检测

`hy_init` 会只读检查项目形态和 JSON 配置。若检测到 Python 项目却配置为 `.ts` 等明显不一致，会返回完整 envelope、停止自动流程，并给出已填好的修复命令。

也可以直接运行：

```bash
npx -y --prefer-online github:voxServalG/hy-workflow-mcp config --check --json
npx -y --prefer-online github:voxServalG/hy-workflow-mcp config --apply-suggested --json
```

## 闭环流程

```
hy_status → hy_read_docs(before_plan) → hy_plan → hy_read_docs(before_approve) → hy_approve → hy_branch → hy_edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain
             ↑                     ↑                    ↑           ↑                                      ↑           ↑           ↑
         (用户驳回)           (用户许可)          (verify fail)  (实现后文档审计)                    (verify fail)  (CI fail)    (下游分支)
                                                                                                      ↳ hy_amend_plan（小范围 scope 修订）
```

`dev → main` 这类 promotion 是发布/晋级操作，不属于普通开发闭环。用户明确要求 promotion 时，应检查 `origin/main..origin/dev` diff，创建或复用 `base=main, head=dev` 的 PR，等待 CI 全绿后合并；若需要直接使用 `gh`/`git`，agent 必须先获得用户明确授权。

## 14 个工具

| Tool | 阶段 | 硬规则 | 软规则 |
|------|------|--------|--------|
| `hy_init` | init | 校验 setup configs + CI workflows，写入 workflow rules | — |
| `hy_read_docs` | plan/approve | plan 前建立文档事实基线；approve 前做 PlanDoc 文档审计 | agent 自动步骤，不新增人类审核 |
| `hy_plan` | plan | 基线扫描 | LLM 生成 scope+boundary+verify+rubs |
| `hy_approve` | approve | phase 必为 plan | **用户许可 gate** |
| `hy_branch` | branch | 命名规范校验 | — |
| `hy_edit` | edit | 锁定 scope 边界 | LLM 编写代码 |
| `hy_verify` | verify | lint+scope+boundary+platform+smoke+tests | 自定义 rubrics |
| `hy_amend_plan` | verify/edit | 只应用 pending amendment | 用户明确批准小范围 scope 修订 |
| `hy_commit` | commit | verifyHash 校验 | PR 嵌入 plan 摘要 |
| `hy_ci` | ci | 轮询 GitHub Checks | — |
| `hy_merge` | merge | 全绿才放行 | — |
| `hy_chain` | chain | — | 下游 rebase |
| `hy_status` | 任意 | — | 返回当前 phase |

## verify 的 6 层校验

```
1. lint     → doclint + codelint（由 setup 配置）
2. scope    → git diff 文件 ⊆ plan.scope 声明
3. boundary → entry_points 逐条 shell 执行
4. platform → pip install / venv 创建
5. smoke    → 快速冒烟（<5s）
6. tests    → 完整测试套件
```

`hy_verify` 会生成 implementation manifest（实际修改、新增、删除、未跟踪文件）。`hy_verify` 前必须已有匹配当前 PlanDoc 的 `hy_read_docs(after_edit)` 审计和 `hy_sync_docs` 记录；如果同步后又改了代码，需要重新跑 `hy_read_docs(after_edit) → hy_sync_docs → hy_verify`。如果失败只来自测试支撑文件或已批准目录内的新拆分文件，结果会返回 `amend_required` 和 `suggestedAmendment`，agent 需要展示给用户；用户明确批准后调用 `hy_amend_plan` 应用修订，再重新运行文档同步和验证流程。声明了但最终未修改的文件只是 warning，不阻断流程。

## 文档读取 gate

`hy_read_docs` 是 agent 自动调用的上下文 gate，不是新增人类审核。

- `before_plan`: 在 `hy_plan` 前读取 `hy-workflow.json` 的 `project.docsDir`，建立规划事实基线。目的包括把文档中的约束、术语、相关文件、未知点和验证期望放进上下文。
- `before_approve`: 在用户表达 approve 后、调用 `hy_approve` 前再次读取文档，并对当前 PlanDoc 做 agent 侧审计。目的包括发现事实偏移、scope 漏项、验证不足和风险缺失。若审计发现 PlanDoc 不可靠，agent 必须驳回并重新 `hy_plan`；若审计通过，agent 继续调用 `hy_approve`。

这两个阶段成功后不需要用户确认；只有最终 PlanDoc 仍由用户通过 `hy_approve` 审核。

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
    entry_points: ["python -c 'from magshield.cli import main'"],
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
