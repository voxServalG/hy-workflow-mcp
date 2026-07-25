import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { handlePlan } from "../../src/tools/plan.js";
import { statePath, type PlanDoc } from "../../src/state.js";

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
    verifiedImplementationDigest: null,
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
    task: "摘要格式固定模板 → 从 PlanDoc 字段动态派生期望状态，去掉固定文案",
    scope: {
      changes: ["src/tools/plan.ts"],
      new_files: ["test/unit/plan-summary.ts"],
      delete: [],
    },
    boundary: {
      dependency_dag: "plan.ts 生成用户审批摘要；测试覆盖输出回归；其他工具不受影响",
      entry_points: ["npm run build", "npm run test:unit"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "not required", setup: [] },
      smoke: [{ command: "npm run build", expected_exit: 0, description: "TypeScript 编译" }],
      tests: [{ command: "npm run test:unit", expected_exit: 0, description: "summary 单元测试" }],
    },
    risks: ["场景：摘要模板化 → 影响：用户无法判断实际状态 → 缓解：从 plan 字段派生期望"],
    discussion: "备选：新增 expected_state 字段。否定理由：扩大 schema 且 Agent 填的与 task 不一致。",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

function docsPlan(): PlanDoc {
  return {
    task: "项目方向分散在 issue → docs/product-vision.md 成为产品愿景入口",
    scope: {
      changes: ["docs/index.md"],
      new_files: ["docs/product-vision.md"],
      delete: [],
    },
    boundary: {
      dependency_dag: "product-vision.md 成为愿景入口；index.md 增加引用；源码不受影响",
      entry_points: ["npm run lint:contract"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "not required", setup: [] },
      smoke: [{ command: "npm run lint:contract", expected_exit: 0, description: "文档契约检查" }],
      tests: [{ command: "npm test", expected_exit: 0, description: "完整测试套件" }],
    },
    risks: ["场景：愿景与 roadmap 重复 → 影响：维护成本 → 缓解：愿景写原则，roadmap 写切片"],
    discussion: "备选：继续扩写 roadmap。否定：roadmap 不适合作为长期原则入口。",
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

try {
  const codeSummary = await summaryFor(codePlan());
  const docsSummary = await summaryFor(docsPlan());

  // PM-style: starts with ## title (not ## Plan)
  if (!codeSummary.startsWith("## ") || !docsSummary.startsWith("## ")) {
    throw new Error(`summary should start with ## title: code="${codeSummary.slice(0,60)}", docs="${docsSummary.slice(0,60)}"`);
  }

  // Has the 6 required sections (title, why, changes, impact, verify, risks)
  for (const summary of [codeSummary, docsSummary]) {
    if (!summary.includes("> **为什么**")) throw new Error("summary missing 为什么 section");
    if (!summary.includes("### 改动")) throw new Error("summary missing 改动 section");
    if (!summary.includes("> **影响**")) throw new Error("summary missing 影响 section");
    if (!summary.includes("### 验证")) throw new Error("summary missing 验证 section");
    if (!summary.includes("### 风险")) throw new Error("summary missing 风险 section");
  }

  // Scope mentions concrete files
  if (!codeSummary.includes("plan.ts")) throw new Error("code plan should mention plan.ts");
  if (!docsSummary.includes("product-vision.md")) throw new Error("docs plan should mention product-vision.md");

  // Different plans produce different summaries
  if (codeSummary === docsSummary) throw new Error("different plans should produce different summaries");

  // display.requiredSections present
  resetPlanState("test → verify requiredSections");
  const r = await handlePlan({ task: "test → verify requiredSections", plan: codePlan() });
  if (!r.display?.requiredSections || !Array.isArray(r.display.requiredSections)) {
    throw new Error(`display.requiredSections must be an array, got ${JSON.stringify(r.display?.requiredSections)}`);
  }
  if (r.display.requiredSections.length < 6) {
    throw new Error(`requiredSections should have 6 entries, got ${r.display.requiredSections.length}`);
  }
} finally {
  restoreState();
}
