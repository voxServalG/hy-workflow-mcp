# Tools Reference

hy-workflow MCP server 注册了 12 个工具，定义在 `src/tools/` 中。分发逻辑在 `src/server.ts:311-325`。工具返回保留 legacy 字段，同时补充 agent-facing envelope；详见 [Tool Result Envelope](./tool-result-envelope.md)。

## 概览

| Tool | Phase 进入要求 | 参数 | 转换到 | 只读? |
|------|---------------|------|--------|-------|
| `hy_init`   | init | — | plan | 否 |
| `hy_plan`   | plan | `{task}` | plan (返回 next=approve) | 否 |
| `hy_approve` | plan, approve | `{approved: string, note: string}` | branch (批准) / plan (驳回) | 否 |
| `hy_branch` | approve, branch | `{category, topic}` | edit | 否 |
| `hy_edit`   | branch, edit, verify | — | edit (返回 next=verify) | 否 |
| `hy_verify` | edit, verify | — | commit (通过) / edit (失败) | 否 |
| `hy_commit` | commit | `{title, body}` | ci | 否 |
| `hy_ci`     | ci, edit | — | merge (全绿) / edit (失败) | 否 |
| `hy_merge`  | merge | — | chain | 否 |
| `hy_chain`  | chain | `{branches: string[]}` | done | 否 |
| `hy_reset`  | 任意 | — | plan | 否 |
| `hy_status` | 任意 | — | — | 是 |

---

## hy_init

**资源**: `src/tools/init.ts`

验证 setup 已部署 hy-harness 产物（codelint + doclint + docs-gardener + CI workflows），写入/更新 `AGENTS.md` workflow 规则，清理旧 `.opencode/instructions.md` 规则片段，并幂等维护 `.gitignore` 中的本地运行态忽略项。`hy_init` 不会在 MCP 内执行 hy-harness，也不会启动交互式 TUI。

- **进入 Phase**: `init`, `plan`
- **转换到**: `plan`
- **成功返回**: `{ next: "plan", message, display, commitArtifacts, localArtifacts, requiredHarnessArtifacts, gitignoreChanged }`
- **失败返回**: `{ next: "init", error: { type: "harness_missing", missingArtifacts }, requires_user: true, stop_here: true, recovery }`

**参见**: `src/tools/init.ts`, `src/state.ts:114-118`（writeState）

`hy_init` 返回 `commitArtifacts`（`.github/`、`AGENTS.md`、`codelint.json`、`doclint.json`、`docs-gardener.json`）和 `localArtifacts`（`.hy/`、`.opencode/`），并幂等确保 `.gitignore` 忽略本地产物。缺少核心 harness 产物（`.github/`、`codelint.json`、`doclint.json`、`docs-gardener.json`）时，agent 必须停下并请用户在终端重新运行 setup。

---

## hy_plan

**资源**: `src/tools/plan.ts` (246 行)

分析 task 后经历 7 道校验关（前 6 为 hard gate，第 7 为语义质量 soft gate）：

1. 必填字段完整性（task, scope, boundary, verify, risks, discussion）
2. scope 非空（changes / new_files / delete 至少有一个非空）
3. boundary 有实质内容（dependency_dag 非空，entry_points ≥ 1）
4. verify 有实质内容（platform, smoke, tests 各 ≥ 1）
5. risks ≥ 1，discussion 非空
6. 禁止空洞命令（`echo ok` 等）
7. 语义质量 — task/risks/discussion 长度过短时警告（soft，不阻止通关）

- **进入 Phase**: `plan`
- **转换到**: `approve`
- **成功返回**: `{ next: "approve", plan, summary, display, requires_user: true, stop_here: true, allowedTools, blockedTools, message }`
- **失败返回**: `{ next: "plan", error, fallback: {message, schema} }`

**参见**: `src/tools/plan.ts:7-246`

---

## hy_approve

**资源**: `src/tools/approve.ts` (40 行)

用户审视 PlanDoc 的入口。`approved` 必须传字符串 `"approve"` 才放行（严格匹配，同时容错 `"true"`）。其他任何内容视为驳回理由，回到 `plan`。

- **进入 Phase**: `approve`
- **批准后转换到**: `branch`，写入 Approval 记录
- **驳回后转换到**: `plan`
- **批准返回**: `{ next: "branch", approved: true, plan, pipeline, stopAfter: "hy_reset", allowedTools }`
- **驳回返回**: `{ next: "plan", approved: false, note }`

**参见**: `src/tools/approve.ts:1-40`, `src/state.ts:146-155`（transition）

---

## hy_branch

**资源**: `src/tools/branch.ts` (26 行)

创建 git 分支，格式 `{category}/{topic}`。category 必须在 `["refactor","feat","chore","docs","ci","fix","test"]` 中。

- **进入 Phase**: `approve`, `branch`
- **转换到**: `edit`
- **返回**: `{ next: "edit", branch, hint, allowedTools }` 或 `{ error, recovery }`

