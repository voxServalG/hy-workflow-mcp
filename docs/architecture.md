# Architecture

## Configuration Model

Root `hy-workflow.json` is the single editable project configuration source. Runtime requires explicit `project.baseBranch`, `project.codeExt`, `project.codeDirs`, `project.docsDir`, and `codelint.lintDirs`; optional `ci.commands` is a confirmed, non-empty ordered command array consumed as the complete native CI sequence. Legacy user config and the three older lint JSON files are read-only migration or drift inputs, never active runtime configuration.

MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input.

Project profile evidence comes from Git-tracked files, language manifests, origin HEAD/current/conventional refs, source extensions and real directory casing. TypeScript is never inferred from `package.json` alone; JS, Python, Go, Rust and material mixed repositories retain their actual extensions/directories. Unknown, material mixed, non-conventional-branch and other low-confidence Git profiles require explicit confirmation; an existing complete root config remains authoritative.

Setup has one deployment model and may write three team-owned repository surfaces: `hy-workflow.json`, `.github/workflows/hy-workflow.yml`, and the managed block between `<!-- hy-workflow-rules -->` markers in `AGENTS.md` (any content outside those markers is team-owned and preserved byte-for-byte). Before writing it validates candidate project/docs readiness and requires confirmation of detected or explicit `ci.commands`. Deployment schema 3 records direct-tool versions/catalog hashes and all three team artifact SHA/size; runtime, registry, workflow state, scope, DocsGraph and client configuration stay under OS user roots. Legacy config/mode manifests/project client files are diagnosis or migration inputs, never active fallback.

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

- **状态文件**: OS 用户 state 下按 project id 持久化 Phase、PlanDoc、Approval、verifyHash、scope 和 document metadata；文档 excerpts 不进入 workflow state，全量 DocsGraph digest/link index 位于用户 cache
- **项目根定位**: `projectRoot()` 向上查找 `.git` 目录
- **幂等 init**: runtime 每次 dispatch 检查 deployment schema/version/tool evidence/artifact hashes；`hy_init` 再验证 root config、三个团队产物（`hy-workflow.json`、`.github/workflows/hy-workflow.yml`、`AGENTS.md` managed block）、base ref、非空实质文档和 managed rules version，只推进外置状态
- **执行器边界**: 服务启动时探测本机 `git`、`gh` 与 gh 认证状态；commit/push/rebase 等仓库操作固定使用 git，PR/checks/merge 等 GitHub API 操作固定使用已认证 gh。`GH_REPO` 与 `GH_HOST` 不参与仓库选择；origin fetch/push URL 必须解析为同一带 host 的 repository selector。项目没有内部 Git/GitHub 后端，能力不足时结构化失败而不是静默降级
- **配置保护**: preserve-first 迁移不改写人工 project/ci 值；profile 候选与 CI 命令必须在写盘前确认。MCP runtime 不把 legacy/compat 配置当 fallback，缺字段、无 ref、零文档事实或 stale managed block 均 fail closed
- **提交恢复**: `hy_commit` 在 push 前把 commit OID、verifyHash、branch、baseBranch 和 repository 写入 approval 派生状态，只推送该不可移动 object ID。若 push 或 PR API 失败，重试必须同时匹配该记录与 clean HEAD；空提交或其他移动 HEAD 会被拒绝。CI 每次轮询与 merge 前也必须复查 exact PR identity，merge 使用 `--match-head-commit`
- **软硬结合**: 状态机硬锁定（禁止跳 phase）+ 用户 approve gate（软决策）
- **Promotion 例外**: 状态机闭环服务于普通开发改动合入 `baseBranch`；`baseBranch → releaseBranch`（如 dev → main）属于发布/晋级操作，不伪造 scope，也不硬套 `hy_branch`/`hy_commit`，必须在用户授权后通过 promotion PR 完成
- **Artifact contract**: setup 维护三个团队产物（`hy-workflow.json`、`.github/workflows/hy-workflow.yml`、`AGENTS.md` managed block），其 drift 单独走 artifact sync PR；unset/hy_init 不删除或改写团队文件；runtime/client/compat artifacts 不提交；`dist/` 只进入 npm tarball，不进入 GitHub

## 配置文件

| 文件 | 用途 |
|------|------|
| `hy-workflow.json` | 唯一有效项目配置源，包含 `project.*`、工具私有段落和可选的已确认 `ci.commands` |
| `codelint.json` | 旧格式只读迁移/漂移输入；内置 lint 不生成、不改写、不恢复 |
| `doclint.json` | 旧格式只读迁移/漂移输入；不是运行时配置源或提交产物 |
| `docs-gardener.json` | 旧格式只读迁移/漂移输入；不是运行时配置源或提交产物 |


## 构建与 CI

`package.json` 提供 `tsc` 编译入口，`tsconfig.json` 配置 ES2022 + NodeNext 模块。`dist/` 是生成产物，不提交到仓库；npm release job 只在临时 runner 中构建并直接发布同一个已验收 npm tarball，不上传 GitHub artifact。Registry 安装包已包含 `dist/` 与 `templates/lint/*.mjs`，没有 `prepare`、`install` 或 `postinstall` 编译。setup 将固定模块集合按确定性顺序编码进单个 workflow；runner 只把该 bundle 解到临时目录并读取根 `hy-workflow.json`，不访问网络，也不触碰旧 compatibility JSON。CLI 与生成 workflow 使用同一套内置 D001–D005、C001–C005 规则。通用 workflow 仅响应 pull request 与 `workflow_dispatch`，并在确认的原生 CI 后执行 lint；任何错误、零文档扫描或报告不合约都 fail closed。`hy_ci` 要求稳定的 Verify 成功且所有有效 checks 全绿；无 checks 或只有 skipped/neutral checks 同样 fail closed。仓库管理员必须在 GitHub ruleset/branch protection 中把 Verify check 设为 required，setup 不修改管理配置。Contract lint 位于 `src/contralint/`，用于守住 CLI、错误、输出、workflow state、完整文档 gate 顺序、Skill、artifact 和 npm packaging 契约。

## Related

- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
- [Built-in Lint Rules](./lint-rules.md)

## Dual verification execution

The server remains the oracle for both paths: hy_verify supervises short commands, while hy_exam_plan issues exact long-running checks and hy_exam_submit validates nonce, command, exit code, output constraints, and git-tree fingerprint before producing the same verifyHash.
