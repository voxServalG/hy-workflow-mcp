# State Machine

工作流状态机定义在 `src/runtime/state-machine.ts` 中。每个 Phase 的合法转换由 `VALID_TRANSITIONS` 硬编码，禁止跳 Phase。

## Phase 定义

| # | Phase | 含义 |
|---|-------|------|
| 1 | `init` | 等待 `hy_init` 验证 deployment/tool/artifact evidence、两个团队文件、base ref 与文档事实 readiness |
| 2 | `plan` | 任务规划，先由 agent 自动执行 `hy_read_docs(before_plan)` 建立文档事实基线，再生成 PlanDoc |
| 3 | `approve` | 用户审视 PlanDoc；用户批准后 agent 自动执行 `hy_read_docs(before_approve)` 做文档审计，再输入 `"approve"` 放行 |
| 4 | `branch` | 创建 git 分支，等待 LLM 调用 `hy_branch` |
| 5 | `edit` | LLM 编写代码，scope 已锁定；实现后运行 `hy_read_docs(after_edit)` 和 `hy_sync_docs` |
| 6 | `verify` | 本地任务 gate（compile/scope/boundary/platform/smoke/tests），通过则进 commit |
| 7 | `commit` | 粗粒度持久化 phase；`commit.prepare`、`commit.publish`、`commit.ci` 是可恢复 stage |
| 8 | `merge` | 粗粒度持久化 phase；`merge.reconcile` 与 `merge.sync` 复用既有审批并按 receipt 恢复 |
| — | `done` | 终结状态，不再继续 |

## VALID_TRANSITIONS

定义在 `src/runtime/state-machine.ts` 的 `VALID_TRANSITIONS`。每个 Phase 可转移到自身（原地不动）或以下目标：

```
init     → init, plan, done
plan     → plan, approve, done
approve  → approve, branch, plan
branch   → branch, edit, done
edit     → edit, verify, commit, done
verify   → verify, edit, commit, done
commit   → commit, edit, merge, done
merge    → merge, done
done     → done
```

首次初始化只在 deployment 或项目尚未初始化时执行：
```
hy_init → hy_read_docs(before_plan) → hy_plan
```

后续每个开发任务的完整关键路径：
```
hy_status -> hy_read_docs(before_plan) -> hy_plan -> hy_read_docs(before_approve) -> hy_approve -> hy_branch -> hy_edit -> hy_read_docs(after_edit) -> hy_sync_docs -> hy_verify -> hy_commit -> hy_merge -> hy_reset
```

长时验证可用 `hy_exam_plan -> hy_exam_submit` 替代 `hy_verify`。`phase` 是持久化粗粒度状态，`stage` 是当前 phase 内的步骤；CI 由 `hy_commit` 的 `commit.ci` 执行和重试，下游同步由 `hy_merge` 的 `merge.sync` 执行和恢复。

失败或驳回分支：
```
hy_approve 驳回 → plan
hy_verify 失败 → edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify
commit.ci 检查失败 → edit → hy_edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify → hy_commit
commit.ci 无 checks 或仅 skipped/neutral → commit（CI_CHECKS_REQUIRED，阻止 hy_merge）
commit.ci pending 或 API 异常 → commit（等待后重试 hy_commit，不进入 edit，也不请求审批）
hy_commit 在 push/PR API 失败 → commit（仅当完整验证快照、持久化 recovery record 与 HEAD 全部一致时复用，不创建空提交）
hy_merge 结果未知 → merge（先 reconcile；无法确认时返回 PR_MERGE_OUTCOME_UNCONFIRMED）
hy_merge 已确认合入但同步未完成 → merge（POST_MERGE_SYNC_INCOMPLETE；重试只恢复同步，不再次执行 merge mutation）
```

## 文档读取 gate

`hy_read_docs` 不新增状态机 phase，而是在 `plan`、`approve` 和 `edit` phase 内作为自动 gate 运行。

每次返回是 task-ranked 有界页：最多 12 files、48,000 chars、单文件 12,000 chars并带 token estimate；`pagination.nextCursor` 读取后续页。DocsGraph 全量 digest/link index 位于用户 cache，workflow state 的 `documentReads` 只保存 path/size/SHA/truncation/budget/pagination/digest，不保存返回 excerpts。空/无实质事实、过期 `hy-workflow-rules-version` 或零相关事实直接阻断对应 phase。

