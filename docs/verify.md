# Verify Pipeline

`hy_verify` 先确认当前 PlanDoc 已完成 `hy_read_docs(after_edit)` 与 `hy_sync_docs`，再调用 `src/checks-async.ts:runAllChecksAsync` 执行 **本地任务 gate（compile, scope, boundary, platform, smoke, tests）**。setup 固定部署的 GitHub Actions workflow 承担强制 doclint、codelint 和项目 CI。全部通过后持久化 `implementationManifest` 与 `verifiedImplementationDigest`，转换到 `commit`；失败则退回 `edit`。

## 层级

```
Layer 2: compile
├── TypeScript compile: project.codeExt 含 .ts/.tsx 时执行 npx tsc --noEmit
├── JavaScript-only compile: project.codeExt 仅含 .js/.jsx/.mjs/.cjs 且无 tsconfig 时 soft skip
└── Python compile: 按 project.codeDirs 枚举 .py/.pyw/.pyi 后执行 py_compile

Layer 3: scope
├── git diff origin/${baseBranch} --name-status 文件 ⊆ plan.scope 声明
├── git ls-files --others --exclude-standard 未跟踪文件 ⊆ plan.scope 声明
└── plan.scope 声明的文件都必须实际变更 (hard)

Layer 4: boundary
├── entry_points 逐条按 shell 命令执行，必须 exit 0
└── no_new_external → dependency-bearing sections/lockfiles 无新增或变更；manifest 无法检查时 hard fail

Layer 5: platform
├── 数字型 plan.verify.platform.python_version 按最低 Python 版本校验
└── plan.verify.platform.setup 命令在项目根目录逐条执行

Layer 6: smoke
└── plan.verify.smoke 命令逐条执行，actual exit 必须精确等于 expected_exit
Layer 7: tests
└── plan.verify.tests 命令逐条执行，actual exit 必须精确等于 expected_exit
```

## Command budget and cleanup

The `hy_verify` fast path awaits short commands through an asynchronous cross-platform supervisor inside one MCP request; commands expected to exceed 60 seconds use the external two-step exam path. Ordinary commands receive 90 seconds, `npm pack` receives 5 minutes, and the normal unit/e2e/contract/Windows/verify suites receive 20 minutes. Long acceptance commands are issued by `hy_exam_plan`, executed outside the MCP request with their declared timeout, and graded by `hy_exam_submit`. Async compile checks derive language and source paths from `project.codeExt` plus `project.codeDirs`, matching the one-request verify path; they never concatenate `boundary.entry_points` into a compiler command. A timeout is reported explicitly instead of as an unknown exit. Before returning, the supervisor terminates the complete detached process group on POSIX or uses `taskkill /T /F` on Windows, so a timed-out npm shell cannot leave descendants mutating `dist/` or holding the worktree. Structured compile invocations such as Python `py_compile` use executable plus argv rather than shell quoting.

## CI evidence gate

GitHub thin workflow 只响应 pull request 和手动触发，使用 pinned checkout、`contents: read` 与 exact package version 执行集中式 D001–D005/C001–C005 lint/policy。它不推断生态、不安装项目 toolchain、不运行 repository-native CI，也不嵌入旧的大型 bundle。零文档扫描、lint 错误、解析器失败或报告不符合 `hy-workflow.lint.v1` 均 fail closed。旧 compatibility JSON 不生成、不改写。`hy_commit` 的 `commit.ci` 只有至少一个有效 check 且全部成功才进入 merge；pending 等待后重试，没有 checks 或只有 skipped/neutral 时返回 `CI_CHECKS_REQUIRED`。

setup 负责生成 workflow，但不修改 GitHub 管理配置。仓库管理员必须在 ruleset 或 branch protection 中把 workflow 的 Verify check 设为 required，才能在平台层阻止绕过。

## 判定逻辑

`src/checks-async.ts:runAllChecksAsync`

```typescript
allPassed = 所有 hard 检查都通过
hardFailed = 失败的 hard 检查数量
```

- **hard check** (默认): 失败则 `allPassed = false`，退回 `edit`
- **soft check**: 失败不会阻止通关，仅警告
- `expected_exit` 是精确退出码契约：actual exit 必须等于 expected_exit；例如 actual `1`、expected `2` 必须失败
- `verify.platform.python_version` 支持 `N/A`、`none`、`not required` 等无约束值；`3.11` 或 `>=3.11` 这类数字约束会作为最低版本 hard check 执行

| 检查 | hard/soft |
|------|-----------|
| compile: TypeScript | hard |
| compile: JavaScript-only without tsconfig | soft |
| compile: Python files found in configured codeDirs | hard |
| compile: Python extension configured but no files found | soft |
| scope: extra files | hard / amend_required when all extra files are safely amendable |
| scope: missing files | hard |
| boundary: entry_points | hard |
| boundary: no_new_external | hard |
| platform: python_version numeric requirement | hard |
| platform: setup commands | hard |
| smoke | hard |
| tests | hard |

## Compile Behavior

Compile checks are built per language from `hy-workflow.json: project.codeExt` and `project.codeDirs`.

