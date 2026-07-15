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
| `hy_ci`     | ci, edit | — | merge (有效 checks 全绿) / ci (缺失、无效或 pending) / edit (失败) | 否 |
| `hy_merge`  | merge | — | chain | 否 |
| `hy_chain`  | chain | `{branches: string[]}` | done | 否 |
| `hy_reset`  | 任意 | — | plan | 否 |
| `hy_status` | 任意 | — | — | 是 |

## hy_init

验证 OS 用户目录中的 deployment 和根 `hy-workflow.json`，并把 workflow state 初始化到 identity-scoped user state。`hy_init` 不写 `AGENTS.md`、`.gitignore`、工作树或 `.git`，也不会在 MCP 内启动 setup TUI。

- **进入 Phase**: `init`, `plan`
- **转换到**: `plan`
- **成功返回**: `{ next: "plan", message, display, commitArtifacts: [], localArtifacts, projectFilesChanged: [], allowedTools: ["hy_read_docs", "hy_status"] }`
- **失败返回**: `{ next: "init", error: { type: "setup_artifacts_missing", missingArtifacts }, requires_user: true, stop_here: true, recovery }`

`hy-workflow.json` 是唯一有效项目配置源。旧用户 config 和含 mode 的 deployment manifest 仅供 setup 只读迁移，不能让 hy_init 绕过缺失的根配置。缺少 deployment/root config 或版本过期时，agent 必须停下并请用户运行 `hy-workflow setup`。

旧 local/runtime artifacts 已被跟踪时仍返回诊断，但不会自动删除或改写。

Artifact contract: setup 固定且只维护 `hy-workflow.json` 和 `.github/workflows/hy-workflow.yml`，其变化单独走 artifact sync PR。unset/hy_init 不删除或改写团队文件；deployment/state/cache、客户端配置和 compatibility JSON 不提交。

## Session setup check

MCP runtime 每次处理任意 `hy_*` tool 前，都会检查 OS 用户 state 中该项目的 `deployment.json`。deployment 缺失或版本落后时返回完整 stop envelope 和 setup refresh 指引。runtime 不会自行运行 setup 或启动 TUI；用户需在终端运行 setup 并重启 agent/MCP session。

## Config CLI

`hy-workflow config --check --json` 会只读检查项目语言、目录和根 `hy-workflow.json`；异常时输出结构化 issues 并非零退出。`config --apply --json` 只覆盖显式字段并保留其余现有配置；`config --apply-suggested --json` 会应用完整检测建议。两者都在校验后写根配置。运行旧 doclint/codelint/docs-gardener CLI 时才临时生成根目录兼容 JSON，执行后恢复项目原状且不提交。

## hy_read_docs

自动读取 `hy-workflow.json` 的 `project.docsDir`，使用文档引用图（DocsGraph）驱动渐进式读取。`before_plan` 在 `hy_plan` 前建立规划事实基线，必须传 `task`；`before_approve` 在用户批准 PlanDoc 后、`hy_approve` 前产出 agent 侧文档审计；`after_edit` 在实现编辑后、`hy_sync_docs` 前审计当前实现 diff 与文档同步需求。三者都是自动 gate，不新增人类审核。

读取行为从 docsDir 入口沿 Markdown 引用图做 task-driven BFS。DocsGraph 持久化在 OS 用户 cache 的 identity-scoped `docs-graph.json`；内容或解析语义变化时重建。越界路径、外部 URL、代码块链接和 docsDir 外目标不会进入图，`AGENTS.md` 与 docs README 仍可作为 supplemental entry points。

成功写入 `WorkflowState.documentReads`，失败仅在文档目录缺失、阶段错误或无可读文档时阻断。`documentReadHealth` 会把已有读取结果标记为 `missing`、`current` 或 `stale`；PlanDoc hash、实现 digest 不匹配，或 `before_approve` 发现文档 digest / DocsGraph digest 相对 `before_plan` 已变化时，`hy_status` 会通过 `blockedBy` 和 `staleDocumentReads` 指出需要重跑或重建 PlanDoc 的下游 gate；before_plan task 文案不一致只作为诊断信息。

