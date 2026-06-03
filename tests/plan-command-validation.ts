import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { handlePlan } from "../src/tools/plan.js";
import { statePath } from "../src/state.js";
import type { PlanDoc } from "../src/state.js";

const stateFile = statePath();
const previousState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : null;

function resetPlanState(): void {
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
  }, null, 2));
}

function restoreState(): void {
  if (previousState === null) {
    try { unlinkSync(stateFile); } catch {}
    return;
  }
  writeFileSync(stateFile, previousState);
}

function basePlan(): PlanDoc {
  return {
    task: "修复 PlanDoc 命令字段混入说明文字导致 verify 阶段才失败的问题",
    scope: { changes: ["src/tools/plan.ts"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "plan.ts 直接校验 PlanDoc；server.ts 仅提供 schema；其他工具不受影响",
      entry_points: ["npx tsc --noEmit"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "3.10", setup: [] },
      smoke: [{ command: "npx tsc --noEmit", expected_exit: 0, description: "TypeScript 编译检查" }],
      tests: [{ command: "npm test", expected_exit: 0, description: "项目测试脚本" }],
    },
    risks: ["场景：合法命令被误判。影响：plan 被拒绝。缓解：测试覆盖常见坏例并保留标准命令通过。"],
    discussion: "选择在 hy_plan gate 阶段拦截说明文字式命令。备选方案是在 verify 阶段容错，但会让错误暴露太晚，因此否定。",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

async function expectRejected(label: string, mutate: (plan: PlanDoc) => void): Promise<void> {
  resetPlanState();
  const plan = basePlan();
  mutate(plan);
  const result = await handlePlan({ task: plan.task, plan });
  if (!result.error || result.next !== "plan") {
    throw new Error(`${label} should be rejected at plan phase`);
  }
  if (!String(result.error).includes("pure executable shell command")) {
    throw new Error(`${label} returned an unclear error: ${result.error}`);
  }
}

async function expectAccepted(): Promise<void> {
  resetPlanState();
  const plan = basePlan();
  const result = await handlePlan({ task: plan.task, plan });
  if (result.next !== "approve" || !result.summary) {
    throw new Error("valid pure shell commands should be accepted");
  }
}

try {
  await expectRejected("entry_points parenthetical", plan => {
    plan.boundary.entry_points = ["npx tsc --noEmit (compile check)"];
  });
  await expectRejected("smoke colon description", plan => {
    plan.verify.smoke[0].command = "compile: npx tsc --noEmit";
  });
  await expectRejected("tests natural language", plan => {
    plan.verify.tests[0].command = "Run npm test";
  });
  await expectAccepted();
} finally {
  restoreState();
}
