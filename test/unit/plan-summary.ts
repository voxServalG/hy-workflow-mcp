import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { handlePlan } from "../../src/tools/plan.js";
import { statePath, type PlanDoc } from "../../src/state.js";

const LEGACY_EXPECTED_STATE = "完成后，审批摘要会继续由结构化函数生成";
const stateFile = statePath();
const previousState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : null;

function resetPlanState(task: string): void {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({
    version: "1",
    phase: "plan",
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
    documentReads: {
      beforePlan: {
        stage: "before_plan",
        purpose: "test baseline",
        time: new Date().toISOString(),
        task,
        planHash: null,
        docsDir: "docs",
        digest: "test",
        files: [],
        findings: [],
      },
    },
  }, null, 2));
}

function restoreState(): void {
  if (previousState === null) {
    try { unlinkSync(stateFile); } catch {}
    return;
  }
  writeFileSync(stateFile, previousState);
}

function codePlan(): PlanDoc {
  return {
    task: "修复 hy_plan 期望状态固定模板，让摘要描述计划应用后的项目行为",
    scope: {
      changes: ["src/tools/plan.ts", "docs/tools.md"],
      new_files: ["test/unit/plan-summary.ts"],
      delete: [],
    },
    boundary: {
      dependency_dag: "src/tools/plan.ts 生成用户审批摘要；测试文件覆盖输出回归；其他 workflow 工具不受影响",
      entry_points: ["npm run build", "npm run test:unit"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "not required", setup: [] },
      smoke: [{ command: "npm run build", expected_exit: 0, description: "TypeScript 编译" }],
      tests: [{ command: "npm run test:unit", expected_exit: 0, description: "summary 单元测试" }],
    },
    risks: ["场景：摘要仍然模板化。影响：用户无法判断应用后的项目状态。缓解：测试断言旧固定文案不再出现。"],
    discussion: "选择从现有 PlanDoc 字段派生期望状态。备选方案是新增 expected_state 字段，但会扩大 schema，因此否定。",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

function docsPlan(): PlanDoc {
  return {
    task: "新增产品愿景文档，让项目方向从 issue 沉淀到 docs",
    scope: {
      changes: ["docs/index.md", "docs/pr-roadmap.md"],
      new_files: ["docs/product-vision.md"],
      delete: [],
    },
    boundary: {
      dependency_dag: "docs/product-vision.md 成为产品愿景入口；docs/index.md 和 docs/pr-roadmap.md 只增加引用；源码不受影响",
      entry_points: ["npm run lint:contract"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "not required", setup: [] },
      smoke: [{ command: "npm run lint:contract", expected_exit: 0, description: "文档契约检查" }],
      tests: [{ command: "npm test", expected_exit: 0, description: "完整测试套件" }],
    },
    risks: ["场景：愿景文档和 roadmap 重复。影响：维护成本增加。缓解：愿景写原则，roadmap 写 PR 切片。"],
    discussion: "选择新增独立愿景文档。备选方案是继续扩写 roadmap，但 roadmap 不适合作为长期产品原则入口，因此否定。",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

async function summaryFor(plan: PlanDoc): Promise<string> {
  resetPlanState(plan.task);
  const result = await handlePlan({ task: plan.task, plan });
  if (result.next !== "approve" || !result.summary) {
    throw new Error(`plan should be accepted, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

function expectedStateLine(summary: string): string {
  const line = summary.split("\n").find(item => item.startsWith("**期望状态**:"));
  if (!line) throw new Error(`summary missing expected state line: ${summary}`);
  return line;
}

try {
  const codeExpected = expectedStateLine(await summaryFor(codePlan()));
  const docsExpected = expectedStateLine(await summaryFor(docsPlan()));

  if (codeExpected.includes(LEGACY_EXPECTED_STATE) || docsExpected.includes(LEGACY_EXPECTED_STATE)) {
    throw new Error("expected state should not use the legacy fixed approval-summary sentence");
  }
  if (!codeExpected.includes("计划应用后") || !docsExpected.includes("计划应用后")) {
    throw new Error("expected state should describe the state after applying the plan");
  }
  if (!codeExpected.includes("src/tools/plan.ts") || !codeExpected.includes("test/unit/plan-summary.ts")) {
    throw new Error(`code plan expected state should mention concrete implementation/test files: ${codeExpected}`);
  }
  if (!docsExpected.includes("docs/product-vision.md") || !docsExpected.includes("代码行为保持不变")) {
    throw new Error(`docs plan expected state should mention concrete docs outcome: ${docsExpected}`);
  }
  if (codeExpected === docsExpected) {
    throw new Error("different PlanDocs should produce different expected states");
  }
} finally {
  restoreState();
}
