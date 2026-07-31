# Tools Reference

hy-workflow MCP server 注册了 15 个工具，定义在 `src/tools/` 中。分发逻辑在 `src/server.ts`。工具返回保留 legacy 字段，同时补充 agent-facing envelope；详见 [Tool Result Envelope](./tool-result-envelope.md)。

## 概览

| Tool | Phase 进入要求 | 参数 | 转换到 | 只读? |
|------|---------------|------|--------|-------|
| `hy_init`   | init | — | plan | 否 |
| `hy_read_docs` | plan, approve, edit, verify | `{stage, task?, cursor?}` | plan / approve / edit | 否 |
| `hy_plan`   | plan | `{task}` | plan (返回 next=approve) | 否 |
| `hy_approve` | plan, approve | `{approved: string, note: string}` | branch (批准) / plan (驳回) | 否 |
| `hy_branch` | approve, branch | `{category, topic}` | edit | 否 |
| `hy_edit`   | branch, edit, verify | — | edit (返回 next=verify) | 否 |
| `hy_sync_docs` | edit, verify | — | edit (返回 next=verify) | 否 |
| `hy_verify` | edit, verify | — | commit (通过) / edit (失败) | 否 |
| `hy_exam_plan` | edit, verify | — | verify (异步 verify 出题) | 否 |
| `hy_exam_submit` | edit, verify | `{examId, results[]}` | commit (阅卷通过) / edit (失败补交) | 否 |
| `hy_amend_plan` | verify | `{approved, note?}` | edit / verify | 否 |
| `hy_commit` | commit | `{title, body}` | merge（commit.ci 全绿）/ commit（等待）/ edit（失败） | 否 |
| `hy_merge`  | merge | — | done（当前 handler 完成远端确认和安全下游同步）/ merge（恢复或人工处理） | 否 |
| `hy_reset`  | 任意 | — | plan | 否 |
| `hy_status` | 任意 | — | — | 是 |

## hy_init

`hy_init` 的 authority 只有当前选中的配置和外置 state。setup 只产生两个 fresh artifact：`hy-workflow.json` 与 `.github/workflows/hy-workflow.yml`。`hy_init` 检查可解析的 `project.baseBranch` 与非空文档事实，然后把 workflow state 初始化到 identity-scoped user state；它不写工作树或 `.git`，也不会在 MCP 内启动 setup TUI。

- **进入 Phase**: `init`, `plan`
- **转换到**: `plan`
- **成功返回**: `{ next: "plan", message, display, commitArtifacts: [], localArtifacts, projectFilesChanged: [], allowedTools: ["hy_read_docs", "hy_status"] }`
- **失败返回**: `{ next: "init", error: { type: "setup_artifacts_missing", missingArtifacts }, requires_user: true, stop_here: true, recovery }`

`hy-workflow.json` 是唯一有效项目配置源，根配置必须显式包含 runtime 必填字段。旧项目注入物不被读取、哈希、校验、设为 gate、迁移、重写、移动或删除，也不会产生 runtime copy 或 diagnostic。缺少当前配置、两个 fresh artifact、有效 ref、文档或实质事实时返回结构化 stop envelope。

Artifact contract: setup 只维护根 `hy-workflow.json` 和 `.github/workflows/hy-workflow.yml`。deployment/state/cache 与客户端配置不提交。

## Session setup check

MCP runtime 每次处理任意 `hy_*` tool 前都会检查当前选中的 identity-scoped deployment、配置、外置 state 与两个 fresh artifact。这个轻量 live check 不递归启动 MCP handshake。当前 authority 缺失或损坏时会 stop；runtime 不会自行运行 setup 或启动 TUI。

## Config CLI

`hy-workflow config --check --json` 会只读检查当前选中的配置、origin HEAD/current/conventional refs、语言扩展和真实目录 casing；mixed、unknown、非 conventional branch 或其他低置信 Git 推断必须显式确认。`project.codeExt` 可保留多扩展；可选 `ci.commands` 必须是已确认的非空单行数组，preserve-first apply 不改写人工值。

## hy_read_docs

自动读取 `project.docsDir`，使用 DocsGraph 和 task relevance 建立有界事实页。`before_plan` 必须传 `task`；`before_approve` 审计 PlanDoc；`after_edit` 审计实现 diff。结果最多 12 files、48,000 chars、每文件 12,000 chars并报告 token estimate；`pagination.hasMore/nextCursor` 可继续同一 stage/task，三者仍是自动 gate。

