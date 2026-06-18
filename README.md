# hy-workflow MCP

> 千江有水千江月，万里无云万里天。

让任何开发 agent 听话。

hy-workflow MCP 是一个项目级工作流守门员：把开发 agent 约束在“先读文档、先计划、等用户批准、锁定 scope、实现、同步文档、验证、提交、CI、合并、整理下游”的闭环里，减少跳步、乱改和把本地产物混进 PR 的机会。

## 一键部署

在项目根目录执行同一条 Bash 命令：

```bash
curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash
```

macOS、Linux、Windows Git Bash / WSL 都使用这条命令。Windows PowerShell 用户请先进入 Git Bash 或 WSL，再执行同一条 Bash 命令。

脚本会部署或更新项目 bootstrap 产物，然后输出一段 setup prompt。把这段 prompt 原样交给开发 agent，agent 会完成项目级 MCP 配置和 `hy_init`。

## Workflow

首次接入项目时：

```text
setup → agent receives setup prompt → hy_init → hy_plan
```

后续每个代码或文档任务都走同一个闭环：

```text
hy_status
→ hy_read_docs(before_plan)
→ hy_plan
→ hy_read_docs(before_approve)
→ hy_approve
→ hy_branch
→ hy_edit
→ hy_read_docs(after_edit)
→ hy_sync_docs
→ hy_verify
→ hy_commit
→ hy_ci
→ hy_merge
→ hy_chain
→ hy_reset
```

这个流程的重点很简单：

1. `hy_read_docs(before_plan)` 先读取项目文档，建立规划事实基线。
2. `hy_plan` 产出 scope、dependency DAG、验证命令、风险和取舍，并完整展示给用户。
3. 用户明确 approve 后，`hy_read_docs(before_approve)` 再审计一次 PlanDoc，确认事实没有偏移。
4. `hy_branch` 和 `hy_edit` 创建分支并锁定 scope，agent 只能改 PlanDoc 声明的文件。
5. 实现后先跑 `hy_read_docs(after_edit)` 和 `hy_sync_docs`，确认文档状态和实现 diff 对齐。
6. `hy_verify` 做完整 gate：lint、scope、boundary、platform、smoke、tests。
7. 验证通过后才进入 `hy_commit`、`hy_ci`、`hy_merge`、`hy_chain` 和 `hy_reset`。

`dev → main` 这类 promotion 是发布或晋级操作，不属于普通开发任务。agent 应先检查 `origin/main..origin/dev` diff，创建或复用 `base=main, head=dev` 的 PR，等待 CI 全绿后合并。

## 产物边界

`hy-workflow.json` 是人工维护的唯一项目配置源头。共享字段放在 `project`：`baseBranch`、`codeExt`、`codeDirs`、`docsDir`。

项目内产物分三类：

| 类别 | 产物 | 规则 |
| --- | --- | --- |
| tracked project artifacts | `.github/`、`AGENTS.md`、`.gitignore`、`hy-workflow.json` | 应提交，代表项目协作契约 |
| compatibility artifacts | `codelint.json`、`doclint.json`、`docs-gardener.json` | 由 `hy-workflow.json` 派生，setup / verify 按需维护，不作为人工配置源头 |
| local/runtime/client artifacts | `.hy/`、`.opencode/`、`.codex/`、`.mcp.json`、MCP 客户端本地配置 | 不应提交，只属于本地运行环境 |

如果 setup 造成 tracked artifact drift，应单独创建 setup artifact sync PR，不要混入无关功能、修复或文档任务。

## 工具

| Tool | 作用 |
| --- | --- |
| `hy_init` | 校验 setup 产物，写入或更新 workflow 规则，初始化状态 |
| `hy_status` | 查看当前 workflow phase |
| `hy_read_docs` | 在 plan、approve、edit 后读取文档并做事实对齐 |
| `hy_plan` | 生成 PlanDoc，声明 scope、边界、验证、风险和取舍 |
| `hy_approve` | 用户批准 gate |
| `hy_branch` | 创建符合规范的任务分支 |
| `hy_edit` | 锁定 scope，允许 agent 开始编辑 |
| `hy_sync_docs` | 确认文档同步 gate |
| `hy_verify` | 执行 lint、scope、boundary、platform、smoke、tests |
| `hy_amend_plan` | 在用户批准后小范围修订 PlanDoc scope |
| `hy_commit` | git add、commit、push 并创建 PR |
| `hy_ci` | 轮询 GitHub Checks |
| `hy_merge` | CI 全绿后合并 PR |
| `hy_chain` | rebase 下游分支 |
| `hy_reset` | PR 合并后回到 plan 阶段 |

## 验证

`hy_verify` 包含 7 层 gate：

```text
1. lint     → doclint + codelint
2. compile  → 项目编译或类型检查
3. scope    → git diff 文件必须属于 PlanDoc scope
4. boundary → entry_points 逐条执行
5. platform → 平台和运行环境检查
6. smoke    → 快速冒烟
7. tests    → 完整测试套件
```

如果 verify 失败，agent 回到 edit 修复后重新验证。只有 verify 通过，才允许 commit 和进入 CI。

## 自举

本项目自身也用 hy-workflow 管理。运行态状态和 scope lock 写入 Git 私有目录 `.git/hy-workflow/`，不会进入业务 diff。

## 许可

MIT
