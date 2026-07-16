# State Machine

工作流状态机定义在 `src/state.ts` 中。每个 Phase 的合法转换由 `VALID_TRANSITIONS` 硬编码，禁止跳 Phase。

## Phase 定义

| # | Phase | 含义 |
|---|-------|------|
| 1 | `init` | 等待 `hy_init` 验证 deployment/tool/artifact evidence、两个团队文件、base ref 与文档事实 readiness |
| 2 | `plan` | 任务规划，先由 agent 自动执行 `hy_read_docs(before_plan)` 建立文档事实基线，再生成 PlanDoc |
| 3 | `approve` | 用户审视 PlanDoc；用户批准后 agent 自动执行 `hy_read_docs(before_approve)` 做文档审计，再输入 `"approve"` 放行 |
| 4 | `branch` | 创建 git 分支，等待 LLM 调用 `hy_branch` |
| 5 | `edit` | LLM 编写代码，scope 已锁定；实现后运行 `hy_read_docs(after_edit)` 和 `hy_sync_docs` |
| 6 | `verify` | 本地任务 gate（compile/scope/boundary/platform/smoke/tests），通过则进 commit |
| 7 | `commit` | git commit 后先持久化 exact commit/base/repository identity，再 exact-SHA push；精确查找并复用同 repository/base/head/headRefOid 的唯一 OPEN PR，零匹配时才创建并复查 |
| 8 | `ci` | 每次轮询同时复查 PR repository/base/head/headRefOid；identity 漂移、无 checks 或仅 skipped/neutral 均 fail closed |
| 9 | `merge` | 再次复查 PR identity，并用 `--match-head-commit` 锁定已验证 OID 后合并 |
| 10 | `chain` | rebase 下游分支 |
| — | `done` | 终结状态，不再继续 |

## VALID_TRANSITIONS

定义在 `src/state.ts` 的 `VALID_TRANSITIONS`。每个 Phase 可转移到自身（原地不动）或以下目标：

```
init     → init, plan, done
plan     → plan, approve, done
approve  → approve, branch, plan
branch   → branch, edit, done
edit     → edit, verify, commit, done
verify   → verify, edit, commit, done
commit   → commit, ci, done
ci       → ci, edit, merge, done
merge    → merge, chain, done
chain    → chain, done
done     → done
```

首次初始化只在 deployment 或项目尚未初始化时执行：
```
hy_init → hy_read_docs(before_plan) → hy_plan
```

后续每个开发任务的完整关键路径：
```
hy_status → hy_read_docs(before_plan) → hy_plan → hy_read_docs(before_approve) → hy_approve → hy_branch → hy_edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain → hy_reset
```

失败或驳回分支：
```
hy_approve 驳回 → plan
hy_verify 失败 → edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify
hy_ci 检查失败 → edit → hy_edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify → hy_commit → hy_ci
hy_ci 无 checks 或仅 skipped/neutral → ci（CI_CHECKS_REQUIRED，阻止 hy_merge/hy_chain）
hy_ci pending 或 API 异常 → ci（等待后重试 hy_ci，不进入 edit）
hy_commit 在 push/PR API 失败 → commit（仅当完整验证快照、持久化 recovery record 与 HEAD 全部一致时复用，不创建空提交）
```

## 文档读取 gate

`hy_read_docs` 不新增状态机 phase，而是在 `plan`、`approve` 和 `edit` phase 内作为自动 gate 运行。

每次返回是 task-ranked 有界页：最多 12 files、48,000 chars、单文件 12,000 chars并带 token estimate；`pagination.nextCursor` 读取后续页。DocsGraph 全量 digest/link index 位于用户 cache，workflow state 的 `documentReads` 只保存 path/size/SHA/truncation/budget/pagination/digest，不保存返回 excerpts。空/无实质事实、过期 `hy-workflow-rules-version` 或零相关事实直接阻断对应 phase。

- `before_plan`: 运行于 `plan` phase，记录用户 task 并写入 `documentReads.beforePlan`。`hy_plan` 缺少 baseline 时拒绝执行；baseline task 与 PlanDoc task 文案不一致时只给 warning，不阻断同一任务的自然改写。
- `before_approve`: 运行于 `approve` phase，绑定当前 PlanDoc hash，写入 `documentReads.beforeApprove`。如果本次读取的文档 digest 或全量 DocsGraph digest 相对 `before_plan` 发生变化，snapshot 会记录 `changedSinceBaseline: true`，`documentReadHealth` 会将其标记为 stale，`hy_approve` 拒绝批准并要求重新生成 PlanDoc。
- `after_edit`: 运行于 `edit` / `verify` phase，绑定当前 PlanDoc hash 和实现 diff digest，写入 `documentReads.afterEdit`。`hy_verify` 缺少 current 审计时拒绝执行。

`documentReadHealth` 从 metadata 派生每个 gate 的 `missing/current/stale`。PlanDoc hash、实现 digest 或全量 DocsGraph digest 不匹配时，旧下游读取不能复用；before_plan task 文案不一致仅诊断。`hy_status` 显示阻塞和下一工具，`hy_plan` 清空 downstream gate，避免新计划继承旧审计。

