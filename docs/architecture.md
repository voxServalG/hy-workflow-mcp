# Architecture

## Configuration Model

`hy-workflow.json` is the single editable project config. The three older JSON files are generated compatibility artifacts: `codelint.json`, `doclint.json`, and `docs-gardener.json`.

`project.baseBranch`, `project.codeExt`, `project.codeDirs`, and `project.docsDir` are shared config. `project.codeExt` accepts one extension string, a comma-separated extension string, or a string array. Known extensions are aligned with doclint comment-syntax coverage, and `.tksp` is supported explicitly. Tool-specific config stays scoped to its tool section, including `codelint.lintDirs`, `codelint.maxLines`, `doclint.maxLines`, and `docsGardener.catalogs`.

Tracked setup artifacts include `.github/`, `AGENTS.md`, `.gitignore`, `hy-workflow.json`, and the three compatibility JSON files. Local runtime or client artifacts include `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, and runtime doc artifacts (`.git/hy-workflow/docs-graph.json`).

hy-workflow-mcp 是一个 MCP server，强制 LLM agent 走带文档同步 gate 的闭环工作流。通过状态机锁定 Phase 转换、lint 校验、用户 approve gate 三层机制，确保每次代码/文档变更可审计。

## 组件关系

```
server.ts  ── 注册 14 个 MCP Tool ──►  tools/*.ts  ── 读写状态 ──►  state.ts
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
   └► tools/edit.ts 锁定 scope 到 .git/hy-workflow/scope.json → transition(state, "edit")

5. LLM 编辑代码...

6. LLM hy_read_docs(after_edit)
   └► tools/read_docs.ts → 读取 docs 并绑定当前实现 diff digest

7. LLM hy_sync_docs()
   └► tools/sync_docs.ts → 确认文档同步 gate，限定 plan.scope 内文档或 setup prompt 文件

8. LLM hy_verify()
   └► checks.ts.runAllChecks() → 全绿则 transition(edit→commit)

9. LLM hy_commit(title, body)
   └► tools/commit.ts → git add/commit/push/gh pr create → phase=ci

10. LLM hy_ci()
   └► tools/ci.ts → gh pr checks 轮询 → 全绿则 transition(ci→merge)；失败则 transition(ci→edit) 回到 edit 修复

11. LLM hy_merge()
   └► tools/merge.ts → gh pr merge → phase=chain

12. LLM hy_chain(branches)
    └► tools/chain.ts → 逐个 rebase 下游分支 → phase=done
```

## 关键设计决策

- **状态文件**: `.git/hy-workflow/workflow.json` 持久化 Phase、PlanDoc、Approval、verifyHash，`.git/hy-workflow/scope.json` 锁定当前 scope；旧 `.hy/workflow.json` / `.hy/scope.json` 仅作为迁移来源或诊断对象
- **项目根定位**: `projectRoot()` 向上查找 `.git` 目录
- **幂等 init**: `setup` 直接部署 lint/docs/docs-gardener bootstrap 产物并写 setup stamp；MCP runtime 每 session 首次只读检查 stamp；`hy_init` 验证产物、写入 workflow rules 并维护本地忽略项，不在 MCP 内运行 setup 或启动交互式 TUI
- **配置保护**: `setup` 对 codelint/doclint/docs-gardener JSON 使用 preserve-first 合并；`hy_init` 只读检测明显不一致并返回 config 命令，不在 MCP 内改写用户配置
- **软硬结合**: 状态机硬锁定（禁止跳 phase）+ 用户 approve gate（软决策）
- **Promotion 例外**: 状态机闭环服务于普通开发改动合入 `baseBranch`；`baseBranch → releaseBranch`（如 dev → main）属于发布/晋级操作，不伪造 scope，也不硬套 `hy_branch`/`hy_commit`，必须在用户授权后通过 promotion PR 完成
- **Artifact contract**: setup/hy_init 生成的 tracked project artifacts（`.github/`、`AGENTS.md`、`.gitignore`、`hy-workflow.json`、lint/gardener compatibility configs）应提交；local/runtime/client artifacts（`.hy/`、`.opencode/`、`.codex/`、`.mcp.json`、setup stamp）不提交；setup 产生 tracked drift 时先做 artifact sync PR

## 配置文件

| 文件 | 用途 |
|------|------|
| `codelint.json` | 代码检查规则：`codeExt`（代码文件扩展名，可为 `.tksp`、`.ts`、`.tksp,.ts` 或数组）、`baseBranch`（Git 基准分支）、`codeDirs`（源码目录）、`maxLines` |
| `doclint.json` | 文档检查规则 |
| `docs-gardener.json` | docs-gardener MCP 逻辑规则 |


## 构建与 CI

`package.json` 提供 `tsc` 编译入口，`tsconfig.json` 配置 ES2022 + NodeNext 模块。CI 由 `.github/workflows/code-quality.yml`（codelint + compile）和 `docs-check.yml`（doclint）组成。

## Related

- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
