import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest } from "../../src/checks.js";
import { acquireMergeLock, computeImplementationDigest, readState, statePath, writeState } from "../../src/state.js";
import { handleApprove } from "../../src/tools/approve.js";
import { handleCommit } from "../../src/tools/commit.js";
import { handlePlan } from "../../src/tools/plan.js";
import { handleReset } from "../../src/tools/reset.js";
import { handleStatus } from "../../src/tools/status.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";
import type { MergeReceipt } from "../../src/merge-recovery.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

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
const runtimeHome = useRuntimeHome("hy-state-safety-runtime-");
const root = mkdtempSync(join(tmpdir(), "hy-state-safety-"));
const mergeReceipt: MergeReceipt = {
  version: 1,
  identity: {
    repository: "github.com/o/r",
    prNumber: 123,
    baseBranch: "main",
    headBranch: "fix/old",
    verifiedOid: "1".repeat(40),
  },
  preparedBaseOid: "2".repeat(40),
  mutationAttempted: false,
  remote: { outcome: "pending", evidence: "none", baseOid: null, confirmedAt: null },
  downstream: { syncBaseOid: null, candidates: [], progress: [] },
};

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

  const firstLock = acquireMergeLock();
  assert(firstLock.ok, `first merge lock acquisition should succeed: ${JSON.stringify(firstLock)}`);
  const ownerFile = join(firstLock.path, "owner.json");
  try {
    const secondLock = acquireMergeLock();
    assert(!secondLock.ok, "a concurrent merge lock acquisition must fail closed");
    assert(secondLock.owner?.token === firstLock.owner.token, "busy lock result must expose the active owner token");

    writeFileSync(ownerFile, `${JSON.stringify({ ...firstLock.owner, token: "replacement-owner-token" })}\n`, "utf-8");
    firstLock.release();
    assert(existsSync(firstLock.path), "an old owner release must not delete a replacement owner's lock");

    writeFileSync(ownerFile, `${JSON.stringify(firstLock.owner)}\n`, "utf-8");
    firstLock.release();
    assert(!existsSync(firstLock.path), "the active owner must be able to release its own lock");
  } finally {
    if (existsSync(firstLock.path)) {
      writeFileSync(ownerFile, `${JSON.stringify(firstLock.owner)}\n`, "utf-8");
      firstLock.release();
    }
  }

  const thirdLock = acquireMergeLock();
  assert(thirdLock.ok, `a released merge lock should be acquirable again: ${JSON.stringify(thirdLock)}`);
  thirdLock.release();
  assert(!existsSync(thirdLock.path), "the reacquired merge lock should release cleanly");

  writeState({
    ...baseState("commit"),
    branch: "fix/old",
    prNumber: 123,
    plan: basePlan(),
    approval: { time: "old", note: "old" },
    verifiedImplementationDigest: "old-digest",
    pendingAmendment: { reason: "old", scope: { changes: { add: [], remove: [] }, new_files: { add: [], remove: [] }, delete: { add: [], remove: [] } }, warnings: ["old"] },
    implementationManifest: { modified: ["README.md"], added: [], deleted: [], untracked: [], changed: ["README.md"] },
    documentReads: { beforeApprove: null },
    syncDocs: { time: "old", planHash: "old", afterEditDigest: "old", implementationDigest: "old", allowedDocs: ["README.md"] },
    mergeReceipt,
  });
  assert(statePath().startsWith(runtimeHome), `workflow state should live under isolated user state: ${statePath()}`);
  assert(!existsSync(join(root, ".git", "hy-workflow", "workflow.json")), "writeState must not create project-local git state");
  // Auto-reset via hy_plan from done phase: should clear all derived state and return to plan
  writeState({ ...readState(), phase: "done" as const });
  const resetResult = await handlePlan({ task: "new task after reset", plan: null });
  const resetState = readState();
  assert(resetState.phase === "plan", `auto-reset should return to plan, got ${resetState.phase}`);
  assert(resetState.approval === null, "reset should clear stale approval");
  assert(resetState.pendingAmendment === null, "reset should clear pending amendments");
  assert(resetState.implementationManifest === null, "reset should clear implementation manifest");
  assert(resetState.documentReads === null, "reset should clear document reads");
  assert(resetState.syncDocs === null, "reset should clear sync docs");
  assert(resetState.mergeReceipt === null, "reset should clear a stale merge receipt");
  assert(resetState.verifiedImplementationDigest === null, "reset should clear verified implementation digest");
  assert(resetResult.next === "plan", `reset should stop at plan (missing before_plan baseline), got ${JSON.stringify(resetResult)}`);

  writeState({ ...baseState("merge"), branch: "fix/old", prNumber: 123, mergeReceipt });
  const explicitReset = await handleReset();
  assert(explicitReset.next === "plan", "hy_reset should return to plan");
  assert(readState().mergeReceipt === null, "hy_reset should clear merge receipt state");

  const freshPlan = basePlan();
  writeState({
    ...baseState("plan"),
    mergeReceipt,
    documentReads: {
      beforePlan: {
        stage: "before_plan",
        purpose: "state reset regression",
        time: new Date().toISOString(),
        task: freshPlan.task,
        planHash: null,
        docsDir: "docs",
        digest: "state-reset-baseline",
        files: [],
        findings: [],
        docsGraphDigest: "state-reset-graph",
        entryPoints: [],
        traversalRoots: [],
      },
    },
  });
  const planned = await handlePlan({ task: freshPlan.task, plan: freshPlan });
  assert(planned.next === "approve", `a valid new plan should advance to approve, got ${JSON.stringify(planned)}`);
  assert(readState().mergeReceipt === null, "writing a new PlanDoc should clear merge receipt state");

  writeState({ ...baseState("approve"), plan: basePlan(), approval: { time: "old", note: "old" } });
  const rejected = await handleApprove({ approved: "needs changes", note: "reject" });
  assert(rejected.approved === false, "rejected approve should report approved false");
  assert(readState().approval === null, "rejected approve should not leave approval true in status");

  writeState({ ...baseState("approve"), plan: basePlan(), approval: { time: "old", note: "old" } });
  const trueString = await handleApprove({ approved: "true", note: "legacy true should reject" });
  assert(trueString.approved === false, "approved='true' should be treated as rejection");
  assert(readState().phase === "plan", "approved='true' should return to plan instead of branch");
  assert(readState().approval === null, "approved='true' rejection should clear stale approval");

  writeState({ ...baseState("approve"), plan: basePlan(), approval: { time: "old", note: "old" } });
  const booleanInput = await handleApprove({ approved: true as any, note: "boolean should reject" });
  assert(booleanInput.approved === false, "boolean approved input should be rejected without crashing");
  assert(readState().phase === "plan", "boolean approved input should return to plan instead of branch");

  writeState({ ...baseState("merge"), mergeReceipt: { ...mergeReceipt, mutationAttempted: "yes" } as any });
  try {
    readState();
    throw new Error("invalid merge receipt should fail");
  } catch (error) {
    assertErrorCode(error, "WORKFLOW_STATE_INVALID_MERGE_RECEIPT");
  }

  writeState({
    ...baseState("merge"),
    mergeReceipt: {
      ...mergeReceipt,
      downstream: {
        syncBaseOid: null,
        candidates: ["release/not-agent"],
        progress: [{ branch: "release/not-agent", preparedLocalOid: "3".repeat(40), expectedRemoteOid: "3".repeat(40), state: "pending", resultOid: null }],
      },
    },
  });
  try {
    readState();
    throw new Error("non-agent downstream receipt should fail");
  } catch (error) {
    assertErrorCode(error, "WORKFLOW_STATE_INVALID_MERGE_RECEIPT");
  }

  writeState({
    ...baseState("merge"),
    mergeReceipt: {
      ...mergeReceipt,
      downstream: {
        syncBaseOid: null,
        candidates: ["fix/downstream"],
        progress: [{ branch: "fix/downstream", preparedLocalOid: "3".repeat(40), expectedRemoteOid: "4".repeat(40), state: "pending", resultOid: null }],
      },
    },
  });
  try {
    readState();
    throw new Error("mismatched downstream snapshot receipt should fail");
  } catch (error) {
    assertErrorCode(error, "WORKFLOW_STATE_INVALID_MERGE_RECEIPT");
  }

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
    approval: { time: new Date().toISOString(), note: "approved" },
    implementationManifest: manifest,
    verifiedImplementationDigest: computeImplementationDigest(root, manifest),
  };
  writeState(commitState);
  writeFileSync(join(root, "README.md"), "changed after verify\n");
  const drift = await handleCommit({ title: "test", body: "test" });
  assert(drift.error?.code === "IMPLEMENTATION_DIGEST_MISMATCH", `expected digest mismatch, got ${JSON.stringify(drift)}`);

  const branchMismatchState: WorkflowState = { ...commitState, branch: "fix/not-current" };
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
    await handlePlan({ task: "test", plan: null });
    throw new Error("plan outside git should fail");
  } catch (error) {
    assertErrorCode(error, "PROJECT_ROOT_NOT_FOUND");
  }
  assert(!existsSync(join(nonGit, ".git", "hy-workflow", "workflow.json")), "plan outside git should not create fake .git runtime state");
} finally {
  chdir(originalCwd);
}
