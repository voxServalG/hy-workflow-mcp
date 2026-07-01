import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { handlePlan } from "../../src/tools/plan.js";
import { readState, statePath } from "../../src/state.js";
import type { PlanDoc } from "../../src/state.js";

const stateFile = statePath();
const previousState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : null;

function resetPlanState(task = "test task"): void {
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

function basePlan(scope: PlanDoc["scope"]): PlanDoc {
  return {
    task: "修复 hy_plan 接受不存在 scope 路径导致 edit 阶段才暴露错误的问题",
    scope,
    boundary: {
      dependency_dag: "src/tools/plan.ts 负责 PlanDoc gate；新增单测直接调用 handlePlan；其他 workflow 工具不受影响",
      entry_points: ["npm run build", "npm run test:unit"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "3.11", setup: [] },
      smoke: [{ command: "npm run build", expected_exit: 0, description: "TypeScript 编译" }],
      tests: [{ command: "npm run test:unit", expected_exit: 0, description: "单元测试" }],
    },
    risks: ["场景：计划创建的文件被误判为缺失。影响：合法计划被拒绝。缓解：只校验 changes/delete，new_files 用测试覆盖。"],
    discussion: "选择在 hy_plan gate 校验已有路径。备选方案是在 hy_edit 后校验，但会让无效 PlanDoc 先进入审批，因此否定。",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

async function expectRejected(label: string, scope: PlanDoc["scope"], expectedText: string): Promise<void> {
  const plan = basePlan(scope);
  resetPlanState(plan.task);
  const result = await handlePlan({ task: plan.task, plan });
  const message = result.error?.message ?? JSON.stringify(result.error);
  if (result.next !== "plan" || !result.error) {
    throw new Error(`${label} should be rejected at plan phase`);
  }
  if (!message.includes(expectedText)) {
    throw new Error(`${label} returned unclear error: ${message}`);
  }
  if (readState().phase !== "plan") {
    throw new Error(`${label} should keep workflow in plan phase`);
  }
}


async function expectMalformedRejected(): Promise<void> {
  const plan = {
    ...basePlan({ changes: ["src/tools/plan.ts"], new_files: [], delete: [] }),
    scope: { changes: "src/tools/plan.ts", new_files: [], delete: [] },
  } as unknown as PlanDoc;
  resetPlanState(plan.task);
  const result = await handlePlan({ task: plan.task, plan });
  const message = result.error?.message ?? JSON.stringify(result.error);
  if (result.next !== "plan" || !message.includes("PlanDoc has invalid shape") || !message.includes("scope.changes")) {
    throw new Error(`malformed nested PlanDoc should be rejected structurally, got ${message}`);
  }
  if (readState().phase !== "plan") {
    throw new Error("malformed nested PlanDoc should keep workflow in plan phase");
  }
}

async function expectAccepted(): Promise<void> {
  const plan = basePlan({
    changes: ["src/tools/plan.ts"],
    new_files: ["test/unit/planned-new-scope-file.ts"],
    delete: [],
  });
  resetPlanState(plan.task);
  const result = await handlePlan({ task: plan.task, plan });
  if (result.next !== "approve" || !result.summary) {
    throw new Error(`valid existing changes plus missing new_files should be accepted: ${result.error?.message ?? JSON.stringify(result)}`);
  }
}

try {
  await expectRejected("missing change", {
    changes: ["src/does-not-exist-for-plan.ts"],
    new_files: [],
    delete: [],
  }, "scope.changes");

  await expectRejected("missing delete", {
    changes: ["src/tools/plan.ts"],
    new_files: [],
    delete: ["docs/does-not-exist-for-delete.md"],
  }, "scope.delete");

  await expectRejected("outside change path", {
    changes: ["../outside.ts"],
    new_files: [],
    delete: [],
  }, "outside the project root");

  await expectRejected("outside new file path", {
    changes: [],
    new_files: ["../outside-new.ts"],
    delete: [],
  }, "scope.new_files");

  await expectMalformedRejected();
  await expectAccepted();
} finally {
  restoreState();
}