DocsGraph 全量索引只在 OS 用户 cache 保存 digest/links；读取优先 docsDir 根部大小写无关的 `index`/`README`（含 RST），再按 task 排序。`node_modules`、examples、fixtures、generated、build/vendor 等目录，越界目标、外链和代码块链接均排除。`hy_read_docs` 不读取或校验 managed AGENTS。

返回 envelope 含有界 excerpts，但 `WorkflowState.documentReads` 只持久化 path/bytes/chars/SHA/truncation、budget、pagination 和 digest，不保存正文。空目录、只有空壳文件、零实质事实或阶段错误都会 fail closed；`documentReadHealth` 继续用 PlanDoc/DocsGraph/实现 digest 派生 `missing/current/stale`。

## hy_plan

要求已存在 `before_plan` 文档事实基线。随后校验 PlanDoc shape、scope 非空、所有 scope 路径必须是项目根内相对路径、`scope.changes` / `scope.delete` 指向项目内已存在路径、boundary/verify/risks/discussion 有实质内容、禁止空洞命令；`scope.new_files` 允许声明尚不存在的计划创建文件，但同样必须留在项目根内。malformed nested PlanDoc 会返回结构化错误并停在 `plan`，不会抛出未捕获异常。task/risks/discussion 过短仅作为 soft warning。成功写入新 PlanDoc 时会清空 `beforeApprove`、`afterEdit` 和 `syncDocs`，避免复用旧 gate。

成功返回的 `summary` 和 `display.body` 是给用户审批的友善摘要，不是 PlanDoc 内部字段直出。摘要保留稳定结构：Plan（现在状态、期望状态）、Scope（将要增加/改动/删除，格式为 path: reason）、Boundary（影响范围、外部依赖、关键检查入口）、Verify（测试平台搭建，以及单元测试、集成测试、系统测试、验收测试四层）、Risks、Discussion。其中“期望状态”描述 PlanDoc 应用后项目应呈现的行为、文档或验证状态，不应是审批摘要本身的固定说明。`plan` 字段仍保留完整 PlanDoc，供 agent 和兼容客户端读取。

- **进入 Phase**: `plan`
- **转换到**: `approve`
- **成功返回**: `{ next: "approve", plan, summary, display, requires_user: true, stop_here: true, allowedTools, blockedTools, message }`
- **失败返回**: `{ next: "plan", error, fallback: {message, schema} }`

## hy_approve

用户审视 PlanDoc 的入口。批准前要求已存在匹配当前 PlanDoc hash 的 `before_approve` 文档审计。`changedSinceBaseline` 只警告 agent 刷新并核对事实，不会自动使批准失效，也不是新增人类审核。只有新事实导致任务意图、scope 或风险发生实质变化时，才回到 `hy_plan` 并请求新的批准；否则继续提交当前决定。`approved` 只接受 `"approve"`、`"reject"` 或 `"revise"`。

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

## hy_sync_docs

实现编辑后、最终验证前的文档同步 gate。要求已存在匹配当前 PlanDoc 的 `documentReads.afterEdit`，并记录 `syncDocs`，供 `hy_verify` 校验。工具不自动改写文档；agent 只能在 `plan.scope` 声明的文档或团队 workflow/template 文件内同步，再运行 `hy_verify`。

同步时增量更新用户 cache 中的 DocsGraph 并检测坏链接；结果通过 `graphInfo` 返回。docsDir membership 使用规范化路径边界判断。

- **进入 Phase**: `edit`, `verify`
- **转换到**: 保持 `edit`，返回 `next: "verify"`
- **返回**: `{ next: "verify", phase: "edit", synced, allowedDocs, display, hint }`

## hy_verify

执行本地任务 gate（compile、scope、boundary、platform、smoke、tests）。运行前要求 `hy_read_docs(after_edit)` 和 `hy_sync_docs` 已完成；全部通过后记录 implementation manifest、manifest hash、verifyHash 并转换到 commit。`boundary.no_new_external` 校验外部依赖声明（package.json scripts/version 元数据允许变；真正的依赖清单变化仍 fail closed）。

- **进入 Phase**: `edit`, `verify`; **通过→commit**; **失败→edit**
- **通过**: `{ next:"commit", allPassed:true, checks, verifyHash }`
- **失败**: `{ next:"edit", allPassed:false, hardFailed, failedChecks, recovery.byLayer }`
- **长测试套件**: 命令预计 >60s 或 sync 超时，请改用异步 `hy_exam_plan`+`hy_exam_submit`（verifyHash 等价）。

