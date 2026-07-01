import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest, runScopeCheck, suggestPlanAmendment } from "../../src/checks.js";
import { handleAmendPlan } from "../../src/tools/amend_plan.js";
import { readState, scopePath, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function basePlan(): PlanDoc {
  return {
    task: "amend small scope drift without resetting to plan",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "src/app.ts is the approved implementation boundary and tests may add support files.",
      entry_points: ["node --version"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: ["node --version"] },
      smoke: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
    },
    risks: ["Scenario: unsafe amendment expands scope; impact: boundary weakens; mitigation: only test support and declared directories are amendable."],
    discussion: "Use a real git manifest so untracked files are covered. A pure object-only test was rejected because git status parsing is the regression surface.",
    branch: "feat/amend-plan-flow",
    verify_hash: null,
    pr_number: null,
  };
}

function baseState(plan: PlanDoc): WorkflowState {
  return {
    version: "1",
    phase: "verify",
    branch: "feat/amend-plan-flow",
    prNumber: null,
    plan,
    approval: { time: new Date().toISOString(), note: "test" },
    verifyHash: null,
  };
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-amend-plan-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "codelint.json"), "{\"baseBranch\":\"main\"}\n");
  run("git add .", root);
  run("git commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);

  chdir(root);
  writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n");
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "test_000_path.py"), "# path bootstrap\n");

  const plan = basePlan();

  writeState({
    ...baseState(plan),
    pendingAmendment: {
      reason: "malicious external path",
      scope: { changes: { add: [], remove: [] }, new_files: { add: ["../outside.ts"], remove: [] }, delete: { add: [], remove: [] } },
      warnings: [],
    },
  });
  const externalResult = await handleAmendPlan({ approved: "approve", note: "reject external" });
  if (!String(externalResult.error?.message).includes("outside the project root")) {
    throw new Error(`hy_amend_plan should reject external amendment paths, got ${JSON.stringify(externalResult)}`);
  }

  writeState({
    ...baseState(plan),
    pendingAmendment: {
      reason: "empty approved scope",
      scope: { changes: { add: [], remove: ["src/app.ts"] }, new_files: { add: [], remove: [] }, delete: { add: [], remove: [] } },
      warnings: [],
    },
  });
  const emptyResult = await handleAmendPlan({ approved: "approve", note: "reject empty" });
  if (!String(emptyResult.error?.message).includes("amended PlanDoc scope is empty")) {
    throw new Error(`hy_amend_plan should reject amendments that empty the PlanDoc scope, got ${JSON.stringify(emptyResult)}`);
  }

  const manifest = buildImplementationManifest(root);
  if (!manifest.modified.includes("src/app.ts")) throw new Error("manifest should include modified src/app.ts");
  if (!manifest.untracked.includes("tests/test_000_path.py")) throw new Error("manifest should include untracked test support file");

  const scopeChecks = runScopeCheck(root, plan, manifest);
  const scopeFailure = scopeChecks.find(check => check.hard && !check.passed);
  if (scopeFailure?.classification !== "amend_required") {
    throw new Error(`expected amend_required scope failure, got ${JSON.stringify(scopeFailure)}`);
  }

  const amendment = suggestPlanAmendment(plan, manifest);
  if (!amendment?.scope.new_files.add.includes("tests/test_000_path.py")) {
    throw new Error(`expected suggested amendment for test support file, got ${JSON.stringify(amendment)}`);
  }

  writeState({ ...baseState(plan), pendingAmendment: amendment, implementationManifest: manifest });
  const amendResult = await handleAmendPlan({ approved: "approve", note: "test approved amendment" });
  if (amendResult.phase !== "edit" || !amendResult.amended) {
    throw new Error(`hy_amend_plan should return to edit, got ${JSON.stringify(amendResult)}`);
  }
  const amendedState = readState();
  if (!amendedState.plan?.scope.new_files.includes("tests/test_000_path.py")) {
    throw new Error("hy_amend_plan should add test support file to plan.scope.new_files");
  }
  if (amendedState.pendingAmendment) {
    throw new Error("hy_amend_plan should clear pendingAmendment");
  }
  const lockedScope = JSON.parse(readFileSync(scopePath(), "utf-8"));
  if (lockedScope.lockedAt) {
    throw new Error("hy_amend_plan scope lock should match hy_edit and not write a separate lockedAt shape");
  }
  if (lockedScope.task !== plan.task || lockedScope.branch !== "feat/amend-plan-flow" || !lockedScope.rubrics) {
    throw new Error(`hy_amend_plan should write the same scope lock shape as hy_edit, got ${JSON.stringify(lockedScope)}`);
  }

  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "outside.md"), "outside\n");
  const hardManifest = buildImplementationManifest(root);
  const hardChecks = runScopeCheck(root, plan, hardManifest);
  const hardFailure = hardChecks.find(check => check.hard && !check.passed);
  if (hardFailure?.classification !== "hard_fail") {
    throw new Error(`unrelated files should stay hard_fail, got ${JSON.stringify(hardFailure)}`);
  }
} finally {
  chdir(originalCwd);
}