- `.ts` / `.tsx` projects run `npx tsc --noEmit`.
- JavaScript-only projects (`.js`, `.jsx`, `.mjs`, `.cjs`) do not automatically require TypeScript. If a `tsconfig.json` exists, `npx tsc --noEmit` still runs because the project has an explicit TS compile configuration.
- Python projects enumerate configured `project.codeDirs` recursively (for example files matching `*.py` / `*.pyw` / `*.pyi`), and also include top-level `.py` siblings at the project root; the glob is driven by configured directories rather than a hard-coded `src/**/*.py` assumption.
- Mixed-language projects run every relevant compile check, so a `.ts + .py` project gets both TypeScript and Python compile evidence.

## Built-in lint evidence

`hy-workflow lint --json` emits one report with schema `hy-workflow.lint.v1`, version 1, exactly ten ordered checks, sorted findings, and aggregate file/error/warning counts. Check status is `passed`, `failed`, `warning`, `not_applicable`, or `not_configured`. Warnings exit zero; any error, invalid configuration, supported-language parse failure, or configured-language zero scan exits one. The generated workflow additionally requires at least one documentation file. See [Built-in Lint Rules](./lint-rules.md).

## Dependency Manifest Boundary

`boundary.no_new_external=true` 时，verify 使用当前 implementation manifest 检查工作区、索引、HEAD 相对 `origin/${baseBranch}` 的变更以及未跟踪文件。Node `package.json` 只比较 dependency-bearing sections，因此 scripts、files、bin、version 等元数据可以变化，但 dependencies/devDependencies/optionalDependencies/peerDependencies 等外部依赖变化会 hard fail。锁文件和下列其他依赖或策略文件发生变化仍会 hard fail，除非 PlanDoc 明确声明 `no_new_external=false`：

- Node: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`
- Python: `pyproject.toml`, `setup.cfg`, `setup.py`, `requirements.txt`, `requirements/*.txt`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, `uv.lock`
- Other common manifests: `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `composer.json`, `composer.lock`, `Gemfile`, `Gemfile.lock`
- Policy: `policy.md`

如果 Git 基线缺失或 manifest 无法构造，`no_new_external` 不能静默通过，必须返回 hard failure。

## CheckResult 结构

```typescript
interface CheckResult {
  layer: string;    // "lint" | "compile" | "scope" | "boundary" | "platform" | "smoke" | "tests"
  name: string;     // 检查项名称 (如 "doclint", "entry: from foo import bar...")
  passed: boolean;
  detail: string;   // 输出摘要，exit mismatch 会包含 expected 与 actual exit
  hard: boolean;    // true = 失败会阻止通关
}
```

## VerifyReport 结构

```typescript
interface VerifyReport {
  allPassed: boolean;        // 所有 hard 检查通过
  hardFailed: number;        // 失败的 hard 检查数
  total: number;             // 检查总数
  checks: CheckResult[];     // 所有检查结果
}
```

## Implementation evidence 与 verifyHash 兼容别名

同步与异步成功路径都持久化完整 `implementationManifest`，并用 manifest 中的当前路径和文件内容计算 `verifiedImplementationDigest`。该 manifest 会覆盖工作区和索引中的真实实现差异，包括未跟踪文件。`hy_commit` 以这两个字段作为正式 gate：提交前重新构造 manifest、重新计算 digest，并要求路径集合和内容都与验证时完全一致。

工具成功输出以及 PR metadata 中名为 `verifyHash` 的值只是 `verifiedImplementationDigest` 的兼容别名，便于旧调用方和既有 PR 展示继续工作。持久化的 `WorkflowState.verifyHash` 与 `verifiedManifestHash` 是可空的旧兼容字段，不参与当前 commit gate；新的成功路径也不靠写入这两个字段放行。

异步试卷额外绑定精确 `planHash` 与出题时的完整实现指纹。`hy_exam_submit` 必须收到每一项结果，并校验 nonce、命令、退出码和输出约束，同时要求实现指纹未变、审批与文档证据仍有效，并在本地重新执行 scope 与 `no_new_external` 边界检查。任一失败都返回 edit；修复后必须刷新 `after_edit` 与 `sync_docs` 证据并重新调用 `hy_exam_plan`，不能在原试卷上只补交失败项。

## 配置依赖

| 配置 | 影响 |
|------|------|
| `hy-workflow.json: project.codeExt` | 支持单个扩展、逗号分隔扩展或扩展数组；决定 TypeScript、JavaScript-only soft skip、Python compile 等 compile checks；`.tksp` 和其他没有内建编译器的扩展不会阻断 compile 层 |
| `hy-workflow.json: project.codeDirs` | Python compile 的文件枚举根目录；同时支持顶层和嵌套 Python 文件 |
| `hy-workflow.json: project.baseBranch` | scope check 和 dependency manifest boundary 的 Git diff 基线分支 |
| `hy-workflow.json: doclint.maxLinesWarning/maxLinesError` | 内置 D005 文档行数 warning/error 阈值；默认 200/500 |
| `hy-workflow.json: codelint.lintDirs/maxLinesWarning/maxLinesError` | 内置代码扫描根与 C002 warning/error 阈值；默认 300/500 |
| `hy-workflow.json: codelint.tiers` | 可选的高到低依赖层数组；缺失时 C003 明确为 `not_configured` |

## Related

- [Architecture](./architecture.md)
- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