## hy_exam_plan / hy_exam_submit（异步 verify）

两工具实现 verify-as-oracle 模式，解决长测试套件触发 MCP `-32001 Request timed out`（90s）。sync `hy_verify` 仍保留为 <60s 快路径。
- **hy_exam_plan**（出题）：立即返回 `examId`（2h TTL）、`scopeFingerprint`（git write-tree）、per-check `{id, layer, command, timeoutMs, expectExitCode, nonce, mustContain?}`；agent 用 Bash 逐条跑，收集 exitCode + 最后 4KB stdout。
- **hy_exam_submit**（阅卷）：提交 `{examId, results:[{id, command, nonce, exitCode, stdoutTail?}]}`。校验：(1) exam 未过期；(2) nonce 匹配；(3) command 字串完全一致；(4) exitCode 匹配；(5) mustContain 正则；(6) git write-tree 未变。通过则原子写入 implementation manifest、manifest hash、implementation digest 和 verifyHash 放行 `hy_commit`，与 sync 路径等价；失败返回 `failedChecks[]`，2h 内只需补交失败项。进入 Phase: `edit, verify`；成功 → `commit`，失败 → `edit`（`recovery.nextAction=fix_then_resubmit`）。

## hy_amend_plan

`hy_verify` 返回 `amend_required` 时，`hy_amend_plan` 处理 pending scope amendment。纯 scope narrowing 保留原 decision；增加任何 target 或新增 delete 都是 material change，必须回到新 PlanDoc 和新的 approval。应用前会校验 pending amendment shape、所有路径仍在项目根内；应用后会重新校验 PlanDoc scope 非空、`changes/delete` 仍指向已存在路径，并写入与 `hy_edit` 相同结构的用户 state scope lock。

- **进入 Phase**: `verify`
- **转换到**: `edit` / `verify`
- **返回**: `{ next, approved, amendment, allowedTools }`

## hy_commit

`hy_commit` 依次运行 `commit.prepare`、`commit.publish`、`commit.ci`。它先固定 `baseBranch` 和 origin repository，要求 origin fetch/push URL 解析为同一带 host selector，再用 `git status --porcelain -z` 在 PlanDoc scope 内筛出当前真实差异并执行 git add → commit。提交后再次核对 implementation 路径集合与内容 digest，并在 publish 前持久化 commit OID、verifyHash、branch、baseBranch 和 repository。push 使用 `<verified-commit-oid>:refs/heads/<branch>`，不会推送可移动 branch ref。PR 操作忽略 `GH_REPO` 与 `GH_HOST`，查询 repository/base/head/headRefOid 全部精确匹配的 OPEN PR：唯一匹配直接复用，零匹配才调用 `gh pr create`；多匹配、旧 head OID、查询失败、JSON 异常或不精确匹配均 fail closed。create 无论命令成功或失败都必须再查询确认 exact PR，成功输出的 PR number 也必须与确认结果一致。

已在前一次提交中删除的 `scope.delete` 路径不会在 CI 修复后的后续提交中重复传给 `git add`。一般情况下没有真实 scope 差异仍返回 `NO_SCOPED_CHANGES`；只有持久化 recovery record 与当前 verifyHash/branch/base/repository/HEAD 全部一致时，重试才把记录中的 OID 作为 `recovered_verified_head` 继续 exact-SHA push 和 PR lookup。相同 verifyHash 已存在 recovery record 时进入 recovery-only 路径，绝不再次 commit；scope worktree 变脏，或 branch/base/repository 任一漂移都会在 push 前 fail closed。缺少记录或 clean HEAD 被空提交等方式移动时同样失败。提交前当前 Git 分支必须等于 `WorkflowState.branch`。`hy_commit` 全程使用 argv 传参，并在 `data.executor` 及 `data.commit`/`data.push` 中报告执行器、恢复动作和 SHA。

新建 PR 的 body 自动附加 scope/boundary/verify 元信息、verifyHash、planHash，并在 `Raw PlanDoc JSON` 折叠区写入 `hy_commit` 当下的完整 `WorkflowState.plan` JSON 备查。该 PlanDoc 快照在 PR 创建前生成，因此会保留当时的 runtime 字段状态；PR number 写回状态发生在 PR 新建或复用成功之后，不反向改写 PR body。复用既有 PR 时不覆盖它的 body。

