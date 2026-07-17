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
| `hy_commit` | commit | `{title, body}` | ci | 否 |
| `hy_ci`     | ci, edit | — | merge (有效 checks 全绿) / ci (缺失、无效或 pending) / edit (失败) | 否 |
| `hy_merge`  | merge | — | chain | 否 |
| `hy_chain`  | chain | `{branches: string[]}` | done | 否 |
| `hy_reset`  | 任意 | — | plan | 否 |
| `hy_status` | 任意 | — | — | 是 |

## hy_init

验证 schema-3 deployment 的版本、direct-bin/MCP catalog 证据与团队/托管 artifact hash（`hy-workflow.json`、`.github/workflows/hy-workflow.yml`、以及 `AGENTS.md` managed block），并检查可解析的 `project.baseBranch` 与非空文档事实，然后把 workflow state 初始化到 identity-scoped user state。`hy_init` 不写 `AGENTS.md`、`.gitignore`、工作树或 `.git`，也不会在 MCP 内启动 setup TUI。

- **进入 Phase**: `init`, `plan`
- **转换到**: `plan`
- **成功返回**: `{ next: "plan", message, display, commitArtifacts: [], localArtifacts, projectFilesChanged: [], allowedTools: ["hy_read_docs", "hy_status"] }`
- **失败返回**: `{ next: "init", error: { type: "setup_artifacts_missing", missingArtifacts }, requires_user: true, stop_here: true, recovery }`

`hy-workflow.json` 是唯一有效项目配置源。根配置必须显式包含 runtime 必填字段；默认推断、含 mode 的旧 manifest、项目内 legacy stamp 或 compatibility JSON 都不能绕过。缺少/漂移的团队 artifact、缺失 ref、空文档或无实质事实都返回结构化 stop envelope；过期 managed AGENTS block 同样阻断 plan，但 recovery 明确指向 `hy-workflow setup`，由 setup 在事务内自动迁移该 block（保留块外自定义指令）。

MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input.

旧 local/runtime artifacts 已被跟踪时仍返回诊断，但不会自动删除或改写。

Artifact contract: setup 固定维护根 `hy-workflow.json`、`.github/workflows/hy-workflow.yml`，并在 `AGENTS.md` 中托管 `<!-- hy-workflow-rules -->` 块（块外内容团队所有，setup 自动迁移块内版本但不改写块外指令）。unset/hy_init 不删除或改写团队文件；deployment/state/cache、客户端配置和 compatibility JSON 不提交。

## Session setup check

MCP runtime 每次处理任意 `hy_*` tool 前都会检查 identity-scoped `deployment.json` 的 schema/version、两条 direct tool evidence、MCP catalog hash 和两个团队 artifact SHA/size；还会确认记录的 executable 仍存在、当前 PATH 解析到同一路径、且该文件的 `--version` 与 deployment evidence 一致。这个轻量 live check 不递归启动 MCP handshake。缺失、卸载、PATH 替换、版本替换、版本落后、tool mismatch 或 artifact drift 均 stop。runtime 不会自行运行 setup 或启动 TUI；用户需在终端修复后重启 agent/MCP session。

## Config CLI

`hy-workflow config --check --json` 会只读检查 tracked files、manifests、origin HEAD/current/conventional refs、语言扩展、真实目录 casing 和根配置；mixed、unknown、非 conventional branch 或其他低置信 Git 推断必须显式确认。`project.codeExt` 可保留多扩展；可选 `ci.commands` 必须是已确认的非空单行数组，preserve-first apply 不改写人工值。compatibility JSON 仍只在旧 CLI 运行期临时生成并恢复。

## hy_read_docs

自动读取 `project.docsDir`，使用 DocsGraph 和 task relevance 建立有界事实页。`before_plan` 必须传 `task`；`before_approve` 审计 PlanDoc；`after_edit` 审计实现 diff。结果最多 12 files、48,000 chars、每文件 12,000 chars并报告 token estimate；`pagination.hasMore/nextCursor` 可继续同一 stage/task，三者仍是自动 gate。

DocsGraph 全量索引只在 OS 用户 cache 保存 digest/links；读取优先 docsDir 根部大小写无关的 `index`/`README`（含 RST），再按 task 排序。`node_modules`、examples、fixtures、generated、build/vendor 等目录，越界目标、外链和代码块链接均排除；managed AGENTS block 必须含当前 `hy-workflow-rules-version`。

返回 envelope 含有界 excerpts，但 `WorkflowState.documentReads` 只持久化 path/bytes/chars/SHA/truncation、budget、pagination 和 digest，不保存正文。空目录、只有空壳文件、零实质事实、过期 managed rules、阶段错误都会 fail closed；`documentReadHealth` 继续用 PlanDoc/DocsGraph/实现 digest 派生 `missing/current/stale`。

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