这些 gate 不要求用户审核。用户仍只审核 `hy_plan` 生成的 PlanDoc，以及 `hy_amend_plan` 这类 scope 修订。`hy_plan` 进入 approve 前会拒绝 malformed PlanDoc、空 scope、越出项目根目录的任何 scope 路径，以及不存在的 `scope.changes` / `scope.delete` 路径；计划创建的文件必须放在 `scope.new_files`，可以在审批时尚不存在，但路径仍必须位于项目根内。`hy_amend_plan` 应用 pending amendment 时复用同一套路径与非空 scope 规则。

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
}
```

- `readState()`: 新文件不存在时读取旧 `.git/hy-workflow/workflow.json` 或 `.hy/workflow.json` 并复制到用户 state；旧文件不自动删除。没有状态时返回 `phase: init`
- `writeState()`: 原子写入用户 state 并自动创建父目录
- `projectRoot()`: 向上查找 `.git`，找不到则报 `PROJECT_ROOT_NOT_FOUND`，不会在非 Git 目录创建伪 `.git/hy-workflow` 状态

## 状态守卫

- `assertPhase(state, ...expected)`: 当前 Phase 不在期望列表中时抛 `StateError`
- `transition(state, to)`: 转换不在 VALID_TRANSITIONS 中时抛 `StateError`
- 所有工具 handler 都在入口处调用 `assertPhase`，确保按序执行

## verifyHash

`computeVerifyHash()` 对 PlanDoc 的 task + scope + boundary + rubrics 字段，以及 `hy_verify` 记录的实现文件集合摘要和实现内容摘要做 SHA256 取前 12 位。`hy_verify` 通过后写入 `WorkflowState.verifyHash`、`implementationManifest`、`verifiedManifestHash` 和 `verifiedImplementationDigest`。`hy_commit` 不只检查 verifyHash 是否存在，还会确认当前 Git 分支等于 `state.branch`，当前 manifest 等于已验证 manifest，当前文件内容摘要等于已验证摘要，并重新计算 verifyHash。任何一项不匹配都会停在 commit phase，要求重新执行 `hy_read_docs(after_edit)`、`hy_sync_docs` 和 `hy_verify`。

`hy_commit` 生成 commit/PR body 时，会从当前 `WorkflowState.plan` 直接序列化完整 PlanDoc JSON，并额外写入 `planHash` 与顶层 `verifyHash`。如果 `hy_amend_plan` 修改过 scope，必须重新 `hy_verify` 后才能进入 commit，因此 PR body 记录的是 amended 后重新验证过的当前 PlanDoc 快照。CI、merge、chain 和 reset 阶段不会再改写 PR body。`hy_reset` 会清空 plan、approval、branch、PR、verifyHash、pending amendment、manifest、document reads 和 syncDocs 等派生状态，避免新计划继承旧运行态。

`hy_commit` commit 后再次核对路径集合和内容摘要，把 commit OID、verifyHash、branch、baseBranch 与带 host 的 repository 写入 approval 派生状态，再用该 commit OID 的精确 refspec 推送。origin fetch/push URL 必须解析为同一 repository；PR 操作忽略 `GH_REPO` 与 `GH_HOST`，并查询 repository/base/head/headRefOid 精确匹配的 OPEN PR：唯一匹配直接复用，零匹配才调用 `gh pr create`，多匹配、旧 OID、查询失败、JSON 异常或上下文不精确匹配均 fail closed。create 成功也要 post-lookup 确认；命令失败但远端已接收时，只有 exact post-lookup 才可恢复。

若 push 或 PR 步骤失败，状态保持 `commit` 且 recovery record 已在任何远端副作用前落盘。下一次 `hy_commit` 仍先验证 branch、manifest、digest 和 verifyHash；仅在这些证据、base/repository、recovery record 与当前 clean `HEAD` 全部一致时，复用记录中的 commit OID 作为 `recovered_verified_head`，再次 exact-SHA push 并复用 PR。缺少记录或插入空提交都会 fail closed。`hy_ci` 每次查询同时比较 PR tuple；`hy_merge` 再比较一次并传 `--match-head-commit`。复用不会覆盖既有 PR body；新建时才写入本次生成的 PlanDoc body。

## ToolResult envelope

字段契约定义在 `src/output/contract.ts`，运行时 helper 和 TypeScript shape 定义在 `src/output/envelope.ts`。`next` 是状态机下一步；`phase` 默认等于 `next`，但 `hy_edit` 等工具可返回 `phase: "edit"`、`next: "verify"` 来表达“当前仍在 edit，但下一步建议 verify”。

```typescript
interface ToolResult {
  ok?: boolean;
  phase?: Phase;
  next: Phase;
  status?: string;
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

状态持久化在 OS 用户 state，不写工作树或 Git 私有目录，因此不会进入 PR diff、污染 checkout 或改变 `git status`。旧状态仅作为兼容迁移源读取。

`hy_edit` 额外写入同一 project state 目录的 `scope.json` 锁定当前 scope。旧 `.git/hy-workflow/scope.json` 和 `.hy/scope.json` 可复制迁移但不会自动删除。仍要求真实 Git worktree 来计算稳定身份；非 Git 目录会结构化失败。

## Related

- [Architecture](./architecture.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
