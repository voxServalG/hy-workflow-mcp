# Architecture

## Configuration Model

Configuration authority is explicit rather than inferred from file presence. Runtime selects one source in this order: a complete external project config, an exact external marker authorizing root `hy-workflow.json`, the exact clean-runner environment signal emitted by the generated workflow, or read-only project detection with frozen legacy-compatible defaults. A missing marker means runtime does not open a root config to decide whether that same file should be trusted.

For a newly installed project, root `hy-workflow.json` is the editable team configuration. It contains `project.baseBranch`, `project.codeExt`, `project.codeDirs`, `project.docsDir`, lint directories, and policy data. Project data may select a profile, set quality-rule values, add path-scoped overrides, and add expiring exceptions. Rule definitions, validation, precedence, and immutable safety rules remain package code.

An old installation can continue from a complete external config or from detected project facts with frozen historical line thresholds. Runtime and setup never read old root config, generated workflow, managed `AGENTS.md` content, `.hy/`, project client files, or compatibility lint JSON as an upgrade gate. Their presence does not grant authority.

Project profile evidence comes from Git-tracked files, language manifests, origin HEAD/current/conventional refs, source extensions and real directory casing. TypeScript is never inferred from `package.json` alone; JS, Python, Go, Rust and material mixed repositories retain their actual extensions/directories. Unknown, material mixed, non-conventional-branch and other low-confidence Git profiles require explicit confirmation; an existing complete root config remains authoritative.

Fresh setup writes only `hy-workflow.json` and `.github/workflows/hy-workflow.yml`, plus an external authority marker and deployment identity. It does not inject `AGENTS.md`. Runtime, registry, workflow state, approval, scope, DocsGraph, and client ownership remain under OS user roots. Legacy deployment manifests are classified as compatible and inert instead of being forced through a project-file migration.

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
    └► `commit.prepare`/`commit.publish` 持久化精确身份；`commit.ci` 复查 PR tuple 并轮询 checks。pending 等待后重试同一工具；无 checks 或仅 skipped/neutral fail closed

12. LLM hy_merge() → LLM hy_reset()
    └► merge 复用原审批并用 `--match-head-commit` 锁定 verified OID；`merge.sync` 在 receipt 驱动下完成或恢复下游同步
