# Verify Pipeline

`hy_verify` 先确认当前 PlanDoc 已完成 `hy_read_docs(after_edit)` 与 `hy_sync_docs`，再调用 `src/checks.ts:runAllChecks` 执行 **7 层（lint, compile, scope, boundary, platform, smoke, tests）全量校验**。全部通过后计算 verifyHash，转换到 `commit`；失败则退回 `edit`。

## 层级

```
Layer 1: lint
├── doclint  — npx --yes github:voxServalG/doclint lint --json
└── codelint — npx --yes github:voxServalG/codelint check --json

Layer 2: compile
└── npx tsc --noEmit (.ts/.tsx/.js/.jsx/.mjs/.cjs) / py_compile (.py/.pyw/.pyi) / soft skip (.tksp and custom extensions without built-in compiler)

Layer 3: scope
├── git diff origin/${baseBranch} --name-only 文件 ⊆ plan.scope 声明
└── plan.scope 声明的文件都实际变更了 (软)

Layer 4: boundary
├── entry_points 逐条按 shell 命令执行
└── no_new_external → pyproject.toml/setup.cfg/setup.py/requirements.txt/policy.md 无变更

Layer 5: platform
└── plan.verify.platform.setup 命令逐条执行

Layer 6: smoke
└── plan.verify.smoke 命令逐条执行
Layer 7: tests
└── plan.verify.tests 命令逐条执行
```

## 判定逻辑

`src/checks.ts:runAllChecks`

```typescript
allPassed = 所有 hard 检查都通过
hardFailed = 失败的 hard 检查数量
```

- **hard check** (默认): 失败则 `allPassed = false`，退回 `edit`
- **soft check**: 失败不会阻止通关，仅警告

| 检查 | hard/soft |
|------|-----------|
| doclint | hard |
| codelint | hard |
| workflow-contract | hard |
| compile | hard (无可识别 codeExt 时为 soft) |
| scope: extra files | hard |
| scope: missing files | soft |
| boundary: entry_points | hard |
| boundary: no_new_external | hard |
| platform | hard |
| smoke | hard |
| tests | hard |

## CheckResult 结构

```typescript
interface CheckResult {
  layer: string;    // "lint" | "compile" | "scope" | "boundary" | "platform" | "smoke" | "tests"
  name: string;     // 检查项名称 (如 "doclint", "entry: from foo import bar...")
  passed: boolean;
  detail: string;   // 输出摘要
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
| `hy-workflow.json: project.codeExt` | 支持单个扩展、逗号分隔扩展或扩展数组；任一 JS/TS 扩展触发 `npx tsc --noEmit`，任一 Python 扩展触发 `py_compile`，`.tksp` 和其他没有内建编译器的扩展不会阻断 compile 层；boundary entry_points 始终按 shell 执行 |
| `hy-workflow.json: project.baseBranch` | scope check 的 Git diff 基线分支 |
| runtime `doclint.json` | 由 `hy-workflow.json` 临时生成给 doclint 使用，验证文档质量 |

## Related

- [Architecture](./architecture.md)
- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
