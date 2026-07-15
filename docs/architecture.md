# Architecture

## Configuration Model

Root `hy-workflow.json` is the single editable project configuration source. MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input. Runtime requires explicit `project.baseBranch`, `project.codeExt`, `project.codeDirs`, `project.docsDir`, and `codelint.lintDirs`; normalization defaults must not make an incomplete root config pass `hy_init`. The three older JSON files are runtime compatibility artifacts only: `codelint.json`, `doclint.json`, and `docs-gardener.json`.

`project.baseBranch`, `project.codeExt`, `project.codeDirs`, and `project.docsDir` are shared config. `project.codeExt` accepts one extension string, a comma-separated extension string, or a string array. Known extensions are aligned with doclint comment-syntax coverage, and `.tksp` is supported explicitly. Tool-specific config stays scoped to its tool section, including `codelint.lintDirs`, `codelint.maxLines`, `doclint.maxLines`, and `docsGardener.catalogs`.

Setup has one deployment model and may write only `hy-workflow.json` and `.github/workflows/hy-workflow.yml`. Deployment, registry, workflow state, scope, DocsGraph, and client configuration live under OS user config/state/cache roots. Only the external deployment selected by canonical project identity satisfies the setup gate; even a current-version legacy project stamp does not. Legacy user config, manifests with a mode field, `.hy/`, client-project config, and `.git/hy-workflow/` are read-only migration inputs. Compatibility JSON may be read during migration and temporarily overwritten only while compatibility commands run; it is never an active configuration source or persistent default output.

hy-workflow-mcp 是一个 MCP server，强制 LLM agent 走带文档同步 gate 的闭环工作流。通过状态机锁定 Phase 转换、lint 校验、用户 approve gate 三层机制，确保每次代码/文档变更可审计。

## 组件关系

```
server.ts  ── 注册 15 个 MCP Tool ──►  tools/*.ts  ── 读写状态 ──►  state.ts
    │                                      │                       │
    │                              ┌───┬───┼───┬───┐               │
    │                              │   │       │   │               │
    ▼                              ▼   ▼       ▼   ▼               ▼
 MCP Client                  git.ts  checks.ts     ── state ─►  OS user state/projects/<id>/workflow.json
 (stdio transport)               │       │
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
1. LLM hy_status()，读取当前 phase、允许动作和阻塞原因

2. LLM hy_read_docs(before_plan, task)
   └► tools/read_docs.ts → 从 project.docsDir 建立任务事实基线

3. LLM hy_plan({task, plan})，基于事实基线构造 PlanDoc JSON
   └► tools/plan.ts → gate 校验 → writeState(next=approve)

4. 用户明确 approve 后，LLM hy_read_docs(before_approve)
   └► tools/read_docs.ts → 对 PlanDoc 和当前文档事实做二次审计；漂移则回 hy_plan

5. LLM hy_approve(approved="approve")
   └► tools/approve.ts → transition(approve→branch) → writeState

6. LLM hy_branch(category, topic)
   └► tools/branch.ts → git.ts.createBranch() → transition(branch→edit)

7. LLM hy_edit()，锁定 scope 后编辑实现
   └► tools/edit.ts → OS user state/projects/<id>/scope.json

8. LLM hy_read_docs(after_edit)
   └► tools/read_docs.ts → 绑定实现 diff digest 并判断文档同步需求

9. LLM hy_sync_docs()
   └► tools/sync_docs.ts → 确认文档同步 gate，限定 plan.scope 内文档或团队 workflow/template 文件

10. LLM hy_verify()
    └► checks.ts.runAllChecks() → 全绿则 transition(edit→commit)

11. LLM hy_commit(title, body)
    └► tools/commit.ts → git add/commit → 重新核对路径与内容摘要 → push 前持久化 commit/base/repository identity → exact-SHA push → 精确查找同 repository/base/head/headRefOid 的唯一 OPEN PR，复用或创建并复查 → phase=ci

12. LLM hy_ci()
    └► tools/ci.ts → 每次轮询同时复查 PR repository/base/head/headRefOid；仅有效 checks 全绿才 transition(ci→merge)，无 checks 或 identity 漂移均 fail closed

13. LLM hy_merge() → LLM hy_chain(branches) → LLM hy_reset()
    └► merge 前再次复查 PR identity 并用 --match-head-commit 锁定已验证 OID；然后 rebase 下游分支并回到 plan
```

## 关键设计决策

