import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEGACY_IGNORED_ARTIFACTS, LOCAL_RUNTIME_ARTIFACTS, NEW_PROJECT_ARTIFACTS } from "../../src/policy/artifacts.js";
import { validatePlanScopePaths } from "../../src/plan_validation.js";
import { MINIMAL_PROJECT_CONTRACT, writeDeployment } from "../../src/runtime/deployment.js";
import { handlePlan } from "../../src/tools/plan.js";
import { handleVerify } from "../../src/tools/verify.js";
import { createPlanApproval, readState, statePath } from "../../src/state.js";
import type { PlanDoc } from "../../src/state.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

const runtimeRoot = useRuntimeHome("hy-plan-scope-runtime-");
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
        time: new Date().toISOString(),
        task,
        planHash: null,
        docsDir: "docs",
        digest: "test",
        files: [],
        docsGraphDigest: "plan-scope-paths-graph",
        entryPoints: [],
        traversalRoots: [],
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
    changes: ["src/tools/plan.ts", ...NEW_PROJECT_ARTIFACTS],
    new_files: ["test/unit/planned-new-scope-file.ts"],
    delete: [],
  });
  resetPlanState(plan.task);
  const result = await handlePlan({ task: plan.task, plan });
  if (result.next !== "approve" || result.plan?.task !== plan.task || typeof result.decisionId !== "string") {
    throw new Error(`valid scope, including the exact new project artifacts, should be accepted: ${result.error?.message ?? JSON.stringify(result)}`);
  }
}

function expectEveryExcludedArtifactRejectedInEveryScopeField(): void {
  const fields: Array<keyof PlanDoc["scope"]> = ["changes", "new_files", "delete"];
  for (const pattern of [...LEGACY_IGNORED_ARTIFACTS, ...LOCAL_RUNTIME_ARTIFACTS]) {
    const file = pattern.endsWith("/") ? `${pattern}probe.txt` : pattern;
    for (const field of fields) {
      const scope: PlanDoc["scope"] = { changes: [], new_files: [], delete: [] };
      scope[field] = [file];
      const errors = validatePlanScopePaths(process.cwd(), basePlan(scope), "verify");
      if (!errors.some(item => item.includes(file) && item.includes("permanently outside hy-workflow authority"))) {
        throw new Error(`${field} must reject authority-excluded artifact ${file}: ${errors.join("; ")}`);
      }
    }
  }

  for (const file of NEW_PROJECT_ARTIFACTS) {
    const errors = validatePlanScopePaths(
      process.cwd(),
      basePlan({ changes: [], new_files: [file], delete: [] }),
      "verify",
    );
    if (errors.length) {
      throw new Error(`exact new project artifact ${file} must remain inside workflow authority: ${errors.join("; ")}`);
    }
  }
}

function expectLegacyRootArtifactDoesNotInfluenceScopeValidation(): void {
  const absentRoot = mkdtempSync(join(tmpdir(), "hy-plan-paths-absent-"));
  const legacyOnlyRoot = mkdtempSync(join(tmpdir(), "hy-plan-paths-legacy-"));
  try {
    writeFileSync(join(legacyOnlyRoot, "hy-workflow.json"), "{ legacy input is intentionally irrelevant\n");
    const plan = basePlan({ changes: ["src/missing.ts"], new_files: [], delete: [] });
    const absentErrors = validatePlanScopePaths(absentRoot, plan, "plan");
    const legacyErrors = validatePlanScopePaths(legacyOnlyRoot, plan, "plan");
    if (JSON.stringify(legacyErrors) !== JSON.stringify(absentErrors)) {
      throw new Error(`legacy root hy-workflow.json presence must not alter scope validation: absent=${JSON.stringify(absentErrors)} legacy=${JSON.stringify(legacyErrors)}`);
    }
  } finally {
    rmSync(absentRoot, { recursive: true, force: true });
    rmSync(legacyOnlyRoot, { recursive: true, force: true });
  }
}

