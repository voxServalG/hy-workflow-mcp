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
        time: new Date().toISOString(),
        task,
        planHash: null,
        docsDir: "docs",
        digest: "test",
        files: [],
        docsGraphDigest: "plan-summary-graph",
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

const plan: PlanDoc = {
  task: "Move PlanDoc presentation from TypeScript into the stage Skill",
  scope: {
    changes: ["src/tools/plan.ts", "skills/hy-plan/SKILL.md"],
    new_files: [],
    delete: [],
  },
  boundary: {
    dependency_dag: "plan handler emits facts; hy-plan renders them; workflow state remains unchanged",
    entry_points: ["npx tsc --noEmit", "npx tsx test/unit/plan-summary.ts"],
    no_new_external: true,
  },
  verify: {
    platform: { python_version: "not required", setup: [] },
    smoke: [{ command: "npx tsc --noEmit", expected_exit: 0, description: "TypeScript compile" }],
    tests: [{ command: "npx tsx test/unit/plan-summary.ts", expected_exit: 0, description: "fact and Skill ownership contract" }],
  },
  risks: ["Scenario: a section is omitted; impact: approval is uninformed; mitigation: require every PlanDoc section in the Skill."],
  discussion: "Alternative: keep rendering in the handler. Rejected because it creates a second Agent program outside the versioned Skill.",
  branch: null,
  verify_hash: null,
  pr_number: null,
};

try {
  resetPlanState(plan.task);
  const result = await handlePlan({ task: plan.task, plan });
  if (result.next !== "approve" || result.plan?.task !== plan.task || typeof result.decisionId !== "string") {
    throw new Error(`plan should return facts bound to an approval decision: ${JSON.stringify(result)}`);
  }
  if (result.userAction?.kind !== "approval"
      || result.userAction.decisionId !== result.decisionId
      || result.userAction.options?.join(",") !== "approve,reject,revise") {
    throw new Error(`approval action should contain only bound decision facts: ${JSON.stringify(result.userAction)}`);
  }
  for (const field of ["display", "summary", "hint", "message"]) {
    if (field in result) throw new Error(`plan handler must not produce Agent prose field ${field}`);
  }
  if ("prompt" in (result.userAction ?? {}) || "instruction" in (result.userAction ?? {})) {
    throw new Error("plan handler userAction must not contain Agent prose");
  }

  const planSource = readFileSync("src/tools/plan.ts", "utf-8");
  const approveSource = readFileSync("src/tools/approve.ts", "utf-8");
  for (const [name, source] of [["plan", planSource], ["approve", approveSource]] as const) {
    for (const token of ["display:", "summary:", "hint:", "prompt:", "instruction:", "pipeline:", "stopAfter:", "resumeAfter:"]) {
      if (source.includes(token)) throw new Error(`${name} handler still owns Agent prose token ${token}`);
    }
  }

  const skill = readFileSync("skills/hy-plan/SKILL.md", "utf-8");
  for (const required of [
    "problem and expected state",
    "exact changes, new files, and deletions",
    "dependency direction",
    "expected exit code",
    "Small, Medium, and Large",
    "scenario, impact, and mitigation",
    "alternative",
    "decision identity",
  ]) {
    if (!skill.includes(required)) throw new Error(`hy-plan Skill is missing presentation rule: ${required}`);
  }
} finally {
  restoreState();
}
