# Verify Pipeline

`hy_verify` 调用 `src/checks.ts:runAllChecks` 执行 **6 层全量校验**。全部通过后计算 verifyHash，转换到 `commit`；失败则退回 `edit`。

## 层级

```
Layer 1: lint
├── doclint  — npx doclint lint --json
└── codelint — npx codelint check --json

Layer 2: compile
└── tsc --noEmit (.ts) / py_compile (.py)

Layer 3: scope
├── git diff dev..<branch> 文件 ⊆ plan.scope 声明
└── plan.scope 声明的文件都实际变更了 (软)

Layer 4: boundary
├── entry_points 逐个 `python -c "..."` 可导入
└── no_new_external → pyproject.toml/setup.cfg 无变更

Layer 5: platform
└── plan.verify.platform.setup 命令逐条执行

Layer 6: smoke + tests
├── plan.verify.smoke 命令逐条执行
└── plan.verify.tests 命令逐条执行
```

## 判定逻辑

`src/checks.ts:180-200`

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
| compile | hard (无 codelint.json 时为 soft) |
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

全部通过后，`src/state.ts:computeVerifyHash` 对 PlanDoc 的 task + scope + boundary + verify 字段做 SHA256，取前 12 位 hex。此哈希存入 `WorkflowState.verifyHash`，`hy_commit` 校验防止篡改。

## Related

- [Architecture](./architecture.md)
- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