`boundary.no_new_external` 校验外部依赖声明，而不是把 `package.json` / `package-lock.json` 的任意字节变化都当成新增依赖。npm 包的 version、scripts 和 lockfile 根包 version 等发布元数据可以变化；dependencies、devDependencies、peerDependencies、optionalDependencies、bundle/bundledDependencies 或其他生态依赖清单发生变化仍 fail closed。无法读取或解析 `origin/<baseBranch>` 基线时同样失败。

- **进入 Phase**: `edit`, `verify`
- **通过后转换到**: `commit`
- **失败后转换到**: `edit`
- **通过返回**: `{ next: "commit", allPassed: true, checks, verifyHash, hint, allowedTools }`
- **失败返回**: `{ next: "edit", allPassed: false, hardFailed, checks, failedChecks, recovery.byLayer }`
- **长测试套件**: 若任何命令预计 >60s 或 sync `hy_verify` 在 MCP transport 内超时，请改用异步 `hy_exam_plan` + `hy_exam_submit`（见下）。两者产出相同 verifyHash 并同等放行 `hy_commit`。

## hy_exam_plan

异步 verify 第 1 步（出题）。立即返回 `examId` + nonce + 检查清单（command/cwd/timeoutMs/expectExitCode/mustContain per check），**不在 MCP transport 里跑任何命令**。agent 用 Bash 逐条运行、收集 exitCode 和最后 4KB stdout，再调 `hy_exam_submit` 交卷。

适用场景：tests 层较重、单命令 >60s、全量 verify 会触发 MCP client `-32001 Request timed out`。清单与 sync `hy_verify` 跑的命令完全一致。

- **进入 Phase**: `edit`, `verify`
- **成功返回**: `{ next: "verify", examId, issuedAt, expiresAt, scopeFingerprint, nonce, checks: ExamCheck[], display }`
- **2 小时 TTL**，过期或 working tree 变化需重新 issue

## hy_exam_submit

异步 verify 第 2 步（阅卷）。提交 `examId` + 每条命令的 `{id, command, nonce, exitCode, stdoutTail?, durationMs?}`。服务端校验：
1. exam 存在且未过期
2. per-check nonce 匹配
3. 提交的 command 字符串与 manifest 完全一致（防偷换命令）
4. exitCode === expectExitCode
5. mustContain/mustNotContain 正则通过（若声明）
6. 当前 git write-tree hash 与 issue 时一致（防改代码不重跑）

全部通过才写 verifyHash 放行 `hy_commit`；否则返回 `failedChecks[]`，修完只需补交失败条目（passed 条不需要重交），2h 内有效。

- **进入 Phase**: `edit`, `verify`
- **通过返回**: `{ next: "commit", passed: true, examId, verifyHash, submitted }`
- **失败返回**: `{ next: "edit", passed: false, failedChecks, recovery.nextAction: "fix_then_resubmit", recovery.resubmitExamId }`

## hy_amend_plan

`hy_verify` 返回 `amend_required` 时，用户明确批准后应用 pending scope amendment。该工具只处理 verifier 判断为安全的小范围 scope 修订，包括批准边界内的测试支持文件，以及从 scope 移除实际未改动且不会导致 scope 为空的已声明路径；不替代 `hy_plan` 的人类审批。应用前会校验 pending amendment shape、所有增删路径仍在项目根内；应用后会重新校验 PlanDoc scope 非空、`changes/delete` 仍指向已存在路径，并写入与 `hy_edit` 相同结构的用户 state scope lock。

- **进入 Phase**: `verify`
- **转换到**: `edit` / `verify`
- **返回**: `{ next, approved, amendment, allowedTools }`

## hy_commit

`hy_commit` 先固定 `baseBranch` 和 origin repository，要求 origin fetch/push URL 解析为同一带 host selector，再用 `git status --porcelain -z` 在 PlanDoc scope 内筛出当前真实差异并执行 git add → commit。提交后再次核对 implementation 路径集合与内容 digest，并在 push 前持久化 commit OID、verifyHash、branch、baseBranch 和 repository。push 使用 `<verified-commit-oid>:refs/heads/<branch>`，不会推送可移动 branch ref。PR 操作忽略 `GH_REPO` 与 `GH_HOST`，查询 repository/base/head/headRefOid 全部精确匹配的 OPEN PR：唯一匹配直接复用，零匹配才调用 `gh pr create`；多匹配、旧 head OID、查询失败、JSON 异常或不精确匹配均 fail closed。create 无论命令成功或失败都必须再查询确认 exact PR，成功输出的 PR number 也必须与确认结果一致。

