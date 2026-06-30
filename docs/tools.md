# Tools Reference

hy-workflow MCP server 注册了 15 个工具，定义在 `src/tools/` 中。分发逻辑在 `src/server.ts`。工具返回保留 legacy 字段，同时补充 agent-facing envelope；详见 [Tool Result Envelope](./tool-result-envelope.md)。

## 概览

| Tool | Phase 进入要求 | 参数 | 转换到 | 只读? |
|------|---------------|------|--------|-------|
| `hy_init`   | init | — | plan | 否 |
| `hy_read_docs` | plan, approve, edit, verify | `{stage, task?}` | plan / approve / edit | 否 |
| `hy_plan`   | plan | `{task}` | plan (返回 next=approve) | 否 |
| `hy_approve` | plan, approve | `{approved: string, note: string}` | branch (批准) / plan (驳回) | 否 |
| `hy_branch` | approve, branch | `{category, topic}` | edit | 否 |
| `hy_edit`   | branch, edit, verify | — | edit (返回 next=verify) | 否 |
| `hy_sync_docs` | edit, verify | — | edit (返回 next=verify) | 否 |
| `hy_verify` | edit, verify | — | commit (通过) / edit (失败) | 否 |
| `hy_amend_plan` | verify | `{approved, note?}` | edit / verify | 否 |
| `hy_commit` | commit | `{title, body}` | ci | 否 |
| `hy_ci`     | ci, edit | — | merge (全绿) / edit (失败) | 否 |
| `hy_merge`  | merge | — | chain | 否 |
| `hy_chain`  | chain | `{branches: string[]}` | done | 否 |
| `hy_reset`  | 任意 | — | plan | 否 |
| `hy_status` | 任意 | — | — | 是 |

## hy_init

验证 setup 已部署 bootstrap 产物（hy-workflow.json + 单一 CI workflow + setup stamp），写入/更新 `AGENTS.md` workflow 规则，清理旧 `.opencode/instructions.md` 规则片段，并幂等维护 `.gitignore` 中的本地运行态忽略项。`hy_init` 不会在 MCP 内执行 setup，也不会启动交互式 TUI。

- **进入 Phase**: `init`, `plan`
- **转换到**: `plan`
- **成功返回**: `{ next: "plan", message, display, commitArtifacts, localArtifacts, requiredSetupArtifacts, gitignoreChanged }`
- **失败返回**: `{ next: "init", error: { type: "setup_artifacts_missing", missingArtifacts }, requires_user: true, stop_here: true, recovery }`

`hy-workflow.json` 是配置源头；`codelint.json`、`doclint.json`、`docs-gardener.json` 是运行时兼容产物，不提交。`hy_init` 返回 `commitArtifacts`（`.github/`、`AGENTS.md`、`.gitignore`、`hy-workflow.json`）和 `localArtifacts`（`.hy/`、`.opencode/`、`.codex/`、`.mcp.json`、`codelint.json`、`doclint.json`、`docs-gardener.json`），并幂等确保 `.gitignore` 忽略本地产物。缺少核心 setup/bootstrap 产物（单一 CI workflow、`hy-workflow.json`、setup stamp）时，agent 必须停下并请用户在终端重新运行 setup。

如果这些 local/runtime artifacts 已经被 Git 跟踪，`hy_init` 成功返回但会额外给出 `trackedLocalArtifacts`，并在 display/hint 中提示把它们放进 setup artifact sync PR 里用 `git rm --cached -- <file...>` 从索引移除。这个提示用于迁移期清理，不会阻止进入 `plan`。

Artifact contract: setup/hy_init 产生的 tracked project artifacts 应通过 PR 提交，local/runtime artifacts 不提交。若运行 setup 后出现 tracked diff，应先做 setup artifact sync PR，不要混入无关任务。

## Session setup check

MCP runtime 每个进程首次处理任意 `hy_*` tool 前，会只读检查 `.git/hy-workflow/setup.json`。stamp 缺失或版本落后时返回完整 envelope：`ok: false`、当前 `phase`/`next`、`display`、`hint`、`requires_user: true`、`stop_here: true`、`allowedTools`、`blockedTools`、`recovery`。`error.message` 必须是人类可读的 setup refresh 说明，同时保留 `setup_update_required` subtype、版本和 stamp path 字段，不能把结构化对象序列化成 JSON 字符串。runtime 不会运行 setup、不写文件、不启动 TUI；用户需在终端运行 setup 并重启 agent/MCP session。

## Config CLI

`npx -y --prefer-online github:voxServalG/hy-workflow-mcp#main config --check --json` 会只读检查项目语言、目录和 `hy-workflow.json`；不一致时输出 envelope、`issues`、`project.evidence` 和已填好的 `suggestedCommand`。`config --apply-suggested --json` 或显式配置只写入 `hy-workflow.json`，并从既有兼容 JSON preserve-first 合并未知字段与 `catalogs`。运行旧 doclint/codelint CLI 时才会临时生成根目录兼容 JSON，执行后清理。

## hy_read_docs

