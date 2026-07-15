import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { commitScope } from "../../src/git.js";
import { cleanupLegacyRuntimeFiles, legacyRuntimeDiagnostics, readState, scopePath, statePath, writeState } from "../../src/state.js";
import { runScopeCheck } from "../../src/checks.js";
import { handleEdit } from "../../src/tools/edit.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function baseState(): WorkflowState {
  return {
    version: "1",
    phase: "plan",
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
  };
}

function basePlan(): PlanDoc {
  return {
    task: "verify runtime scope filtering",
    scope: { changes: ["README.md"], new_files: [], delete: [] },
    boundary: { dependency_dag: "README only", entry_points: ["npx tsc --noEmit"], no_new_external: true },
    verify: { platform: { python_version: "3.11", setup: [] }, smoke: [], tests: [] },
    risks: ["Scenario: scope filtering hides runtime files only; impact: real files remain checked; mitigation: prefix-limited test coverage."],
    discussion: "Use a temporary git repo to verify state path and scope filtering. A pure unit test was rejected because git diff behavior is the regression surface.",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

const originalCwd = cwd();
const runtimeHome = mkdtempSync(join(tmpdir(), "hy-state-runtime-home-"));
process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");
const root = mkdtempSync(join(tmpdir(), "hy-state-runtime-"));

try {
  run("git init -b main", root);
  run("git config user.name test", root);
  run("git config user.email test@example.com", root);
  writeFileSync(join(root, "README.md"), "initial\n");
  writeFileSync(join(root, "codelint.json"), JSON.stringify({ baseBranch: "main", codeExt: ".ts" }, null, 2));
  run("git add README.md codelint.json", root);
  run("git -c user.name=test -c user.email=test@example.com commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);

  chdir(root);

  const state = baseState();
  writeState(state);
  const runtimePath = statePath();
  if (!runtimePath.startsWith(join(runtimeHome, "state")) || runtimePath.startsWith(root)) {
    throw new Error(`statePath should use OS user state outside the project, got ${runtimePath}`);
  }
  if (!existsSync(runtimePath)) {
    throw new Error("writeState should create user-local workflow.json");
  }

  const legacyDir = join(root, ".hy");
  mkdirSync(legacyDir, { recursive: true });
  const legacyState = { ...baseState(), phase: "approve" as const };
  writeFileSync(join(legacyDir, "workflow.json"), JSON.stringify(legacyState, null, 2));
  unlinkSync(runtimePath);

  const migrated = readState();
  if (migrated.phase !== "approve") {
    throw new Error("readState should load legacy .hy/workflow.json when new state is absent");
  }
  const migratedRaw = JSON.parse(readFileSync(runtimePath, "utf-8"));
  if (migratedRaw.phase !== "approve") {
    throw new Error("readState should migrate legacy state into user-local workflow.json");
  }
  if (!existsSync(join(legacyDir, "workflow.json"))) {
    throw new Error("readState must preserve legacy .hy/workflow.json after migration");
  }

  writeFileSync(join(root, "README.md"), "changed\n");
  writeFileSync(join(legacyDir, "scope.json"), "{}\n");
  cleanupLegacyRuntimeFiles(root);
  if (!existsSync(join(legacyDir, "scope.json"))) {
    throw new Error("cleanupLegacyRuntimeFiles must not delete legacy .hy/scope.json");
  }
  writeFileSync(join(legacyDir, "scope.json"), "{}\n");
  const results = runScopeCheck(root, basePlan());
  const hardFailure = results.find(result => !result.passed && result.hard);
  if (hardFailure) {
    throw new Error(`.hy runtime files should not fail scope check: ${hardFailure.detail}`);
  }

  writeFileSync(join(legacyDir, "workflow.json"), JSON.stringify(baseState(), null, 2));
  run("git add .hy/workflow.json", root);
  cleanupLegacyRuntimeFiles(root);
  if (!existsSync(join(legacyDir, "workflow.json"))) {
    throw new Error("cleanupLegacyRuntimeFiles should preserve tracked legacy .hy/workflow.json");
  }
  const diagnostics = legacyRuntimeDiagnostics(root);
  if (!diagnostics.some(d => d.file === ".hy/workflow.json" && d.tracked && d.remediation)) {
    throw new Error("legacyRuntimeDiagnostics should report tracked legacy workflow metadata with remediation");
  }
  run("git reset -- .hy/workflow.json", root);
  run("rm -f .hy/workflow.json .hy/scope.json", root);

  const editState = { ...baseState(), phase: "branch" as const, branch: "fix/runtime", plan: basePlan() };
  writeState(editState);
  await handleEdit();
  const runtimeScopePath = scopePath();
  if (!runtimeScopePath.startsWith(join(runtimeHome, "state")) || runtimeScopePath.startsWith(root)) {
    throw new Error(`scopePath should use OS user state outside the project, got ${runtimeScopePath}`);
  }
  if (!existsSync(runtimeScopePath)) {
    throw new Error("handleEdit should create user-local scope.json");
  }

  writeFileSync(join(root, "README.md"), "committed change\n");
  writeFileSync(join(root, "UNDECLARED.md"), "should remain untracked\n");
  const commit = commitScope(root, basePlan().scope, "test scoped commit", "body");
  if (!commit.ok) {
    throw new Error(`commitScope should commit declared files: ${commit.error}`);
  }
  const status = execSync("git status --short", { cwd: root, encoding: "utf-8" });
  if (!status.includes("?? UNDECLARED.md")) {
    throw new Error(`commitScope should leave undeclared files untracked, got status: ${status}`);
  }

  const noGit = mkdtempSync(join(tmpdir(), "hy-state-no-git-"));
  chdir(noGit);
  try {
    readState();
    throw new Error("readState outside a git worktree should fail");
  } catch (e: any) {
    if (e.code !== "PROJECT_ROOT_NOT_FOUND") {
      throw new Error(`readState should report PROJECT_ROOT_NOT_FOUND outside git, got ${JSON.stringify(e)}`);
    }
  }
  if (existsSync(join(noGit, ".git", "hy-workflow", "workflow.json"))) {
    throw new Error("readState outside git should not create fake .git workflow state");
  }
  chdir(root);
} finally {
  chdir(originalCwd);
}