- **状态文件**: OS 用户 state 下按 project id 持久化 Phase、PlanDoc、Approval、verifyHash 和 scope；旧 `.git/hy-workflow/`、`.hy/workflow.json`、`.hy/scope.json` 仅作为只读迁移来源，复制后不自动删除
- **项目根定位**: `projectRoot()` 向上查找 `.git` 目录
- **幂等 init**: setup TUI 在用户目录登记 deployment；MCP runtime 每次 dispatch 检查版本；`hy_init` 只验证 deployment/config 并推进外置状态，不写项目或 `.git`，也不在 MCP 内启动 TUI
- **执行器边界**: 服务启动时探测本机 `git`、`gh` 与 gh 认证状态；commit/push/rebase 等仓库操作固定使用 git，PR/checks/merge 等 GitHub API 操作固定使用已认证 gh。`GH_REPO` 与 `GH_HOST` 不参与仓库选择；origin fetch/push URL 必须解析为同一带 host 的 repository selector。项目没有内部 Git/GitHub 后端，能力不足时结构化失败而不是静默降级
- **配置保护**: setup/config CLI 可从既有根配置或只读 legacy 用户配置 preserve-first 构造 `hy-workflow.json`；MCP runtime 不把 legacy 用户配置或 compatibility JSON 当作 fallback，`hy_init` 对 runtime 必填字段做原始根配置校验，不能由默认值掩盖缺项
- **提交恢复**: `hy_commit` 在 push 前把 commit OID、verifyHash、branch、baseBranch 和 repository 写入 approval 派生状态，只推送该不可移动 object ID。若 push 或 PR API 失败，重试必须同时匹配该记录与 clean HEAD；空提交或其他移动 HEAD 会被拒绝。CI 每次轮询与 merge 前也必须复查 exact PR identity，merge 使用 `--match-head-commit`
- **软硬结合**: 状态机硬锁定（禁止跳 phase）+ 用户 approve gate（软决策）
- **Promotion 例外**: 状态机闭环服务于普通开发改动合入 `baseBranch`；`baseBranch → releaseBranch`（如 dev → main）属于发布/晋级操作，不伪造 scope，也不硬套 `hy_branch`/`hy_commit`，必须在用户授权后通过 promotion PR 完成
- **Artifact contract**: setup 只允许模板 workflow 与 `hy-workflow.json`，其 drift 单独走 artifact sync PR；unset/hy_init 不删除或改写团队文件；runtime/client/compat artifacts 不提交；`dist/` 只进入 npm tarball，不进入 GitHub

## 配置文件

| 文件 | 用途 |
|------|------|
| `hy-workflow.json` | 唯一有效项目配置源，包含 `project.baseBranch`、`project.codeExt`、`project.codeDirs`、`project.docsDir` 和工具私有段落 |
| runtime `codelint.json` | 需要旧 codelint CLI 时从根配置临时派生；Node helper 在同步操作结束后恢复 snapshot，generated workflow 在 lint step 退出时通过 EXIT trap 尝试恢复 |
| runtime `doclint.json` | 与其他 compatibility JSON 一起临时派生，不作为项目配置源或提交产物 |
| runtime `docs-gardener.json` | 需要旧配置格式时临时派生；Node helper 的恢复错误会向上抛出，workflow 使用独立的 Bash cleanup 路径 |


## 构建与 CI

`package.json` 提供 `tsc` 编译入口，`tsconfig.json` 配置 ES2022 + NodeNext 模块。`dist/` 是生成产物，不提交到仓库；npm release job 只在临时 runner 中构建并直接发布 npm tarball，不上传 GitHub artifact。Registry 安装包已包含 `dist/`，没有 `prepare`、`install` 或 `postinstall` 编译。CI 由 `.github/workflows/hy-workflow.yml` 统一执行 build、contract lint、tests、doclint 和 codelint。Runner 在 lint step 中备份既有 compatibility JSON、临时生成配置，并注册 EXIT trap，在 step 结束时尝试恢复备份或移除临时文件；这些文件不上传也不提交。lint 或 materialization 失败会使检查失败。Node runtime 的 `withRuntimeCompatConfigs` 是独立的同步 snapshot/restore helper，不应把它的 aggregate-error 语义推断为 workflow 的 Bash cleanup 语义。`hy_ci` 对无 checks 或仅 skipped/neutral checks fail closed。仓库管理员必须在 GitHub ruleset/branch protection 中把 Verify check 设为 required，setup 不修改管理配置。Contract lint 位于 `src/contralint/`，用于守住 CLI、错误、输出、workflow state、完整文档 gate 顺序、Skill、artifact 和 npm packaging 契约。

## Related

- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
