# State Machine

工作流状态机定义在 `src/state.ts` 中。每个 Phase 的合法转换由 `VALID_TRANSITIONS` 硬编码，禁止跳 Phase。

## Phase 定义

| # | Phase | 含义 |
|---|-------|------|
| 1 | `init` | 初始状态，等待 `hy_init` 验证 setup/bootstrap 产物 |
| 2 | `plan` | 任务规划，先由 agent 自动执行 `hy_read_docs(before_plan)` 建立文档事实基线，再生成 PlanDoc |
| 3 | `approve` | 用户审视 PlanDoc；用户批准后 agent 自动执行 `hy_read_docs(before_approve)` 做文档审计，再输入 `"approve"` 放行 |
| 4 | `branch` | 创建 git 分支，等待 LLM 调用 `hy_branch` |
| 5 | `edit` | LLM 编写代码，scope 已锁定；实现后运行 `hy_read_docs(after_edit)` 和 `hy_sync_docs` |
| 6 | `verify` | 全量校验（7 层），通过则进 commit |
| 7 | `commit` | git commit + push + gh pr create |
| 8 | `ci` | 轮询 GitHub Checks |
| 9 | `merge` | CI 全绿后合并 PR |
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

关键路径：
```
init → plan → approve → branch → edit → hy_read_docs(after_edit) → hy_sync_docs → verify → commit → ci → merge → chain → done
    ↑                   ↑                        ↑                   ↑
 驳回回到 plan      驳回回到 plan          verify fail→edit      CI fail→edit
                                         edit → verify → commit (新)
```

## 文档读取 gate

`hy_read_docs` 不新增状态机 phase，而是在 `plan`、`approve` 和 `edit` phase 内作为自动 gate 运行。

- `before_plan`: 运行于 `plan` phase，绑定用户 task，写入 `documentReads.beforePlan`。`hy_plan` 缺少匹配 baseline 时拒绝执行。
- `before_approve`: 运行于 `approve` phase，绑定当前 PlanDoc hash，写入 `documentReads.beforeApprove`。`hy_approve` 缺少 current 审计时拒绝批准。
- `after_edit`: 运行于 `edit` / `verify` phase，绑定当前 PlanDoc hash 和实现 diff digest，写入 `documentReads.afterEdit`。`hy_verify` 缺少 current 审计时拒绝执行。

`documentReadHealth` 从现有状态派生每个 gate 的 `missing` / `current` / `stale` 状态。PlanDoc hash、task 或实现 digest 不匹配时，旧的 `documentReads` 不会被复用；`hy_status` 会显示 `blockedBy`、`staleDocumentReads` 和下一步工具。`hy_plan` 写入新 PlanDoc 时会清空 downstream gate（`beforeApprove`、`afterEdit`、`syncDocs`），避免新 plan 继承旧审计。

这些 gate 不要求用户审核。用户仍只审核 `hy_plan` 生成的 PlanDoc，以及 `hy_amend_plan` 这类 scope 修订。

## 状态持久化

状态文件: `.git/hy-workflow/workflow.json`

```typescript
interface WorkflowState {
  version: "1";
  phase: Phase;
  branch: string | null;
  prNumber: number | null;
  plan: PlanDoc | null;
  approval: Approval | null;
  verifyHash: string | null;
  documentReads?: DocumentReads | null;
  syncDocs?: SyncDocsRecord | null;
}
```

- `readState()`: 文件不存在时返回 `phase: init` 默认值，并迁移未跟踪的旧 `.hy/workflow.json`
- `writeState()`: 自动创建 Git 私有运行态目录
- `projectRoot()`: 向上查找 `.git`，找不到则用 `cwd`

## 状态守卫

- `assertPhase(state, ...expected)`: 当前 Phase 不在期望列表中时抛 `StateError`
- `transition(state, to)`: 转换不在 VALID_TRANSITIONS 中时抛 `StateError`
- 所有工具 handler 都在入口处调用 `assertPhase`，确保按序执行

## verifyHash

`computeVerifyHash()` 对 PlanDoc 的 task + scope + boundary + rubrics 字段做 SHA256 取前 12 位。`hy_verify` 写入 `verifyHash`；当前 `hy_commit` 检查该值存在，确保 commit 前成功跑过 verify。

## ToolResult envelope

定义在 `src/tools/_base.ts`。`next` 是状态机下一步；`phase` 默认等于 `next`，但 `hy_edit` 等工具可返回 `phase: "edit"`、`next: "verify"` 来表达“当前仍在 edit，但下一步建议 verify”。

```typescript
interface ToolResult {
  ok?: boolean;
  phase?: Phase;
  next: Phase;
  display?: { title?: string; body?: string; files?: string[]; urls?: string[] };
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: { tool?: string; instruction?: string; byLayer?: Record<string, string> };
}
```

## PlanDoc 结构

```typescript
interface PlanDoc {
  task: string;
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

状态持久化在 Git 私有目录 `.git/hy-workflow/workflow.json`，通过 `git rev-parse --git-path` 解析真实路径，避免运行态文件进入工作树、PR diff 或 checkout 冲突。`readState()` 在新文件不存在时会读取旧 `.hy/workflow.json` 并迁移；没有任何状态文件时返回 `phase: init` 默认值。

`hy_edit` 额外写入 `.git/hy-workflow/scope.json` 锁定当前 scope 边界，供 LLM 参考。旧 `.hy/scope.json` 只作为 legacy runtime metadata 诊断和清理对象。

## Related

- [Architecture](./architecture.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
