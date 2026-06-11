# Architecture

hy-workflow-mcp 是一个 MCP server，强制 LLM agent 走 **9 阶段闭环工作流**。通过状态机锁定 Phase 转换、lint 校验、用户 approve gate 三层机制，确保每次代码/文档变更可审计。

## 组件关系

```
server.ts  ── 注册 12 个 MCP Tool ──►  tools/*.ts  ── 读写状态 ──►  state.ts
    │                                      │                       │
    │                              ┌───┬───┼───┬───┐               │
    │                              │   │       │   │               │
    ▼                              ▼   ▼       ▼   ▼               ▼
 MCP Client                  git.ts  checks.ts     ── exec ──►  .git/hy-workflow/workflow.json
 (stdio transport)               │       │
                                 │       ├── doclint
                                 │       ├── codelint
                                 │       ├── compile (tsc)
                                 │       ├── scope check
                                 │       ├── boundary check
                                 │       ├── platform
                                 │       ├── smoke
                                 │       └── tests
                                 │
                                 ▼
                            git / gh CLI
```

## 数据流

```
1. LLM 调用 hy_plan({task, plan})，自行构造 PlanDoc JSON
   └► tools/plan.ts → 7 gate 校验 → writeState(phase=plan)

2. 用户 hy_approve(approved="approve")
   └► tools/approve.ts → transition(approve→branch) → writeState

3. LLM hy_branch(category, topic)
   └► tools/branch.ts → git.ts.createBranch() → transition(branch→edit)

4. LLM hy_edit()
   └► tools/edit.ts 锁定 scope 到 .hy/scope.json → transition(state, "edit")

5. LLM 编辑代码...

6. LLM hy_verify()
   └► checks.ts.runAllChecks() → 全绿则 transition(edit→commit)

7. LLM hy_commit(title, body)
   └► tools/commit.ts → git add/commit/push/gh pr create → phase=ci

8. LLM hy_ci()
   └► tools/ci.ts → gh pr checks 轮询 → 全绿则 transition(ci→merge)；失败则 transition(ci→edit) 回到 edit 修复

9. LLM hy_merge()
   └► tools/merge.ts → gh pr merge → phase=chain

10. LLM hy_chain(branches)
    └► tools/chain.ts → 逐个 rebase 下游分支 → phase=done
```

## 关键设计决策

- **状态文件**: `.git/hy-workflow/workflow.json` 持久化 Phase、PlanDoc、Approval、verifyHash，不进入 git 工作树；旧 `.hy/workflow.json` 仅作为迁移来源
- **项目根定位**: `projectRoot()` 向上查找 `.git` 目录
- **幂等 init**: `setup` 部署 hy-harness 产物；`hy_init` 验证产物、写入 workflow rules 并维护本地忽略项，不在 MCP 内启动交互式 harness
- **软硬结合**: 状态机硬锁定（禁止跳 phase）+ 用户 approve gate（软决策）

## 配置文件

| 文件 | 用途 |
|------|------|
| `codelint.json` | 代码检查规则：`codeExt`（语言检测）、`baseBranch`（Git 基准分支）、`codeDirs`（源码目录）、`maxLines` |
| `doclint.json` | 文档检查规则 |
| `docs-gardener.json` | docs-gardener MCP 逻辑规则 |


## 构建与 CI

`package.json` 提供 `tsc` 编译入口，`tsconfig.json` 配置 ES2022 + NodeNext 模块。CI 由 `.github/workflows/code-quality.yml`（codelint + compile）和 `docs-check.yml`（doclint）组成。

## Related

- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
