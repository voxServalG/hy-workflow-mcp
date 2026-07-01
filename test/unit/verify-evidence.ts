import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest, runAllChecks, runBoundaryCheck, runPlatform, runScopeCheck, runSmoke } from "../../src/checks.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function basePlan(): PlanDoc {
  return {
    task: "verify evidence regression",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "src/app.ts is the only implementation file under test.",
      entry_points: ["node --version"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: [] },
      smoke: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
    },
    risks: ["Scenario: verify accepts weak evidence; impact: unproven plan reaches commit; mitigation: exact hard checks."],
    discussion: "Use direct checks against a temp git repository. A pure mock was rejected because git diff behavior is part of the regression.",
    branch: "fix/verify-evidence",
    verify_hash: null,
    pr_number: null,
  };
}

function state(plan: PlanDoc): WorkflowState {
  return {
    version: "1",
    phase: "verify",
    branch: "fix/verify-evidence",
    prNumber: null,
    plan,
    approval: { time: new Date().toISOString(), note: "test" },
    verifyHash: null,
  };
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-verify-evidence-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: [".txt"], codeDirs: ["src"], docsDir: "docs" } }, null, 2) + "\n");
  run("git add .", root);
  run("git commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);
  run("git checkout -b fix/verify-evidence", root);
  chdir(root);

  const plan = basePlan();

  writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n");
  const manifest = buildImplementationManifest(root);

  const exactExit = runSmoke({
    ...plan,
    verify: {
      ...plan.verify,
      smoke: [{ command: "node -e \"process.exit(1)\"", expected_exit: 2, description: "exact exit mismatch" }],
    },
  }, root)[0];
  assert(!exactExit.passed, `expected exact exit mismatch to fail, got ${JSON.stringify(exactExit)}`);
  assert(exactExit.detail.includes("expected exit 2") && exactExit.detail.includes("exit 1"), `exact exit detail should include expected and actual status, got ${exactExit.detail}`);

  const expectedNonZero = runSmoke({
    ...plan,
    verify: {
      ...plan.verify,
      smoke: [{ command: "node -e \"process.exit(2)\"", expected_exit: 2, description: "expected nonzero" }],
    },
  }, root)[0];
  assert(expectedNonZero.passed, `expected matching non-zero exit to pass, got ${JSON.stringify(expectedNonZero)}`);

  const missingScope = runScopeCheck(root, { ...plan, scope: { changes: ["src/app.ts", "src/missing.ts"], new_files: [], delete: [] } }, manifest);
  const missingFailure = missingScope.find(check => check.detail.includes("Declared but not changed"));
  assert(missingFailure && !missingFailure.passed && missingFailure.hard, `declared-but-unchanged scope should be a hard failure, got ${JSON.stringify(missingScope)}`);

  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.0.0" } }, null, 2) + "\n");
  const depManifest = buildImplementationManifest(root);
  const dependencyBoundary = runBoundaryCheck(root, plan, depManifest).find(check => check.name === "no_new_external");
  assert(dependencyBoundary && !dependencyBoundary.passed && dependencyBoundary.detail.includes("package.json"), `dependency manifest changes should fail no_new_external, got ${JSON.stringify(dependencyBoundary)}`);

  const missingOriginRoot = mkdtempSync(join(tmpdir(), "hy-verify-no-origin-"));
  run("git init -b main", missingOriginRoot);
  run("git config user.email test@example.com", missingOriginRoot);
  run("git config user.name Test", missingOriginRoot);
  mkdirSync(join(missingOriginRoot, "src"), { recursive: true });
  writeFileSync(join(missingOriginRoot, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(missingOriginRoot, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "missing", codeExt: [".txt"], codeDirs: ["src"], docsDir: "docs" } }, null, 2) + "\n");
  run("git add .", missingOriginRoot);
  run("git commit -m init", missingOriginRoot);
  const missingOriginBoundary = runBoundaryCheck(missingOriginRoot, plan).find(check => check.name === "no_new_external");
  assert(missingOriginBoundary && !missingOriginBoundary.passed && missingOriginBoundary.detail.includes("Cannot verify dependency manifests"), `git diff errors should hard-fail no_new_external, got ${JSON.stringify(missingOriginBoundary)}`);

  writeFileSync(join(root, "cwd-sentinel.txt"), "ok\n");
  const platformCwd = runPlatform({ ...plan, verify: { ...plan.verify, platform: { python_version: "N/A", setup: ["node -e \"require('fs').accessSync('cwd-sentinel.txt')\""] } } }, root)[0];
  assert(platformCwd.passed, `platform setup should run from project root, got ${JSON.stringify(platformCwd)}`);

  const pythonTooHigh = runPlatform({ ...plan, verify: { ...plan.verify, platform: { python_version: "999.0", setup: [] } } }, root).find(check => check.name === "python_version");
  assert(pythonTooHigh && !pythonTooHigh.passed && pythonTooHigh.hard, `unmet python_version should hard fail, got ${JSON.stringify(pythonTooHigh)}`);

  const report = runAllChecks(root, state({ ...plan, scope: { changes: ["src/app.ts", "src/missing.ts"], new_files: [], delete: [] } }));
  assert(!report.allPassed && report.status === "hard_fail", `runAllChecks should not pass missing declared scope, got ${JSON.stringify(report)}`);
} finally {
  chdir(originalCwd);
}
