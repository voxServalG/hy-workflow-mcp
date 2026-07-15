# Verify Pipeline

`hy_verify` 先确认当前 PlanDoc 已完成 `hy_read_docs(after_edit)` 与 `hy_sync_docs`，再调用 `src/checks.ts:runAllChecks` 执行 **本地任务 gate（compile, scope, boundary, platform, smoke, tests）**。显式 shared 模式可由 GitHub Actions workflow 承担完整 lint。全部通过后计算 verifyHash，转换到 `commit`；失败则退回 `edit`。

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
└── no_new_external → dependency manifests 无变更；manifest 无法检查时 hard fail

Layer 5: platform
├── 数字型 plan.verify.platform.python_version 按最低 Python 版本校验
└── plan.verify.platform.setup 命令在项目根目录逐条执行

Layer 6: smoke
└── plan.verify.smoke 命令逐条执行，actual exit 必须精确等于 expected_exit
Layer 7: tests
└── plan.verify.tests 命令逐条执行，actual exit 必须精确等于 expected_exit
```

## 判定逻辑

`src/checks.ts:runAllChecks`

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
- Python projects enumerate configured `project.codeDirs`, include top-level files such as `src/app.py`, include nested files, and do not hard-code `src/**/*.py`.
- Mixed-language projects run every relevant compile check, so a `.ts + .py` project gets both TypeScript and Python compile evidence.

## Lint JSON Parsing

`runDocLint` and `runCodeLint` parse numeric values emitted as either numbers or numeric strings. They accept top-level fields and nested `data`, `counts`, and `summary` shapes, including `errors`, `warnings`, `files`, `total`, and `failed`. Details must report concrete counts and must not contain `undefined`.

## Dependency Manifest Boundary

`boundary.no_new_external=true` 时，verify 使用当前 implementation manifest 检查工作区、索引、HEAD 相对 `origin/${baseBranch}` 的变更以及未跟踪文件。命中以下依赖或策略文件会 hard fail，除非 PlanDoc 明确声明 `no_new_external=false`：

- Node: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`
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

## verifyHash

全部通过后，`src/state.ts:computeVerifyHash` 对 PlanDoc 的 task + scope + boundary + rubrics 字段做 SHA256，取前 12 位 hex。此哈希存入 `WorkflowState.verifyHash`；当前 `hy_commit` 检查 verifyHash 是否存在，确保成功执行过 `hy_verify`。

## 配置依赖

| 配置 | 影响 |
|------|------|
| `hy-workflow.json: project.codeExt` | 支持单个扩展、逗号分隔扩展或扩展数组；决定 TypeScript、JavaScript-only soft skip、Python compile 等 compile checks；`.tksp` 和其他没有内建编译器的扩展不会阻断 compile 层 |
| `hy-workflow.json: project.codeDirs` | Python compile 的文件枚举根目录；同时支持顶层和嵌套 Python 文件 |
| `hy-workflow.json: project.baseBranch` | scope check 和 dependency manifest boundary 的 Git diff 基线分支 |
| runtime `doclint.json` | 由 `hy-workflow.json` 临时生成给 doclint 使用，验证文档质量 |

## Related

- [Architecture](./architecture.md)
- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