已在前一次提交中删除的 `scope.delete` 路径不会在 CI 修复后的后续提交中重复传给 `git add`。一般情况下没有真实 scope 差异仍返回 `NO_SCOPED_CHANGES`；只有持久化 recovery record 与当前 verifyHash/branch/base/repository/HEAD 全部一致时，重试才把记录中的 OID 作为 `recovered_verified_head` 继续 exact-SHA push 和 PR lookup。相同 verifyHash 已存在 recovery record 时进入 recovery-only 路径，绝不再次 commit；scope worktree 变脏，或 branch/base/repository 任一漂移都会在 push 前 fail closed。缺少记录或 clean HEAD 被空提交等方式移动时同样失败。提交前当前 Git 分支必须等于 `WorkflowState.branch`。`hy_commit` 全程使用 argv 传参，并在 `data.executor` 及 `data.commit`/`data.push` 中报告执行器、恢复动作和 SHA。

新建 PR 的 body 自动附加 scope/boundary/verify 元信息、verifyHash、planHash，并在 `Raw PlanDoc JSON` 折叠区写入 `hy_commit` 当下的完整 `WorkflowState.plan` JSON 备查。该 PlanDoc 快照在 PR 创建前生成，因此会保留当时的 runtime 字段状态；PR number 写回状态发生在 PR 新建或复用成功之后，不反向改写 PR body。复用既有 PR 时不覆盖它的 body。

- **进入 Phase**: `commit`
- **转换到**: `ci`
- **返回**: `{ next: "ci", prNumber, url, reused, data: { prAction, commit: { action, sha }, push: { sha }, repository, headRefOid }, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

## hy_ci

通过已安装且已认证的 `gh pr view` 读取 `state`、`baseRefName`、`headRefName`、`headRefOid` 和 `isCrossRepository`，再通过 `gh pr checks --json name,workflow,bucket,state,link` 获取结构化 checks。名字本身不构成信任：所需 `Verify` 必须恰好有一个来自 `hy-workflow`，其 link 必须属于当前 origin 的 Actions run；随后 `gh api` 还要证明该 run 的 `path` 是 `.github/workflows/hy-workflow.yml`、`head_sha` 等于 recovery commit、`event` 是 `pull_request`，且 repository 与 origin 一致。push 事件的同名 check 不是 required provenance，但仍是 effective check，非绿色时同样阻断。第三方同名、foreign workflow、缺失或多个 provenance-valid Verify 都 fail closed。活跃 workflow 必须有 matching recovery record，origin 和 PR tuple 必须精确匹配；`GH_REPO` 与 `GH_HOST` 会被忽略。`data.executor` 报告本次 `gh` 能力。`WorkflowState.prNumber` 必须是正整数；损坏或被注入字符串的运行态会被结构化拒绝，不会传给 `gh`。pending/unknown 时在工具内部 bounded polling，默认最多 600 秒、间隔 10 秒；可传 `timeoutSeconds` / `intervalSeconds` 覆盖。

- **进入 Phase**: `ci`, `edit`
- **全绿后转换到**: `merge`
- **失败后转换到**: `edit`（通过 transition(state, "edit") 并 writeState）
- **缺失/无有效 checks**: GitHub 没有 reported checks，或全部 checks 为 skipped/neutral 时保持 `ci`，返回 `error.code: "CI_CHECKS_REQUIRED"`、`requires_user: true`、`stop_here: true` 并阻止 `hy_merge`
- **pending/API 异常**: polling 超时后保持 `ci`，等待后重试 `hy_ci`
- **返回**: 全绿 `{ next: "merge", allGreen: true, checks, display, hint }`；缺失/无有效 checks `{ next: "ci", allGreen: false, noChecks?, noEffectiveChecks?, error, requires_user: true, stop_here: true, recovery }`；pending `{ next: "ci", pending: true, requires_user: true, stop_here: true, recovery }`；失败 `{ next: "edit", failedChecks, requires_user: true, stop_here: true, recovery }`

setup 生成的 workflow 必须执行 doclint 与 codelint。仓库管理员需在 GitHub ruleset 或 branch protection 中把 Verify check 设为 required；这是管理员动作，setup 不越权配置。

## hy_merge

通过已安装且已认证的 `gh` 在 merge 前再次读取并精确比较 PR repository/base/head/headRefOid，然后执行 `gh pr merge --match-head-commit <verified-oid> --merge --delete-branch`。origin 必须仍匹配 recovery record；`GH_REPO` 与 `GH_HOST` 会被忽略。`data.executor` 报告执行器。PR number 必须是正整数，并通过 argv 传给 `gh`；损坏运行态不会被当作命令片段执行。

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