## hy_plan

要求已存在 `before_plan` 文档事实基线。随后校验 PlanDoc shape、scope 非空、所有 scope 路径必须是项目根内相对路径、`scope.changes` / `scope.delete` 指向项目内已存在路径、boundary/verify/risks/discussion 有实质内容、禁止空洞命令；`scope.new_files` 允许声明尚不存在的计划创建文件，但同样必须留在项目根内。malformed nested PlanDoc 会返回结构化错误并停在 `plan`，不会抛出未捕获异常。task/risks/discussion 过短仅作为 soft warning。成功写入新 PlanDoc 时会清空 `beforeApprove`、`afterEdit` 和 `syncDocs`，避免复用旧 gate。

成功返回的 `summary` 和 `display.body` 是给用户审批的友善摘要，不是 PlanDoc 内部字段直出。摘要保留稳定结构：Plan（现在状态、期望状态）、Scope（将要增加/改动/删除，格式为 path: reason）、Boundary（影响范围、外部依赖、关键检查入口）、Verify（测试平台搭建，以及单元测试、集成测试、系统测试、验收测试四层）、Risks、Discussion。其中“期望状态”描述 PlanDoc 应用后项目应呈现的行为、文档或验证状态，不应是审批摘要本身的固定说明。`plan` 字段仍保留完整 PlanDoc，供 agent 和兼容客户端读取。

- **进入 Phase**: `plan`
- **转换到**: `approve`
- **成功返回**: `{ next: "approve", plan, summary, display, requires_user: true, stop_here: true, allowedTools, blockedTools, message }`
- **失败返回**: `{ next: "plan", error, fallback: {message, schema} }`

## hy_approve

用户审视 PlanDoc 的入口。批准前要求已存在匹配当前 PlanDoc hash、且未发现文档 digest 相对 `before_plan` 漂移的 `before_approve` 文档审计；该审计是 agent 自动步骤，不是新增人类审核。`approved` 必须传字符串 `"approve"` 才放行。其他任何内容，包括 `"true"` 或 boolean true，均视为驳回理由，回到 `plan`。

- **进入 Phase**: `approve`
- **批准后转换到**: `branch`，写入 Approval 记录
- **驳回后转换到**: `plan`，不写入 Approval 记录，并清空 verify/manifest/sync 等下游派生状态
- **批准返回**: `{ next: "branch", approved: true, plan, pipeline, stopAfter: "hy_reset", allowedTools }`
- **驳回返回**: `{ next: "plan", approved: false, note }`

## hy_branch

创建 git 分支，格式 `{category}/{topic}`。category 必须在 `["refactor","feat","chore","docs","ci","fix","test"]` 中，topic 必须是 lowercase kebab-case。分支从 `origin/<baseBranch>` 创建；`baseBranch`、head branch 和 downstream branch 都必须是安全 Git ref，禁止空白、shell metacharacters、leading dash、`..`、`@{` 和 `.lock` suffix。所有 git/gh 调用使用 argv 执行，不通过 shell 拼接参数。若远程基准 ref 不存在，`hy_branch` 返回结构化 `config/config_invalid` 错误和 `BASE_BRANCH_REMOTE_MISSING` code，提示 fetch/push base branch 或修正 `hy-workflow.json: project.baseBranch`，而不是把 git fatal 暴露为 internal uncaught。

- **进入 Phase**: `approve`, `branch`
- **转换到**: `edit`
- **返回**: `{ next: "edit", branch, hint, allowedTools }` 或 `{ error, recovery }`

## hy_edit

锁定 scope 到 OS 用户 state 的 identity-scoped `scope.json`，workflow phase 也写入用户 state；不污染工作区或 `.git`。

- **进入 Phase**: `branch`, `edit`, `verify`
- **转换到**: `transition(state, "edit")`，返回 `next: "verify"`
- **返回**: `{ next: "verify", phase: "edit", branch, scope, boundary, display, hint, allowedTools, blockedTools, message }`

## Legacy runtime metadata