自动读取 `hy-workflow.json` 的 `project.docsDir`，使用文档引用图（DocsGraph）驱动渐进式读取。`before_plan` 在 `hy_plan` 前建立规划事实基线，必须传 `task`；`before_approve` 在用户批准 PlanDoc 后、`hy_approve` 前产出 agent 侧文档审计；`after_edit` 在实现编辑后、`hy_sync_docs` 前审计当前实现 diff 与文档同步需求。三者都是自动 gate，不新增人类审核。

读取行为：从文档入口（`docs/index.md` 或自动检测的首个 `.md` 文件）出发，通过 markdown 内部链接引用图做 BFS 遍历，只读取与 task 关键字匹配的路径上的文档，不再对全量文档做 6000 chars 截断。每个文档的完整内容直接返回。文档引用图持久化在 `.git/hy-workflow/docs-graph.json`。

成功写入 `WorkflowState.documentReads`，失败仅在文档目录缺失、阶段错误或无可读文档时阻断。`documentReadHealth` 会把已有读取结果标记为 `missing`、`current` 或 `stale`；PlanDoc hash 或实现 digest 不匹配时，`hy_status` 会通过 `blockedBy` 和 `staleDocumentReads` 指出需要重跑的下游 gate；before_plan task 文案不一致只作为诊断信息。

## hy_plan

要求已存在 `before_plan` 文档事实基线。随后校验必填字段、scope 非空、boundary/verify/risks/discussion 有实质内容、禁止空洞命令；task/risks/discussion 过短仅作为 soft warning。成功写入新 PlanDoc 时会清空 `beforeApprove`、`afterEdit` 和 `syncDocs`，避免复用旧 gate。

成功返回的 `summary` 和 `display.body` 是给用户审批的友善摘要，不是 PlanDoc 内部字段直出。摘要保留稳定结构：Plan（现在状态、期望状态）、Scope（将要增加/改动/删除，格式为 path: reason）、Boundary（影响范围、外部依赖、关键检查入口）、Verify（测试平台搭建，以及单元测试、集成测试、系统测试、验收测试四层）、Risks、Discussion。其中“期望状态”描述 PlanDoc 应用后项目应呈现的行为、文档或验证状态，不应是审批摘要本身的固定说明。`plan` 字段仍保留完整 PlanDoc，供 agent 和兼容客户端读取。

- **进入 Phase**: `plan`
- **转换到**: `approve`
- **成功返回**: `{ next: "approve", plan, summary, display, requires_user: true, stop_here: true, allowedTools, blockedTools, message }`
- **失败返回**: `{ next: "plan", error, fallback: {message, schema} }`

## hy_approve

用户审视 PlanDoc 的入口。批准前要求已存在匹配当前 PlanDoc hash 的 `before_approve` 文档审计；该审计是 agent 自动步骤，不是新增人类审核。`approved` 必须传字符串 `"approve"` 才放行（严格匹配，同时容错 `"true"`）。其他任何内容视为驳回理由，回到 `plan`。

- **进入 Phase**: `approve`
- **批准后转换到**: `branch`，写入 Approval 记录
- **驳回后转换到**: `plan`
- **批准返回**: `{ next: "branch", approved: true, plan, pipeline, stopAfter: "hy_reset", allowedTools }`
- **驳回返回**: `{ next: "plan", approved: false, note }`

## hy_branch

创建 git 分支，格式 `{category}/{topic}`。category 必须在 `["refactor","feat","chore","docs","ci","fix","test"]` 中。分支从 `origin/<baseBranch>` 创建；如果该远程基准 ref 不存在，`hy_branch` 返回结构化 `config/config_invalid` 错误和 `BASE_BRANCH_REMOTE_MISSING` code，提示 fetch/push base branch 或修正 `hy-workflow.json: project.baseBranch`，而不是把 git fatal 暴露为 internal uncaught。

- **进入 Phase**: `approve`, `branch`
- **转换到**: `edit`
- **返回**: `{ next: "edit", branch, hint, allowedTools }` 或 `{ error, recovery }`

## hy_edit

锁定 scope 到 Git 私有状态文件 `.git/hy-workflow/scope.json`，避免 runtime metadata 污染工作区。workflow phase 本身也写入 Git 私有状态文件，不推进 Phase（手动设为 edit），返回 `next: "verify"`、`phase: "edit"` 提示 LLM 开始编写代码。

- **进入 Phase**: `branch`, `edit`, `verify`
- **转换到**: `transition(state, "edit")`，返回 `next: "verify"`
- **返回**: `{ next: "verify", phase: "edit", branch, scope, boundary, display, hint, allowedTools, blockedTools, message }`

## Legacy runtime metadata

旧版本可能在工作区留下 `.hy/workflow.json` 或 `.hy/scope.json`。当前版本会在迁移到 `.git/hy-workflow/` 后静默删除未被 Git 跟踪的 legacy runtime 文件，避免它们阻挡 `git checkout`。如果这些 legacy 文件已被 Git 跟踪，hy-workflow 不会自动删除；`hy_status` / `hy_init` 会返回 `legacyDiagnostics`，提示运行 `git rm --cached .hy/workflow.json .hy/scope.json` 并忽略 `.hy/`。

