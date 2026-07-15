# hy-workflow MCP

> 千江有水千江月，万里无云万里天。

让任何开发 agent 听话。

hy-workflow MCP 是一个项目级工作流守门员：把开发 agent 约束在"先读文档、先计划、等用户批准、锁定 scope、实现、同步文档、验证、提交、CI、合并、整理下游"的闭环里，减少跳步、乱改和把本地产物混进 PR 的机会。

## 安装与部署

先从 npm 全局安装两个 scoped 包，再进入任意 Git 项目根目录运行统一 setup TUI：

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest
hy-workflow setup
```

国内网络需要镜像时，安装命令可追加 `--registry=https://registry.npmmirror.com`。更新时重跑同一条 npm 安装命令，再运行 `hy-workflow setup`。只要求 Node.js >= 18；同一个 Node CLI 支持 Windows、macOS 和 Linux，不再依赖 Bash 或 PowerShell 安装脚本。

TUI 会提前检测 Codex、Claude Code、OpenCode，供用户多选，然后完成安装或更新。setup 没有部署模式选择：它固定创建或更新仓库中的 `hy-workflow.json` 和 `.github/workflows/hy-workflow.yml`，且不写其他项目产物。deployment、workflow state、scope lock、DocsGraph cache 和客户端 MCP 配置仍全部位于 OS 用户目录。

CI 或自动化可使用 `hy-workflow setup --yes --clients codex,claude,opencode --json`；预览用 `--dry-run`。任何时候可运行 `hy-workflow unset` 解除当前项目的本机部署；它不会删除团队维护的 `hy-workflow.json` 或 workflow。

Codex CLI 项目配置的期望态是直接运行已安装命令：

```toml
[mcp_servers.hy-workflow]
command = "hy-workflow"
startup_timeout_sec = 60
tool_timeout_sec = 300

[mcp_servers.docs-gardener]
command = "docs-gardener"
args = ["mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

## Workflow

首次接入项目时：

```text
setup TUI → restart client/MCP session → hy_init → hy_read_docs(before_plan) → hy_plan
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

MCP server 直接运行 npm 全局 bin，不依赖 GitHub、SSH 或每次启动时的在线安装：

```bash
hy-workflow
docs-gardener mcp
```

1. `hy_read_docs(before_plan)` 先读取项目文档，建立规划事实基线。没有被上下文捉到的东西，与不存在没有区别。
2. `hy_plan` 产出 scope、dependency DAG、验证命令、风险和取舍，并完整展示给用户。
3. 用户明确 approve 后，`hy_read_docs(before_approve)` 再审计一次 PlanDoc，确认事实没有偏移。
4. `hy_branch` 和 `hy_edit` 创建分支并锁定 scope，agent 只能改 PlanDoc 声明的文件。
5. 实现后先跑 `hy_read_docs(after_edit)` 和 `hy_sync_docs`，确认文档状态和实现 diff 对齐。
6. `hy_verify` 做完整 gate：lint、scope、boundary、platform、smoke、tests。
7. 验证通过后才进入 `hy_commit`、`hy_ci`、`hy_merge`、`hy_chain` 和 `hy_reset`。

`dev → main` 这类 promotion 是发布或晋级操作，不属于普通开发任务。agent 应先检查 `origin/main..origin/dev` diff，创建或复用 `base=main, head=dev` 的 PR，等待 CI 全绿后合并。

## 产物边界

仓库根目录的 `hy-workflow.json` 是统一且人工维护的项目配置源。团队字段放在 `project`：`baseBranch`、`codeExt`、`codeDirs`、`docsDir`。

项目内产物分三类：

`dist/` 是编译生成产物，不提交到仓库，也不上传为 GitHub Actions artifact 或 GitHub Release 附件。npm 发布 job 在临时 runner 中构建，并把 `dist/` 只放进 npm tarball；用户安装 registry 包时不运行本地编译。

| 类别 | 产物 | 规则 |
| --- | --- | --- |
| setup team artifacts | `hy-workflow.json`、`.github/workflows/hy-workflow.yml` | setup 固定且只维护这两项；通过独立 setup artifact sync PR 提交 |
| runtime/client artifacts | OS 用户目录中的 deployment/registry/state/cache、客户端用户级 MCP 配置 | 外置，不提交；unset 只清理当前项目拥有的这些登记 |
| legacy/compatibility artifacts | `.hy/`、`.opencode/`、`.codex/`、`.mcp.json`、`codelint.json`、`doclint.json`、`docs-gardener.json` | 不提交；compat JSON 仅在命令运行期临时生成并恢复，旧 config/manifest 只读兼容且不自动删除 |

setup 造成的两项仓库变化应单独创建 setup artifact sync PR，不要混入无关任务。除此之外，setup、unset 和 hy_init 都不得把运行时或客户端产物带入 tracked diff。

## 工具

| Tool | 作用 |
| --- | --- |
| `hy_init` | 校验用户目录中的 deployment 与根共享配置，初始化外置状态；不写项目或 `.git` |
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

`hy_verify` 包含本地任务 gate；setup 部署的 GitHub Actions workflow 必须执行 doclint、codelint 和项目验证：

```text
CI lint  → doclint + codelint + workflow-contract lint
compile  → 项目编译或类型检查
scope    → git diff 文件必须属于说好的范围内
boundary → entry_points 逐条执行
platform → 平台和运行环境检查
smoke    → 快速冒烟
tests    → 完整测试套件
```

如果本地 gate 失败，agent 回到 edit 修复后重新验证。只有本地 gate 通过，才允许 commit 并进入 CI；CI 继续强制执行完整 lint 和测试。`hy_ci` 在没有 checks 或只有 skipped/neutral checks 时 fail closed，不允许进入 merge。仓库管理员必须另外在 GitHub ruleset 或 branch protection 中把 workflow 的 Verify check 设为 required；setup 不越权修改仓库规则。

## 自举

本项目自身也使用 hy-workflow 管理。

## 许可

MIT

## Workflow contract lint

This repository validates its own agent-facing contract with `npm run lint:contract`. The rule set checks CLI and MCP tool parity, structured errors, output envelopes, workflow state, Skill references, artifact boundaries, and npm package sanity. Run `npm run verify` for build + contract lint + tests.