旧版本可能在 `.git/hy-workflow/` 或工作区 `.hy/` 留下 state/scope。当前版本只在外置文件缺失时复制读取，不自动删除任何 legacy 文件；跟踪异常仍通过 `legacyDiagnostics` 报告。

## hy_sync_docs

实现编辑后、最终验证前的文档同步 gate。要求已存在匹配当前 PlanDoc 的 `documentReads.afterEdit`，并记录 `syncDocs`，供 `hy_verify` 校验。工具不自动改写文档；agent 只能在 `plan.scope` 声明的文档或团队 workflow/template 文件内同步，再运行 `hy_verify`。

同步时增量更新用户 cache 中的 DocsGraph 并检测坏链接；结果通过 `graphInfo` 返回。docsDir membership 使用规范化路径边界判断。

- **进入 Phase**: `edit`, `verify`
- **转换到**: 保持 `edit`，返回 `next: "verify"`
- **返回**: `{ next: "verify", phase: "edit", synced, allowedDocs, display, hint }`

## hy_verify

执行本地任务 gate（compile、scope、boundary、platform、smoke、tests）。运行前要求 `hy_read_docs(after_edit)` 和 `hy_sync_docs` 已匹配当前 PlanDoc 与实现 diff。全部通过后记录当前 implementation manifest、manifest hash、文件内容 digest 和 verifyHash，并转换到 commit。

- **进入 Phase**: `edit`, `verify`
- **通过后转换到**: `commit`
- **失败后转换到**: `edit`
- **通过返回**: `{ next: "commit", allPassed: true, checks, verifyHash, hint, allowedTools }`
- **失败返回**: `{ next: "edit", allPassed: false, hardFailed, checks, failedChecks, recovery.byLayer }`

## hy_amend_plan

`hy_verify` 返回 `amend_required` 时，用户明确批准后应用 pending scope amendment。该工具只处理 verifier 判断为安全的小范围 scope 修订，不替代 `hy_plan` 的人类审批。应用前会校验 pending amendment shape、所有增删路径仍在项目根内；应用后会重新校验 PlanDoc scope 非空、`changes/delete` 仍指向已存在路径，并写入与 `hy_edit` 相同结构的用户 state scope lock。

- **进入 Phase**: `verify`
- **转换到**: `edit` / `verify`
- **返回**: `{ next, approved, amendment, allowedTools }`

## hy_commit

`hy_commit` 先用 `git status --porcelain -z` 在 PlanDoc scope 内筛出当前真实差异，再执行 git add → commit → push → gh pr create。已在前一次提交中删除的 `scope.delete` 路径不会在 CI 修复后的后续提交中重复传给 `git add`；没有真实 scope 差异时返回 `NO_SCOPED_CHANGES`，不创建空提交。提交前仍执行安全 preflight：当前 Git 分支必须等于 `WorkflowState.branch`，当前 implementation manifest、内容 digest 和 verifyHash 必须与 `hy_verify` 记录一致。`hy_commit` 全程使用 argv 传参，并在 `data.executor` 中分别报告 commit、push 和 createPr 使用的执行器。

PR body 自动附加 scope/boundary/verify 元信息、verifyHash、planHash，并在 `Raw PlanDoc JSON` 折叠区写入 `hy_commit` 当下的完整 `WorkflowState.plan` JSON 备查。该 PlanDoc 快照在 PR 创建前生成，因此会保留当时的 runtime 字段状态；PR number 写回状态发生在 GitHub PR 创建成功之后，不反向改写 PR body。