- **进入 Phase**: `commit`
- **转换到**: pending 时保持 `commit`；CI 全绿时进入 `merge`，结果 stage 为 `merge.reconcile`
- **返回**: `{ phase: "commit", stage: "commit.ci", next: "commit", ... }`（等待）或 `{ phase: "merge", stage: "merge.reconcile", next: "merge", ... }`（全绿）

## hy_commit 的 commit.ci stage

通过已安装且已认证的 `gh pr view` 读取 `state`、`baseRefName`、`headRefName`、`headRefOid` 和 `isCrossRepository`，再通过 `gh pr checks --json name,workflow,bucket,state,link` 获取结构化 checks。名字本身不构成信任：所需 `Verify` 必须恰好有一个来自 `hy-workflow`，其 link 必须属于当前 origin 的 Actions run；随后 `gh api` 还要证明该 run 的 `path` 是 `.github/workflows/hy-workflow.yml`、`head_sha` 等于 recovery commit、`event` 是 `pull_request`，且 repository 与 origin 一致。push 事件的同名 check 不是 required provenance，但仍是 effective check，非绿色时同样阻断。第三方同名、foreign workflow、缺失或多个 provenance-valid Verify 都 fail closed。活跃 workflow 必须有 matching recovery record，origin 和 PR tuple 必须精确匹配；`GH_REPO` 与 `GH_HOST` 会被忽略。`data.executor` 报告本次 `gh` 能力。`WorkflowState.prNumber` 必须是正整数；损坏或被注入字符串的运行态会被结构化拒绝，不会传给 `gh`。pending/unknown 时在工具内部 bounded polling，默认最多 600 秒、间隔 10 秒；可传 `timeoutSeconds` / `intervalSeconds` 覆盖。

- **进入 Phase**: `commit`
- **全绿后转换到**: `merge`
- **失败后转换到**: `edit`（通过 transition(state, "edit") 并 writeState）
- **缺失/无有效 checks**: GitHub 没有 reported checks，或全部 checks 为 skipped/neutral 时保持 `commit`，返回 `error.code: "CI_CHECKS_REQUIRED"` 并阻止 `hy_merge`
- **pending/API 异常**: polling 超时后保持 `commit`，等待后重试 `hy_commit`；这不是审批
- **返回**: 全绿 `{ phase: "merge", stage: "merge.reconcile", next: "merge", allGreen: true, checks }`；缺失、pending、失败分别返回 typed control/userAction/recovery，并保留兼容字段

setup 生成的 thin workflow 使用 pinned checkout、`contents: read` 与 exact package version 执行集中式 lint/policy；不推断生态、不安装 toolchain、不运行 native CI，也不嵌入旧的大型 bundle。仓库管理员需在 GitHub ruleset 或 branch protection 中把 Verify check 设为 required；这是管理员动作，setup 不越权配置。

## hy_merge

通过已安装且已认证的 `gh` 在 merge 前再次读取并精确比较 immutable PR identity：repository、PR number、base、head 和 verified head OID。只有 OPEN lifecycle 与 fresh Git evidence 都允许时，才执行唯一的 `gh pr merge --match-head-commit <verified-oid> --merge --delete-branch` mutation。origin 必须仍匹配 recovery record；`GH_REPO` 与 `GH_HOST` 会被忽略。PR number 必须是正整数并通过 argv 传给 `gh`，损坏运行态不会被当作命令片段执行。

merge recovery receipt 分开保存 immutable identity 与 mutable lifecycle。mutation 前先持久化 attempted receipt，远端合入确认后再持久化 confirmed receipt；`executePrMerge` 是唯一 merge mutation，同一 receipt 最多调用一次。mutation 命令无论成功、失败还是发生普通工具/进程中断，重试都先通过 `reconcileMerge` 检查 postcondition；confirmed receipt 只恢复后置同步。

若 GitHub lifecycle 暂不可读，`fetchRemoteBaseEvidence` 使用 **fresh-fetch ancestry** 固定远端 base 的 `baseOid` 并检查 verified head。这个 **read-only Git fallback** 只读 fetch/ref/ancestry，绝不直接 merge 或 push base；命中时返回 `data.outcome: "already_integrated"`、`data.evidence: "git"`。本次 mutation 后由 GitHub 与 Git 共同确认时返回 `merged_now`；调用前 GitHub MERGED 与 Git ancestry 已经一致时返回 `already_merged`。成功结果都包含 `data.executor`，明确本次实际使用的 `gh`/`git` 能力。