- `before_plan`: 运行于 `plan` phase，记录用户 task 并写入 `documentReads.beforePlan`。`hy_plan` 缺少 baseline 时拒绝执行；baseline task 与 PlanDoc task 文案不一致时只给 warning，不阻断同一任务的自然改写。
- `before_approve`: 运行于 `approve` phase，绑定当前 PlanDoc hash，写入 `documentReads.beforeApprove`。如果本次读取的文档 digest 或全量 DocsGraph digest 相对 `before_plan` 发生变化，snapshot 会记录 `changedSinceBaseline: true`。这只是提示 agent 刷新和核对事实的 warning，不会自动使批准失效。只有事实变化导致任务意图、scope 或风险发生实质变化时，agent 才回到 `hy_plan`，展示新 PlanDoc 并请求新的批准。
- `after_edit`: 运行于 `edit` / `verify` phase，绑定当前 PlanDoc hash 和实现 diff digest，写入 `documentReads.afterEdit`。`hy_verify` 缺少 current 审计时拒绝执行。

`documentReadHealth` 从 metadata 派生每个 gate 的 `missing/current/stale`。PlanDoc hash、实现 digest 或全量 DocsGraph digest 不匹配时，旧下游读取不能复用；before_plan task 文案不一致仅诊断。`hy_status` 显示阻塞和下一工具，`hy_plan` 清空 downstream gate，避免新计划继承旧审计。

这些自动文档 gate 永远不要求用户审核。用户只审核 `hy_plan` 生成或因实质任务意图、scope、风险变化而重新生成的 PlanDoc。`hy_plan` 进入 approve 前会拒绝 malformed PlanDoc、空 scope、越出项目根目录的任何 scope 路径，以及不存在的 `scope.changes` / `scope.delete` 路径；计划创建的文件必须放在 `scope.new_files`，可以在审批时尚不存在，但路径仍必须位于项目根内。`hy_amend_plan` 纯缩小 scope 时保留既有决定；增加任何 target 或新增 delete 都属于实质变化，必须生成新的批准。

## 状态持久化

状态文件位于 OS 用户 state 的 `projects/<project-id>/workflow.json`；project id 由规范化项目根、Git common dir 和 origin remote 计算。

```typescript
interface WorkflowState {
  version: "1";
  phase: Phase;
  branch: string | null;
  prNumber: number | null;
  plan: PlanDoc | null;
  approval: Approval | null;
  verifyHash: string | null;
  verifiedImplementationDigest?: string | null;
  verifiedManifestHash?: string | null;
  pendingAmendment?: PendingPlanAmendment | null;
  implementationManifest?: ImplementationManifest | null;
  documentReads?: DocumentReads | null;
  syncDocs?: SyncDocsRecord | null;
  mergeReceipt?: MergeReceipt | null;
}
```

- `readState()`: 只读取 OS 用户 state；没有状态时返回 `phase: init`
- `writeState()`: 原子写入用户 state 并自动创建父目录
- `projectRoot()`: 向上查找 `.git`，找不到则报 `PROJECT_ROOT_NOT_FOUND`，不会在非 Git 目录创建伪 `.git/hy-workflow` 状态

## 状态守卫

- `assertPhase(state, ...expected)`: 当前 Phase 不在期望列表中时抛 `StateError`
- `transition(state, to)`: 转换不在 VALID_TRANSITIONS 中时抛 `StateError`
- 所有工具 handler 都在入口处调用 `assertPhase`，确保按序执行

## verifyHash

`computeVerifyHash()` 对 PlanDoc 的 task + scope + boundary + rubrics 字段，以及 `hy_verify` 记录的实现文件集合摘要和实现内容摘要做 SHA256 取前 12 位。`hy_verify` 通过后写入 `WorkflowState.verifyHash`、`implementationManifest`、`verifiedManifestHash` 和 `verifiedImplementationDigest`。`hy_commit` 不只检查 verifyHash 是否存在，还会确认当前 Git 分支等于 `state.branch`，当前 manifest 等于已验证 manifest，当前文件内容摘要等于已验证摘要，并重新计算 verifyHash。任何一项不匹配都会停在 commit phase，要求重新执行 `hy_read_docs(after_edit)`、`hy_sync_docs` 和 `hy_verify`。