- **进入 Phase**: `commit`
- **转换到**: `ci`
- **返回**: `{ next: "ci", prNumber, url, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

## hy_ci

通过已安装且已认证的 `gh pr view --json statusCheckRollup` 轮询 GitHub CI 状态，并在 `data.executor` 报告本次 `gh` 能力。`WorkflowState.prNumber` 必须是正整数；损坏或被注入字符串的运行态会被结构化拒绝，不会传给 `gh`。pending/unknown 时在工具内部 bounded polling，默认最多 600 秒、间隔 10 秒；可传 `timeoutSeconds` / `intervalSeconds` 覆盖。

- **进入 Phase**: `ci`, `edit`
- **全绿后转换到**: `merge`
- **失败后转换到**: `edit`（通过 transition(state, "edit") 并 writeState）
- **缺失/无有效 checks**: GitHub 没有 reported checks，或全部 checks 为 skipped/neutral 时保持 `ci`，返回 `error.code: "CI_CHECKS_REQUIRED"`、`requires_user: true`、`stop_here: true` 并阻止 `hy_merge`
- **pending/API 异常**: polling 超时后保持 `ci`，等待后重试 `hy_ci`
- **返回**: 全绿 `{ next: "merge", allGreen: true, checks, display, hint }`；缺失/无有效 checks `{ next: "ci", allGreen: false, noChecks?, noEffectiveChecks?, error, requires_user: true, stop_here: true, recovery }`；pending `{ next: "ci", pending: true, requires_user: true, stop_here: true, recovery }`；失败 `{ next: "edit", failedChecks, requires_user: true, stop_here: true, recovery }`

setup 生成的 workflow 必须执行 doclint 与 codelint。仓库管理员需在 GitHub ruleset 或 branch protection 中把 Verify check 设为 required；这是管理员动作，setup 不越权配置。

## hy_merge

通过已安装且已认证的 `gh pr merge --merge --delete-branch` 合并 PR，并在 `data.executor` 报告执行器。PR number 必须是正整数，并通过 argv 传给 `gh`；损坏运行态不会被当作命令片段执行。

- **进入 Phase**: `merge`
- **转换到**: `chain`
- **返回**: `{ next: "chain", prNumber, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

---

## Promotion / release exception

`hy_branch` 和 `hy_commit` 固定围绕 `hy-workflow.json: project.baseBranch` 工作：普通开发分支从 `origin/<baseBranch>` 创建，并把 PR 合回 baseBranch。因此 baseBranch 到 releaseBranch 的 promotion（例如 dev → main）不是普通 hy-workflow 开发任务，不应伪造空 scope 或空 diff 来通过 `hy_verify`。

当用户明确要求 promotion 时，正确流程是确认 source/target，检查 `origin/<target>..origin/<source>` diff，创建或复用 `base=<target>, head=<source>` 的 promotion PR，等待 CI 全绿后合并。若需要直接调用 `gh` 或 `git`，必须先获得用户明确授权。

普通代码/文档改动仍必须走完整闭环；promotion 例外只能用于明确的 release branch 晋级。

## hy_chain

通过本机 `git` 依次 checkout 每个下游分支 → rebase 到 `hy-workflow.json: project.baseBranch` 对应的最新基准分支 → force push → 切回基准分支。每个结果在 `data.executor` 报告实际能力；checkout、pull、rebase 和 pushForce 失败会立即返回结构化错误并保留已完成列表。分支参数必须是安全 Git ref，并通过 argv 传给 git。

- **进入 Phase**: `chain`
- **转换到**: `done`
- **返回**: `{ next: "done", done: [...完成的], message }`

---

## hy_reset

可任意阶段调用，回到 `plan` 并清空 plan、approval、branch、PR、verifyHash、pending amendment、implementation manifest、document reads 和 syncDocs 等 workflow 派生状态。该工具要求当前目录在真实 Git worktree 内；找不到项目根时返回 `PROJECT_ROOT_NOT_FOUND`，不会创建伪 `.git/hy-workflow`。

## hy_status

只读工具，可任意阶段调用。返回当前 WorkflowState 快照。损坏的 workflow.json 会通过结构化 workflow state 错误返回，而不是暴露原始 JSON parse 异常。

- **进入 Phase**: 无限制
- **转换到**: 无（只读）
- **返回**: `{ phase, branch, prNumber, plan, approved, verified, next, hint, allowedTools, setupUpdateCheck, capabilities, action? }`；`capabilities` 包含启动时探测到的 git、gh 版本与 gh 认证状态，内部后端明确标为不可用。

## Related
[Architecture](./architecture.md) · [State Machine](./state-machine.md) · [Verify Pipeline](./verify.md)