**参见**: `src/tools/branch.ts:5-26`, `src/git.ts:22-28`（createBranch）

---

## hy_edit

**资源**: `src/tools/edit.ts` (45 行)

锁定 scope 到 Git 私有状态文件 `.git/hy-workflow/scope.json`，避免 runtime metadata 污染工作区。workflow phase 本身也写入 Git 私有状态文件，不推进 Phase（手动设为 edit），返回 `next: "verify"`、`phase: "edit"` 提示 LLM 开始编写代码。

- **进入 Phase**: `branch`, `edit`, `verify`
- **转换到**: `transition(state, "edit")`，返回 `next: "verify"`
- **返回**: `{ next: "verify", phase: "edit", branch, scope, boundary, display, hint, allowedTools, blockedTools, message }`

**参见**: `src/tools/edit.ts:11-45`（通过 transition(state, "edit") 切换状态）, `.git/hy-workflow/scope.json`（scope 锁定文件）

## Legacy runtime metadata

旧版本可能在工作区留下 `.hy/workflow.json` 或 `.hy/scope.json`。当前版本会在迁移到 `.git/hy-workflow/` 后静默删除未被 Git 跟踪的 legacy runtime 文件，避免它们阻挡 `git checkout`。如果这些 legacy 文件已被 Git 跟踪，hy-workflow 不会自动删除；`hy_status` / `hy_init` 会返回 `legacyDiagnostics`，提示运行 `git rm --cached .hy/workflow.json .hy/scope.json` 并忽略 `.hy/`。

---

## hy_verify

**资源**: `src/tools/verify.ts` (43 行)

执行 6 层全量校验（`src/checks.ts:runAllChecks`）。全部通过后计算 verifyHash 并转换到 commit。

- **进入 Phase**: `edit`, `verify`
- **通过后转换到**: `commit`
- **失败后转换到**: `edit`
- **通过返回**: `{ next: "commit", allPassed: true, checks, verifyHash, hint, allowedTools }`
- **失败返回**: `{ next: "edit", allPassed: false, hardFailed, checks, failedChecks, recovery.byLayer }`

**参见**: `src/tools/verify.ts:5-43`, `src/checks.ts:193-207`（runAllChecks）

---

## hy_commit

**资源**: `src/tools/commit.ts` (55 行)

git add -A → commit → push → gh pr create。PR body 自动附加 scope/boundary/verify 元信息和 verifyHash。

- **进入 Phase**: `commit`
- **转换到**: `ci`
- **返回**: `{ next: "ci", prNumber, url, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

**参见**: `src/tools/commit.ts:5-55`, `src/git.ts:30-65`（commitAll/push/createPr）

---

## hy_ci

**资源**: `src/tools/ci.ts` (34 行)

通过 `gh pr view --json statusCheckRollup` 轮询 GitHub CI 状态。

- **进入 Phase**: `ci`, `edit`
- **全绿后转换到**: `merge`
- **失败后转换到**: `edit`（通过 transition(state, "edit") 并 writeState）
- **pending/API 异常**: 保持 `ci`，等待后重试 `hy_ci`
- **返回**: 全绿 `{ next: "merge", allGreen: true, checks, display, hint }`；pending `{ next: "ci", pending: true, requires_user: true, stop_here: true, recovery }`；失败 `{ next: "edit", failedChecks, requires_user: true, stop_here: true, recovery }`

**参见**: `src/tools/ci.ts:1-34`, `src/git.ts:72-88`（checkCi）

---

## hy_merge

**资源**: `src/tools/merge.ts` (18 行)

通过 `gh pr merge --merge --delete-branch` 合并 PR。

- **进入 Phase**: `merge`
- **转换到**: `chain`
- **返回**: `{ next: "chain", prNumber, display, hint }` 或 `{ error, requires_user: true, stop_here: true, recovery }`

**参见**: `src/tools/merge.ts:5-18`, `src/git.ts:67-70`（mergePr）

---

## hy_chain

**资源**: `src/tools/chain.ts` (33 行)

依次 checkout 每个下游分支 → rebase 到 `codelint.json: baseBranch` 对应的最新基准分支 → force push → 切回基准分支。

- **进入 Phase**: `chain`
- **转换到**: `done`
- **返回**: `{ next: "done", done: [...完成的], message }`

**参见**: `src/tools/chain.ts:5-31`, `src/git.ts:90-105`（checkout/pull/rebaseDev/pushForce）

---

## hy_status

**资源**: `src/tools/status.ts` (26 行)

只读工具，可任意阶段调用。返回当前 WorkflowState 快照。

- **进入 Phase**: 无限制
- **转换到**: 无（只读）
- **返回**: `{ phase, branch, prNumber, plan, approved, verified, next, hint, allowedTools, action? }`

**参见**: `src/tools/status.ts:1-26`, `src/state.ts:97-112`（readState）

## Related
[Architecture](./architecture.md) · [State Machine](./state-machine.md) · [Verify Pipeline](./verify.md)