```

## 关键设计决策

- **状态文件**: OS 用户 state 下按 project id 持久化 Phase、PlanDoc、Approval、verifyHash、scope 和 document metadata；文档 excerpts 不进入 workflow state，全量 DocsGraph digest/link index 位于用户 cache
- **项目根定位**: `projectRoot()` 向上查找 `.git` 目录
- **幂等 init**: runtime 每次 dispatch 只确认外置 deployment identity 与配置 authority；旧 deployment 保持兼容，不以 package version、工具 catalog 或旧项目文件 hash 阻断。`hy_init` 验证选中的有效配置、base ref 与文档事实，只推进外置状态，不改工作树
- **执行器边界**: 服务启动时探测本机 `git`、`gh` 与 gh 认证状态；commit/push/rebase 等仓库操作固定使用 git，PR/checks/merge 等 GitHub API 操作固定使用已认证 gh。`GH_REPO` 与 `GH_HOST` 不参与仓库选择；origin fetch/push URL 必须解析为同一带 host 的 repository selector。项目没有内部 Git/GitHub 后端，能力不足时结构化失败而不是静默降级
- **配置保护**: authority 顺序固定为 external config → exact project marker → exact CI signal → read-only detection。普通文件存在、近似 marker 或旧 mode 字段不能授权。检测回退使用 frozen legacy-compatible policy，不读取旧注入；新项目配置的 profile、project rule、path override、有效 exception 按顺序合成，immutable safety rule 不接受覆盖
- **提交恢复**: `hy_commit` 在 push 前把 commit OID、verifyHash、branch、baseBranch 和 repository 写入 approval 派生状态，只推送该不可移动 object ID。若 push 或 PR API 失败，重试必须同时匹配该记录与 clean HEAD；空提交或其他移动 HEAD 会被拒绝。CI 每次轮询与 merge 前也必须复查 exact PR identity，merge 使用 `--match-head-commit`
- **合并恢复**: immutable PR identity（repository、PR number、base、head、verified OID）与 mutable GitHub lifecycle 分开。mutation 前原子写 attempted receipt，确认远端合入后写 confirmed receipt；`executePrMerge` 是唯一 mutation 且不内部重试。`reconcileMerge` 优先读取 GitHub postcondition，必要时由 `fetchRemoteBaseEvidence` 对 `origin/<base>` 做 **fresh-fetch ancestry**。该 **read-only Git fallback** 只把 immutable `baseOid`、`isAncestor` 和 `evidence: "git"` 作为证据，绝不 merge 或 push base
- **堆叠分支判定**: 正常 attempted receipt 只收录受管 agent branch，并排除 base/head；候选 commit 必须包含 verified head、同时建立在 fresh prepared base 上，且 snapshot 时 local OID 必须与 remote OID 完全相等。legacy 无 receipt 的已集成恢复只重建由 agent prefix、verified-head ancestry 与 local=remote 证明的 stack；unrelated branch 忽略，真实 stack 的 ref 漂移 fail closed
- **同步事务边界**: confirmed receipt 首次同步时 fresh fetch，并要求 remote base 同时包含 verified OID 与确认时的 base OID，再把当前 tip 固定为 `syncBaseOid`；后续恢复要求 remote tip 仍与 pin 完全相等，base rewrite/drift 以 retryable `POST_MERGE_SYNC_INCOMPLETE` fail closed。每个候选先持久化 `rebasing`，通过 **detached staging** 对固定 `syncBaseOid` 计算结果，持久化 `resultOid` 后通过 `git update-ref <ref> <new> <old>` 做 local ref **compare-and-swap**，最后才以 exact `force-with-lease` 推送。`pending → rebasing → rebased → pushed` 均落盘，因此 confirmed receipt 的重试只恢复 remaining sync
- **并发串行化**: `hy_merge` 在 reconciliation、mutation 和 worktree sync 外层持有 project-specific operation lock，记录 owner pid/host/createdAt/token。活 owner 返回 retryable `MERGE_LOCK_BUSY`，同 host dead owner 可按 stale-owner 协议接管，退出时按 token best-effort release。它只协调共享同一本地状态根和工作树的进程，不声称跨主机强一致
- **恢复保证范围**: receipt 的同步写入与原子替换用于恢复已经完成状态写入后的普通工具或进程中断；operation lock 的 best-effort release 也不声明机器断电、内核崩溃或未执行目录/文件 `fsync` 时仍具备持久性保证
- **软硬结合**: 状态机硬锁定（禁止跳 phase）+ 用户 approve gate（软决策）
- **Promotion 例外**: 状态机闭环服务于普通开发改动合入 `baseBranch`；`baseBranch → releaseBranch`（如 dev → main）属于发布/晋级操作，不伪造 scope，也不硬套 `hy_branch`/`hy_commit`，必须在用户授权后通过 promotion PR 完成
- **Artifact contract**: fresh setup 只维护 `hy-workflow.json` 与 thin `.github/workflows/hy-workflow.yml`；不注入 `AGENTS.md`。旧安装的任何 injected/runtime/client/compat 文件均不读取、不 hash、不迁移、不删除。unset/hy_init 不删除或改写项目文件；`dist/` 只进入 npm tarball，不进入 GitHub
- **Host boundary**: “legacy inert”只描述 hy-workflow 自身。MCP 不能阻止 Codex、Claude Code、OpenCode、其他 agent 或 GitHub Actions 独立加载或执行 tracked old files；旧 workflow 会继续按 trigger 运行，直至独立 repository change 删除或禁用它

## 配置文件

| 文件 | 用途 |
|------|------|
| `hy-workflow.json` | 新安装由 exact authority marker 选中的项目配置；包含 `project.*` 和 policy profile/rules/overrides/exceptions |
| 外置 `config.json` | 完整旧配置，或只包含 exact project-authority marker；优先级高于仓库文件存在性 |
| `codelint.json` | 旧注入，hy-workflow runtime/setup 不读取、不改写、不恢复 |
| `doclint.json` | 旧注入，hy-workflow runtime/setup 不读取、不改写、不恢复 |
| `docs-gardener.json` | 旧注入，hy-workflow runtime/setup 不读取、不改写、不恢复 |


## 构建与 CI

`package.json` 提供 `tsc` 编译入口，`tsconfig.json` 配置 ES2022 + NodeNext 模块。`dist/` 是生成产物，不提交到仓库；npm release job 在临时 runner 中构建并发布同一个已验收 npm tarball。Registry 安装包包含 `dist/`、schema、docs 和 thin workflow template，没有 `prepare`、`install` 或 `postinstall` 编译。

生成的 workflow 只响应 pull request 与 `workflow_dispatch`，授予 `contents: read`，使用 pinned checkout、禁用 credential persistence，并通过 exact package version 执行集中式 lint/policy。它不推断生态、不安装项目 toolchain，也不重复项目 native CI；项目自己的 build/test jobs 与 hy-workflow Verify job 各负其责。`commit.ci` 要求至少一个有效 check 且全部成功；无 checks 或只有 skipped/neutral checks fail closed。

`hy-workflow config --explain-policy <rule> [--file <path>] --json` 输出 effective value 与 ordered sources，用于审计 profile、legacy-compatible threshold、project rule、matching override 和 non-expired exception 的最终合成。Contract lint 位于 `src/contralint/`，用于守住 CLI、错误、输出、workflow state、文档 gate、artifact、policy 和 npm packaging 契约。

## Related

- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
- [Verify Pipeline](./verify.md)
- [Built-in Lint Rules](./lint-rules.md)

## Dual verification execution

The server remains the oracle for both paths: hy_verify supervises short commands, while hy_exam_plan issues exact long-running checks and hy_exam_submit validates nonce, command, exit code, output constraints, and git-tree fingerprint before producing the same verifyHash.
