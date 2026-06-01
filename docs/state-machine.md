# State Machine

工作流状态机定义在 `src/state.ts` 中。每个 Phase 的合法转换由 `VALID_TRANSITIONS` 硬编码，禁止跳 Phase。

## Phase 定义

| # | Phase | 含义 |
|---|-------|------|
| 1 | `init` | 初始状态，等待 `hy_init` 部署 harness |
| 2 | `plan` | 任务规划，等待 LLM 生成 PlanDoc |
| 3 | `approve` | 用户审视 PlanDoc，输入 `"approve"` 放行 |
| 4 | `branch` | 创建 git 分支，等待 LLM 调用 `hy_branch` |
| 5 | `edit` | LLM 编写代码，scope 已锁定 |
| 6 | `verify` | 全量校验（6 层），通过则进 commit |
| 7 | `commit` | git commit + push + gh pr create |
| 8 | `ci` | 轮询 GitHub Checks |
| 9 | `merge` | CI 全绿后合并 PR |
| 10 | `chain` | rebase 下游分支 |
| — | `done` | 终结状态，不再继续 |

## VALID_TRANSITIONS

定义在 `src/state.ts:122-134`。每个 Phase 可转移到自身（原地不动）或以下目标：

```
init     → init, plan, done
plan     → plan, approve, branch, done
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
init → plan → approve → branch → edit → verify → commit → ci → merge → chain → done
    ↑                   ↑                        ↑                   ↑
 驳回回到 plan      驳回回到 plan          verify fail→edit      CI fail→edit
                                         edit → verify → commit (新)
```

## 状态持久化

状态文件: `.hy/workflow.json`

```typescript
interface WorkflowState {
  version: "1";
  phase: Phase;
  branch: string | null;
  prNumber: number | null;
  plan: PlanDoc | null;
  approval: Approval | null;
  verifyHash: string | null;
}
```

- `readState()` (`src/state.ts:97`): 文件不存在时返回 `phase: init` 默认值
- `writeState()` (`src/state.ts:114`): 自动创建 `.hy/` 目录
- `projectRoot()` (`src/state.ts:84`): 向上查找 `.git`，找不到则用 `cwd`

## 状态守卫

- `assertPhase(state, ...expected)` (`src/state.ts:136`): 当前 Phase 不在期望列表中时抛 `StateError`
- `transition(state, to)` (`src/state.ts:146`): 转换不在 VALID_TRANSITIONS 中时抛 `StateError`
- 所有工具 handler 都在入口处调用 `assertPhase`，确保按序执行

## verifyHash

`computeVerifyHash()` (`src/state.ts:166`) 对 PlanDoc 的 task + scope + boundary + verify 字段做 SHA256 取前 12 位。`hy_commit` 校验此哈希，确保 PlanDoc 未被篡改。

## PlanDoc 生成

PlanDoc 有两种生成路径：

| 路径 | 条件 | 流程 |
|------|------|------|
| **API 自动** | `DEEPSEEK_API_KEY` 已设置 | `src/llm.ts:93` → 调 DeepSeek API（`deepseek-v4-pro`，`response_format: json_object`）→ 返回 PlanDoc → `src/tools/plan.ts` 6 gate 校验 |
| **手动构造** | 无 API Key 或 API 失败 | 服务端返回 PlanDoc JSON Schema → LLM 手动构造 PlanDoc 再次调用 hy_plan |

## ToolResult 类型

定义在 `src/tools/_base.ts`，所有 tool handler 返回的统一结构：

```typescript
interface ToolResult {
  next?: string;     // 下一阶段提示
  error?: string;    // 错误信息
  [key: string]: unknown;  // 扩展字段
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

## .hy/workflow.json

状态持久化在项目根目录的 `.hy/workflow.json`。`readState()`（`src/state.ts:97`）在文件不存在时返回 `phase: init` 默认值；`writeState()`（`src/state.ts:114`）自动创建 `.hy/` 目录。项目根通过 `projectRoot()`（`src/state.ts:84`）向上查找 `.git` 目录确定。

`hy_edit` 额外写入 `.hy/scope.json` 锁定当前 scope 边界，供 LLM 参考。

## Related

- [Architecture](./architecture.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
```