`hy_commit` 生成 commit/PR body 时，会从当前 `WorkflowState.plan` 直接序列化完整 PlanDoc JSON，并额外写入 `planHash` 与顶层 `verifyHash`。如果 `hy_amend_plan` 修改过 scope，必须重新 `hy_verify` 后才能进入 commit，因此 PR body 记录的是 amended 后重新验证过的当前 PlanDoc 快照。CI、merge 和 reset 不会再改写 PR body。`hy_reset` 会清空 plan、approval、branch、PR、verifyHash、pending amendment、manifest、document reads、syncDocs 和 `mergeReceipt` 等派生状态，避免新计划继承旧运行态；不可重试的 receipt/identity/ref 漂移必须由用户审查后 reset，工具不会自动丢弃证据。

`hy_commit` commit 后再次核对路径集合和内容摘要，把 commit OID、verifyHash、branch、baseBranch 与带 host 的 repository 写入 approval 派生状态，再用该 commit OID 的精确 refspec 推送。origin fetch/push URL 必须解析为同一 repository；PR 操作忽略 `GH_REPO` 与 `GH_HOST`，并查询 repository/base/head/headRefOid 精确匹配的 OPEN PR：唯一匹配直接复用，零匹配才调用 `gh pr create`，多匹配、旧 OID、查询失败、JSON 异常或上下文不精确匹配均 fail closed。create 成功也要 post-lookup 确认；命令失败但远端已接收时，只有 exact post-lookup 才可恢复。

若 push、PR 或 CI 步骤失败，状态保持 `commit` 且 recovery record 已在任何远端副作用前落盘。下一次 `hy_commit` 仍先验证 branch、manifest、digest 和 verifyHash；仅在这些证据、base/repository、recovery record 与当前 clean `HEAD` 全部一致时恢复对应 stage。缺少记录或插入空提交都会 fail closed。`commit.ci` 每次查询同时比较 PR tuple；`hy_merge` 再比较一次并传 `--match-head-commit`。复用不会覆盖既有 PR body；新建时才写入本次生成的 PlanDoc body。

`hy_merge` 把 immutable PR identity（repository、PR number、base、head 与 verified head OID）和 mutable lifecycle 分开保存。第一次 mutation 前写入 attempted receipt；`executePrMerge` 是唯一允许执行 `gh pr merge` 的函数，而且同一 receipt 不会重试该 mutation。命令成功、失败或结果未知后，`reconcileMerge` 都先用 GitHub postcondition 判断远端是否已合入，再决定是否进入 confirmed receipt 与同步阶段。

GitHub lifecycle 证据不可用时，`fetchRemoteBaseEvidence` 对目标 base 执行 **fresh-fetch ancestry**，把 immutable `baseOid` 与 `isAncestor` 结果写入证据。这个 **read-only Git fallback** 只能在 verified head 已是该 `baseOid` 祖先时返回 `already_integrated` 和 `evidence: "git"`；它绝不直接 merge，也绝不 push base。若两类证据都不能确认合入，返回 `PR_MERGE_OUTCOME_UNCONFIRMED` 并保持 merge phase。

正常 attempted receipt 中的 stacked candidates 必须是受管 agent branches，并排除 base/head。snapshot 时每个候选都必须同时满足 verified head 是候选祖先、fresh `preparedBaseOid` 是候选祖先，以及 local OID 等于 remote OID。legacy 状态没有 receipt、但 fresh Git ancestry 已确认合入时，只重建 agent-prefix、verified-head ancestry 和 local=remote 共同证明的 stack；unrelated branch 忽略，真实 stack ref 漂移以 `POST_MERGE_SYNC_INCOMPLETE` 的 `detail.operation: "downstream snapshot"` 停止。