## hy_sync_docs

实现编辑后、最终验证前的文档同步 gate。要求已存在匹配当前 PlanDoc 的 `documentReads.afterEdit`，并记录 `syncDocs`，供 `hy_verify` 校验。工具不自动改写文档；agent 只能在 `plan.scope` 声明的文档或 setup prompt 文件内同步，再运行 `hy_verify`。

同步时增量维护文档引用图：只 re-parse 实际改动的文档文件来更新 `.git/hy-workflow/docs-graph.json`，并检测引用图中的坏链接（outgoing link 目标文件不存在的场景）。检测结果通过 `graphInfo` 字段返回。

- **进入 Phase**: `edit`, `verify`
- **转换到**: 保持 `edit`，返回 `next: "verify"`
- **返回**: `{ next: "verify", phase: "edit", synced, allowedDocs, display, hint }`

## hy_verify

执行本地任务 gate（compile、scope、boundary、platform、smoke、tests）。运行前要求 `hy_read_docs(after_edit)` 和 `hy_sync_docs` 已匹配当前 PlanDoc 与实现 diff。全部通过后计算 verifyHash 并转换到 commit。

- **进入 Phase**: `edit`, `verify`
- **通过后转换到**: `commit`
- **失败后转换到**: `edit`
- **通过返回**: `{ next: "commit", allPassed: true, checks, verifyHash, hint, allowedTools }`
- **失败返回**: `{ next: "edit", allPassed: false, hardFailed, checks, failedChecks, recovery.byLayer }`

## hy_amend_plan

`hy_verify` 返回 `amend_required` 时，用户明确批准后应用 pending scope amendment。该工具只处理 verifier 判断为安全的小范围 scope 修订，不替代 `hy_plan` 的人类审批。

- **进入 Phase**: `verify`
- **转换到**: `edit` / `verify`
- **返回**: `{ next, approved, amendment, allowedTools }`

## hy_commit

git add -A → commit → push → gh pr create。PR body 自动附加 scope/boundary/verify 元信息和 verifyHash。

- **进入 Phase**: `commit`
- **转换到**: `ci`
- **返回**: `{ next: "ci", prNumber, url, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

## hy_ci

通过 `gh pr view --json statusCheckRollup` 轮询 GitHub CI 状态。pending/unknown 时在工具内部 bounded polling，默认最多 600 秒、间隔 10 秒；可传 `timeoutSeconds` / `intervalSeconds` 覆盖。

- **进入 Phase**: `ci`, `edit`
- **全绿后转换到**: `merge`
- **失败后转换到**: `edit`（通过 transition(state, "edit") 并 writeState）
- **no checks**: GitHub 没有 reported checks 时转换到 `merge`，返回 `skipped: true`、`skipReason: "no_reported_checks"`、`noChecks: true`，用于表示 workflow 未命中而非 CI 失败或 pending
- **pending/API 异常**: polling 超时后保持 `ci`，等待后重试 `hy_ci`
- **返回**: 全绿 `{ next: "merge", allGreen: true, checks, display, hint }`；no checks `{ next: "merge", skipped: true, skipReason: "no_reported_checks", noChecks: true, checks: [] }`；pending `{ next: "ci", pending: true, requires_user: true, stop_here: true, recovery }`；失败 `{ next: "edit", failedChecks, requires_user: true, stop_here: true, recovery }`

## hy_merge

通过 `gh pr merge --merge --delete-branch` 合并 PR。

- **进入 Phase**: `merge`
- **转换到**: `chain`
- **返回**: `{ next: "chain", prNumber, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

---

## Promotion / release exception

`hy_branch` 和 `hy_commit` 固定围绕 `hy-workflow.json: project.baseBranch` 工作：普通开发分支从 `origin/<baseBranch>` 创建，并把 PR 合回 baseBranch。因此 baseBranch 到 releaseBranch 的 promotion（例如 dev → main）不是普通 hy-workflow 开发任务，不应伪造空 scope 或空 diff 来通过 `hy_verify`。

当用户明确要求 promotion 时，正确流程是确认 source/target，检查 `origin/<target>..origin/<source>` diff，创建或复用 `base=<target>, head=<source>` 的 promotion PR，等待 CI 全绿后合并。若需要直接调用 `gh` 或 `git`，必须先获得用户明确授权。

普通代码/文档改动仍必须走完整闭环；promotion 例外只能用于明确的 release branch 晋级。

## hy_chain

依次 checkout 每个下游分支 → rebase 到 `hy-workflow.json: project.baseBranch` 对应的最新基准分支 → force push → 切回基准分支。

- **进入 Phase**: `chain`
- **转换到**: `done`
- **返回**: `{ next: "done", done: [...完成的], message }`

---

## hy_status

只读工具，可任意阶段调用。返回当前 WorkflowState 快照。

- **进入 Phase**: 无限制
- **转换到**: 无（只读）
- **返回**: `{ phase, branch, prNumber, plan, approved, verified, next, hint, allowedTools, setupUpdateCheck, action? }`

## Related
[Architecture](./architecture.md) · [State Machine](./state-machine.md) · [Verify Pipeline](./verify.md)