function expectNewProjectArtifactsRejectedWithoutExactAuthority(): void {
  const orphanRoot = mkdtempSync(join(tmpdir(), "hy-plan-paths-orphan-"));
  try {
    mkdirSync(join(orphanRoot, ".github", "workflows"), { recursive: true });
    writeFileSync(join(orphanRoot, "hy-workflow.json"), "old injected config\n");
    writeFileSync(join(orphanRoot, ".github", "workflows", "hy-workflow.yml"), "# old injected workflow\n");
    for (const file of NEW_PROJECT_ARTIFACTS) {
      for (const field of ["changes", "new_files", "delete"] as const) {
        const scope: PlanDoc["scope"] = { changes: [], new_files: [], delete: [] };
        scope[field] = [file];
        const errors = validatePlanScopePaths(orphanRoot, basePlan(scope), "verify");
        if (!errors.some(item => item.includes(file) && item.includes("exact external minimal-v1 deployment marker"))) {
          throw new Error(`${field} must reject same-path old injection ${file} without exact external authority: ${errors.join("; ")}`);
        }
      }
    }
  } finally {
    rmSync(orphanRoot, { recursive: true, force: true });
  }
}

async function expectVerifyMissingApprovalRejected(): Promise<void> {
  const plan = basePlan({
    changes: ["src/tools/plan.ts"],
    new_files: [],
    delete: [],
  });
  resetPlanState(plan.task);
  const state = JSON.parse(readFileSync(stateFile, "utf-8"));
  state.phase = "edit";
  state.stage = "edit.implementation";
  state.plan = plan;
  state.approval = null;
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const beforeVerify = readFileSync(stateFile, "utf-8");

  const result = await handleVerify();
  if (result.error?.code !== "VERIFY_APPROVAL_PLAN_MISMATCH"
      || result.nextAction.tool !== "hy_reset"
      || result.control.reason !== "review_required") {
    throw new Error(`hy_verify must reject a missing PlanDoc approval without minting one: ${JSON.stringify(result)}`);
  }
  if (readFileSync(stateFile, "utf-8") !== beforeVerify || readState().approval !== null) {
    throw new Error("missing-approval verification rejection must leave workflow state unchanged");
  }
}

async function expectVerifyRejected(): Promise<void> {
  const plan = basePlan({
    changes: ["src/tools/plan.ts"],
    new_files: [".codex/config.toml"],
    delete: [],
  });
  resetPlanState(plan.task);
  const state = JSON.parse(readFileSync(stateFile, "utf-8"));
  state.phase = "edit";
  state.stage = "edit.implementation";
  state.plan = plan;
  state.approval = createPlanApproval(plan, "test approval");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const result = await handleVerify();
  const message = result.error?.message ?? JSON.stringify(result.error);
  if (!message.includes(".codex/config.toml") || !message.includes("permanently outside hy-workflow authority")) {
    throw new Error(`hy_verify must reject stored authority-excluded scope before running checks: ${message}`);
  }
  if (readState().phase !== "edit") {
    throw new Error("authority-excluded verify rejection must not advance workflow state");
  }
}

try {
  writeDeployment(process.cwd(), {
    setupVersion: "plan-scope-test",
    mode: "shared",
    clients: [],
    projectFiles: [...NEW_PROJECT_ARTIFACTS],
    tools: {},
    artifacts: {},
    projectContract: MINIMAL_PROJECT_CONTRACT,
  });

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

  await expectRejected("legacy ignored change", {
    changes: ["AGENTS.md"],
    new_files: [],
    delete: [],
  }, "permanently outside hy-workflow authority");

  await expectRejected("local runtime new file", {
    changes: [],
    new_files: [".hy/workflow.json"],
    delete: [],
  }, "permanently outside hy-workflow authority");

  await expectRejected("legacy ignored delete", {
    changes: ["src/tools/plan.ts"],
    new_files: [],
    delete: [".mcp.json"],
  }, "permanently outside hy-workflow authority");

  await expectMalformedRejected();
  expectEveryExcludedArtifactRejectedInEveryScopeField();
  expectLegacyRootArtifactDoesNotInfluenceScopeValidation();
  expectNewProjectArtifactsRejectedWithoutExactAuthority();
  await expectAccepted();
  await expectVerifyMissingApprovalRejected();
  await expectVerifyRejected();
} finally {
  restoreState();
  rmSync(runtimeRoot, { recursive: true, force: true });
}
