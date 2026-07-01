import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest } from "../../src/checks.js";
import { computeImplementationDigest, computeImplementationManifestHash, computeVerifyHash, readState, statePath, writeState } from "../../src/state.js";
import { handleApprove } from "../../src/tools/approve.js";
import { handleCommit } from "../../src/tools/commit.js";
import { handleReset } from "../../src/tools/reset.js";
import { handleStatus } from "../../src/tools/status.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): string {
  return execSync(cmd, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function basePlan(): PlanDoc {
  return {
    task: "exercise workflow state safety",
    scope: { changes: ["README.md"], new_files: [], delete: [] },
    boundary: { dependency_dag: "README only", entry_points: ["npx tsc --noEmit"], no_new_external: true },
    verify: {
      platform: { python_version: "3.11", setup: [] },
      smoke: [{ command: "npx tsc --noEmit", expected_exit: 0, description: "compile" }],
      tests: [{ command: "npm test", expected_exit: 0, description: "test" }],
    },
    risks: ["Scenario: state drift reaches commit; impact: unverified content; mitigation: digest preflight."],
    discussion: "Use a temp git repo to cover runtime state safety. A pure object test was rejected because git branch and diff state are the regression surface.",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

function baseState(phase: WorkflowState["phase"]): WorkflowState {
  return {
    version: "1",
    phase,
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertErrorCode(error: unknown, code: string): void {
  const actual = (error as any)?.code ?? (error as any)?.error?.code;
  if (actual !== code) throw new Error(`expected ${code}, got ${JSON.stringify(error)}`);
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-state-safety-"));

try {
  run("git init -b main", root);
  run("git config user.name test", root);
  run("git config user.email test@example.com", root);
  writeFileSync(join(root, "README.md"), "initial\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" } }, null, 2));
  run("git add README.md hy-workflow.json", root);
  run("git commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);
  chdir(root);

  writeState({
    ...baseState("ci"),
    branch: "fix/old",
    prNumber: 123,
    plan: basePlan(),
    approval: { time: "old", note: "old" },
    verifyHash: "old",
    verifiedImplementationDigest: "old-digest",
    verifiedManifestHash: "old-manifest",
    pendingAmendment: { reason: "old", scope: { changes: { add: [], remove: [] }, new_files: { add: [], remove: [] }, delete: { add: [], remove: [] } }, warnings: ["old"] },
    implementationManifest: { modified: ["README.md"], added: [], deleted: [], untracked: [], changed: ["README.md"] },
    documentReads: { beforeApprove: null },
    syncDocs: { time: "old", planHash: "old", afterEditDigest: "old", implementationDigest: "old", allowedDocs: ["README.md"] },
  });
  await handleReset();
  const resetState = readState();
  assert(resetState.phase === "plan", "reset should return to plan");
  assert(resetState.approval === null, "reset should clear stale approval");
  assert(resetState.pendingAmendment === null, "reset should clear pending amendments");
  assert(resetState.implementationManifest === null, "reset should clear implementation manifest");
  assert(resetState.documentReads === null, "reset should clear document reads");
  assert(resetState.syncDocs === null, "reset should clear sync docs");
  assert(resetState.verifiedImplementationDigest === null, "reset should clear verified implementation digest");

  writeState({ ...baseState("approve"), plan: basePlan(), approval: { time: "old", note: "old" } });
  const rejected = await handleApprove({ approved: "needs changes", note: "reject" });
  assert(rejected.approved === false, "rejected approve should report approved false");
  assert(readState().approval === null, "rejected approve should not leave approval true in status");

  writeFileSync(statePath(), "{not json\n");
  try {
    await handleStatus();
    throw new Error("corrupt state should fail");
  } catch (error) {
    assertErrorCode(error, "WORKFLOW_STATE_CORRUPT");
  }

  run("git checkout -b fix/expected", root);
  writeFileSync(join(root, "README.md"), "verified\n");
  const manifest = buildImplementationManifest(root);
  const commitState: WorkflowState = {
    ...baseState("commit"),
    branch: "fix/expected",
    plan: basePlan(),
    implementationManifest: manifest,
    verifiedImplementationDigest: computeImplementationDigest(root, manifest),
    verifiedManifestHash: computeImplementationManifestHash(manifest),
  };
  commitState.verifyHash = computeVerifyHash(commitState);
  writeState(commitState);
  writeFileSync(join(root, "README.md"), "changed after verify\n");
  const drift = await handleCommit({ title: "test", body: "test" });
  assert(drift.error?.code === "IMPLEMENTATION_DIGEST_MISMATCH", `expected digest mismatch, got ${JSON.stringify(drift)}`);

  const branchMismatchState: WorkflowState = { ...commitState, verifyHash: computeVerifyHash(commitState), branch: "fix/not-current" };
  writeState(branchMismatchState);
  const mismatch = await handleCommit({ title: "test", body: "test" });
  assert(mismatch.error?.code === "GIT_BRANCH_MISMATCH", `expected branch mismatch, got ${JSON.stringify(mismatch)}`);
} finally {
  chdir(originalCwd);
}

const nonGit = mkdtempSync(join(tmpdir(), "hy-no-git-"));
try {
  chdir(nonGit);
  try {
    await handleReset();
    throw new Error("reset outside git should fail");
  } catch (error) {
    assertErrorCode(error, "PROJECT_ROOT_NOT_FOUND");
  }
  assert(!existsSync(join(nonGit, ".git", "hy-workflow", "workflow.json")), "reset outside git should not create fake .git runtime state");
} finally {
  chdir(originalCwd);
}