正常 attempted receipt 只收录真实 stacked branches：受管 agent branch 必须排除 base/head，verified head 与 fresh `preparedBaseOid` 都必须是候选 commit 的祖先，而且 snapshot 时 local OID 必须等于 remote OID。

confirmed receipt 首次同步时要求 fresh remote base 包含 verified OID 与确认时的 base OID，再把该 tip 固定为 `syncBaseOid`；每次恢复要求 remote tip 仍与 pin 完全相等。base drift 以 retryable `POST_MERGE_SYNC_INCOMPLETE` fail closed。每个候选先持久化 `rebasing`，通过 **detached staging** 从 recorded OID 对 `syncBaseOid` rebase，再持久化 `resultOid`；随后用 local ref **compare-and-swap** 安装，并用 recorded remote OID 执行 exact `force-with-lease`。`pending`、`rebasing`、`rebased`、`pushed` 进度允许重试只继续 remaining work，且不会覆盖被其他参与者移动的 local/remote ref。

整个 handler 由 project-specific merge operation lock 串行化；活 owner 返回 retryable `MERGE_LOCK_BUSY`，同 host dead owner 可 stale-recover，退出时按 token best-effort release。owner pid/host/time/token 只提供共享同一本地状态根和工作树的进程互斥，不是跨主机锁。receipt 与 lock 只承诺已完成状态写入后的工具/进程中断恢复，不承诺断电或缺少 `fsync` 时的 durability。

未确认返回 `PR_MERGE_OUTCOME_UNCONFIRMED`；已确认但同步未完成返回 `POST_MERGE_SYNC_INCOMPLETE`。identity/OID、local CAS 或 downstream remote lease 漂移是不可重试的状态完整性错误，应由用户检查后调用 `hy_reset` 或显式修复。base evidence/ancestry drift 与普通暂时性 GitHub/origin/本地 Git 故障保留 receipt 并允许在修复后重试 `hy_merge`，但不会自动循环。

- **进入 Phase**: `merge`
- **转换到**: `merge.reconcile` 确认远端结果，再由 `merge.sync` 完成或恢复下游同步，最后进入 `done`
- **返回**: `{ phase: "done", next: "done", prNumber, data: { outcome, evidence, executor, baseOid, completed, remaining }, display, hint }` 或 `{ phase: "merge", next: "merge", error, data, requires_user: true, stop_here: true, recovery }`

---

## Promotion / release exception

`hy_branch` 和 `hy_commit` 固定围绕 `hy-workflow.json: project.baseBranch` 工作：普通开发分支从 `origin/<baseBranch>` 创建，并把 PR 合回 baseBranch。因此 baseBranch 到 releaseBranch 的 promotion（例如 dev → main）不是普通 hy-workflow 开发任务，不应伪造空 scope 或空 diff 来通过 `hy_verify`。

当用户明确要求 promotion 时，正确流程是确认 source/target，检查 `origin/<target>..origin/<source>` diff，创建或复用 `base=<target>, head=<source>` 的 promotion PR，等待 CI 全绿后合并。若需要直接调用 `gh` 或 `git`，必须先获得用户明确授权。

普通代码/文档改动仍必须走完整闭环；promotion 例外只能用于明确的 release branch 晋级。

## hy_reset

可任意阶段调用，回到 `plan` 并清空 plan、approval、branch、PR、verifyHash、pending amendment、implementation manifest、document reads 和 syncDocs 等 workflow 派生状态。该工具要求当前目录在真实 Git worktree 内；找不到项目根时返回 `PROJECT_ROOT_NOT_FOUND`，不会创建伪 `.git/hy-workflow`。

## hy_status

只读工具，返回 WorkflowState 快照（phase/branch/prNumber/plan/approved/verified/next/hint/setupUpdateCheck/capabilities）。损坏的 workflow.json 会返回结构化错误而不是原始异常。

- **进入 Phase**: 无限制
- **返回**: `{ phase, branch, prNumber, plan, approved, verified, next, hint, allowedTools, setupUpdateCheck, capabilities, action? }`

## Related
[Architecture](./architecture.md) · [State Machine](./state-machine.md) · [Verify Pipeline](./verify.md)
