# Tools Reference

hy-workflow MCP server 注册了 11 个工具，定义在 `src/tools/` 中。分发逻辑在 `src/server.ts:290-305`。

## 概览

| Tool | Phase 进入要求 | 参数 | 转换到 | 只读? |
|------|---------------|------|--------|-------|
| `hy_init`   | init | — | plan | 否 |
| `hy_plan`   | plan | `{task, plan: PlanDoc}` | plan (返回 next=approve) | 否 |
| `hy_approve` | plan, approve | `{approved: string, note?}` | branch (批准) / plan (驳回) | 否 |
| `hy_branch` | approve, branch | `{category, topic}` | edit | 否 |
| `hy_edit`   | branch, edit, verify | — | edit (返回 next=verify) | 否 |
| `hy_verify` | edit, verify | — | commit (通过) / edit (失败) | 否 |
| `hy_commit` | commit | `{title, body}` | ci | 否 |
| `hy_ci`     | ci, edit | — | merge (全绿) / edit (失败) | 否 |
| `hy_merge`  | merge | — | chain | 否 |
| `hy_chain`  | chain | `{branches: string[]}` | done | 否 |
| `hy_status` | 任意 | — | — | 是 |

---

## hy_init

**资源**: `src/tools/init.ts` (24 行)

部署 hy-harness（codelint + doclint + docs-gardener + CI workflows），60 秒超时。

- **进入 Phase**: `init`
- **转换到**: `plan`
- **成功返回**: `{ next: "plan", message: "Harness deployed..." }`
- **失败返回**: `{ next: "init", error: "Harness deployment failed..." }`

---

## hy_plan

**资源**: `src/tools/plan.ts` (130 行)

验证并持久化 PlanDoc。6 道校验关：

1. 必填字段完整性（task, scope, boundary, verify, risks, discussion）
2. scope 非空（changes / new_files / delete 至少有一个非空）
3. boundary 有实质内容（dependency_dag 非空，entry_points ≥ 1）
4. verify 有实质内容（platform, smoke, tests 各 ≥ 1）
5. risks ≥ 1，discussion 非空
6. 禁止空洞命令（`echo ok` 等）

调用 `garden-scan` 获取基线上下文（非致命）。

- **进入 Phase**: `plan`
- **转换到**: 保持 `plan`，返回 `next: "approve"`
- **成功返回**: `{ next: "approve", baseline, plan, message }`
- **失败返回**: `{ next: "plan", error }`

---

## hy_approve

**资源**: `src/tools/approve.ts` (40 行)

用户审视 PlanDoc 的入口。`approved` 必须传字符串 `"approve"` 才放行（严格匹配）。其他任何内容视为驳回理由，回到 `plan`。

- **进入 Phase**: `plan`, `approve`
- **批准后转换到**: `branch`，写入 Approval 记录
- **驳回后转换到**: `plan`
- **批准返回**: `{ next: "branch", approved: true, plan, pipeline, stopAfter: "hy_commit" }`
- **驳回返回**: `{ next: "plan", approved: false, note }`

---

## hy_branch

**资源**: `src/tools/branch.ts` (26 行)

创建 git 分支，格式 `{category}/{topic}`。category 必须在 `["refactor","feat","chore","docs","ci","fix","test"]` 中。

- **进入 Phase**: `approve`, `branch`
- **转换到**: `edit`
- **返回**: `{ next: "edit", branch }` 或 `{ error }`

---

## hy_edit

**资源**: `src/tools/edit.ts` (45 行)

锁定 scope 到 `.hy/scope.json`。不推进 Phase（手动设为 edit），返回 `next: "verify"` 提示 LLM 开始编写代码。

- **进入 Phase**: `branch`, `edit`, `verify`
- **转换到**: 手动 `phase = edit`，返回 `next: "verify"`
- **返回**: `{ next: "verify", branch, scope, boundary, message }`

---

## hy_verify

**资源**: `src/tools/verify.ts` (40 行)

执行 6 层全量校验（`src/checks.ts:runAllChecks`）。全部通过后计算 verifyHash 并转换到 commit。

- **进入 Phase**: `edit`, `verify`
- **通过后转换到**: `commit`
- **失败后转换到**: `edit`
- **通过返回**: `{ next: "commit", allPassed: true, checks, verifyHash }`
- **失败返回**: `{ next: "edit", allPassed: false, hardFailed, checks }`

---

## hy_commit

**资源**: `src/tools/commit.ts` (60 行)

git add -A → commit → push → gh pr create。PR body 自动附加 scope/boundary/verify 元信息和 verifyHash。

- **进入 Phase**: `commit`
- **转换到**: `ci`
- **返回**: `{ next: "ci", prNumber, url }` 或 `{ error }`

---

## hy_ci

**资源**: `src/tools/ci.ts` (40 行)

通过 `gh pr view --json statusCheckRollup` 轮询 GitHub CI 状态。

- **进入 Phase**: `ci`, `edit`
- **全绿后转换到**: `merge`
- **失败后转换到**: `edit`
- **全绿返回**: `{ next: "merge", allGreen: true, checks }`
- **失败返回**: `{ next: "edit", allGreen: false, checks }`

---

## hy_merge

**资源**: `src/tools/merge.ts` (22 行)

通过 `gh pr merge --merge --delete-branch` 合并 PR。

- **进入 Phase**: `merge`
- **转换到**: `chain`
- **返回**: `{ next: "chain", prNumber }`

---

## hy_chain

**资源**: `src/tools/chain.ts` (45 行)

依次 checkout 每个下游分支 → rebase 到最新 dev → force push → 切回 dev。

- **进入 Phase**: `chain`
- **转换到**: `done`
- **返回**: `{ next: "done", done: [...完成的], message }`

---

## hy_status

**资源**: `src/tools/status.ts` (26 行)

只读工具，可任意阶段调用。返回当前 WorkflowState 快照。

- **进入 Phase**: 无限制
- **转换到**: 无（只读）
- **返回**: `{ phase, branch, prNumber, plan, approved, verified, next, action? }`

## Related

- [Architecture](./architecture.md)
- [State Machine](./state-machine.md)
- [Verify Pipeline](./verify.md)