confirmed receipt 在首次同步前 fresh fetch base，要求当前 remote base 同时包含 verified OID 与确认时的 base OID，然后把该 tip 固定为 `syncBaseOid`；后续恢复要求 remote tip 仍与该 pin 完全相等。违反任一条件都以 retryable `POST_MERGE_SYNC_INCOMPLETE` 的 `detail.operation: "sync base ancestry"` fail closed。每个 downstream 进度按 `pending → rebasing → rebased → pushed` 落盘；`rebasing` 先于副作用持久化，通过 **detached staging** 从 recorded local OID 对 pinned `syncBaseOid` rebase，再持久化 `resultOid`。只有 `git update-ref` 的 old-OID **compare-and-swap** 成功后才改变 local branch，随后以 recorded remote OID 执行 exact `force-with-lease`。local ref、remote ref 或 base ancestry 任一漂移都不会被覆盖。重试只恢复未完成同步，成功后 `hy_merge` 直接进入 `done`。

`hy_merge` 进入 reconciliation 和本地同步前取得 project-specific merge operation lock。lock 保存 owner pid/host/time/token；活 owner 导致 retryable `MERGE_LOCK_BUSY`，同 host dead owner 可安全回收，退出时按 token best-effort release。lock 不新增 phase，也不替代 receipt；它只阻止共享同一本地状态根和工作树的 MCP 进程并发操作，不提供跨主机强一致。

receipt 恢复覆盖完成状态写入后的普通 MCP 工具或进程中断。它不宣称在机器断电、内核崩溃或没有文件/目录 `fsync` 的情况下也具备 durable transaction 语义。

## ToolResult envelope

字段契约定义在 `src/output/contract.ts`，运行时 helper 和 TypeScript shape 定义在 `src/output/envelope.ts`。`next` 是状态机下一步；`phase` 默认等于 `next`，但 `hy_edit` 等工具可返回 `phase: "edit"`、`next: "verify"` 来表达“当前仍在 edit，但下一步建议 verify”。

```typescript
interface ToolResult {
  ok: boolean;
  phase: Phase;
  stage: string;
  status: string;
  nextAction: { tool: string | null; arguments?: unknown; phase: Phase; stage: string; automatic: boolean };
  control: { automatic: boolean; stop: boolean; reason: string };
  userAction: { kind: string; decisionId?: string; prompt?: string; instruction?: string; options?: string[] } | null;
  next: Phase; // legacy
  data?: unknown;
  error?: {
    type: string;
    subtype: string;
    code?: string;
    message: string;
    hint?: string;
    detail?: unknown;
    cause?: string;
    retryable?: boolean;
    risk?: unknown;
    permission_violations?: unknown[];
    missing_scopes?: string[];
    console_url?: string;
    request_id?: string;
    trace_id?: string;
  };
  display?: { title?: string; body?: string; files?: string[]; urls?: string[] };
  summary?: string;
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: { tool?: string; command?: string; instruction?: string; byLayer?: Record<string, string> };
  checks?: unknown[];
  findings?: unknown[];
  pagination?: { has_more?: boolean; page_token?: string; next_page_token?: string };
  meta?: { command?: string; cwd?: string; identity?: string; format?: string; version?: string; request_id?: string; trace_id?: string; duration_ms?: number };
  _notice?: { update?: { message?: string; command?: string; current_version?: string; latest_version?: string } };
}
```

## PlanDoc 结构

```typescript
interface PlanDoc {
  task: string;
  // 所有路径必须在项目根内；changes/delete 必须已存在；new_files 可以尚不存在。
  scope: { changes: string[]; new_files: string[]; delete: string[] };
  boundary: { dependency_dag: string; entry_points: string[]; no_new_external: boolean };
  verify: { platform: {...}; smoke: CheckItem[]; tests: CheckItem[] };
  risks: string[];
  discussion: string;
  branch: string | null;        // runtime
  verify_hash: string | null;   // runtime
  pr_number: number | null;     // runtime
}
```

## workflow.json

状态持久化在 OS 用户 state，不写工作树或 Git 私有目录，因此不会进入 PR diff、污染 checkout 或改变 `git status`。

`hy_edit` 额外写入同一 project state 目录的 `scope.json` 锁定当前 scope。仍要求真实 Git worktree 来计算稳定身份；非 Git 目录会结构化失败。

## Related

- [Architecture](./architecture.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)

## Async verify transition

hy_exam_plan keeps the workflow in verify while issuing a two-hour exam. hy_exam_submit moves to commit only after exact evidence and the scope fingerprint pass; failed evidence returns to edit for correction and partial resubmission. This is equivalent to a successful hy_verify and persists the same manifest hash and implementation digest before commit.
