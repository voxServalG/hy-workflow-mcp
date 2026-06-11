# Verify Pipeline

`hy_verify` 调用 `src/checks.ts:runAllChecks` 执行 **7 层（lint, compile, scope, boundary, platform, smoke, tests）全量校验**。全部通过后计算 verifyHash，转换到 `commit`；失败则退回 `edit`。

## 层级

```
Layer 1: lint
├── doclint  — npx --yes github:voxServalG/doclint lint --json
└── codelint — npx --yes github:voxServalG/codelint check --json

Layer 2: compile
└── npx tsc --noEmit (.ts) / py_compile (.py)

Layer 3: scope
├── git diff origin/${baseBranch} --name-only 文件 ⊆ plan.scope 声明
└── plan.scope 声明的文件都实际变更了 (软)

Layer 4: boundary
├── entry_points 逐条执行（.py 项目用 python -c 包裹，其他直接 shell 执行）
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

全部通过后，`src/state.ts:computeVerifyHash` 对 PlanDoc 的 task + scope + boundary + rubrics 字段做 SHA256，取前 12 位 hex。此哈希存入 `WorkflowState.verifyHash`；当前 `hy_commit` 检查 verifyHash 是否存在，确保成功执行过 `hy_verify`。

## 配置依赖

| 配置 | 影响 |
|------|------|
| `codelint.json: codeExt` | 决定编译命令（`.ts` → `npx tsc --noEmit`，`.py` → `py_compile`）和 boundary entry_points 执行方式 |
| `codelint.json: baseBranch` | scope check 的 Git diff 基线分支 |
| `doclint.json` | doclint 检查规则，验证文档质量 |

## Related

- [Architecture](./architecture.md)
- [State Machine](./state-machine.md)
- [Tools Reference](./tools.md)
