import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest } from "../../src/checks.js";
import { isWorktreeClean } from "../../src/git.js";
import { MINIMAL_PROJECT_CONTRACT, writeDeployment } from "../../src/runtime/deployment.js";
import { acquireMergeLock, approvalMatchesPlan, computeImplementationDigest, computePlanHash, readState, statePath, writeState } from "../../src/state.js";
import { handleApprove } from "../../src/tools/approve.js";
import { handleCommit } from "../../src/tools/commit.js";
import { handlePlan } from "../../src/tools/plan.js";
import { handleReset } from "../../src/tools/reset.js";
import { handleStatus } from "../../src/tools/status.js";
import { isSyncDocumentPath } from "../../src/tools/sync_docs.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";
import type { MergeReceipt } from "../../src/merge-recovery.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

process.env.HY_WORKFLOW_RUNTIME_CONFIG_SOURCE = "hy-workflow.runtime-config-source.v1";

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

assert(isSyncDocumentPath("docs/README.md"), "project documentation should remain eligible for document sync");
assert(!isSyncDocumentPath("AGENTS.md"), "legacy AGENTS.md must never enter document sync");
assert(!isSyncDocumentPath(".github/workflows/hy-workflow.yml"), "the CI workflow is a code and security surface, not documentation");

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
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "initial\n");
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "docs", "README.md"), "# Test documentation\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" }, codelint: { lintDirs: ["src"] } }, null, 2));
  run("git add README.md src/app.ts docs/README.md hy-workflow.json", root);
  run("git commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);
  writeDeployment(root, { setupVersion: "legacy", mode: "shared", clients: [], projectFiles: ["AGENTS.md", "hy-workflow.json"], tools: {}, artifacts: {} });
  writeFileSync(join(root, "AGENTS.md"), "legacy injected rules\n");
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), "legacy project client config\n");
  writeFileSync(join(root, "codelint.json"), "{ invalid legacy config\n");
  chmodSync(join(root, "AGENTS.md"), 0o000);
  chmodSync(join(root, ".codex", "config.toml"), 0o000);
  chmodSync(join(root, "codelint.json"), 0o000);
  const inertManifest = buildImplementationManifest(root);
  assert(inertManifest.changed.length === 0, `legacy injections must not enter implementation manifest: ${JSON.stringify(inertManifest)}`);
  const inertClean = isWorktreeClean(root);
  assert(inertClean.ok && inertClean.value === true, `legacy injections must not make the workflow worktree dirty: ${JSON.stringify(inertClean)}`);
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

  const historicalPlan = basePlan();
  assert(!approvalMatchesPlan({} as any, historicalPlan), "a malformed in-memory approval must fail closed before any workflow gate");
  const malformedApprovals: unknown[] = [
    {},
    { time: "missing-note" },
    { note: "missing-time" },
    { time: 1, note: "wrong-time-type" },
    { time: "wrong-note-type", note: [] },
    { time: "half-bound-plan", note: "", planHash: "000000000000" },
    { time: "half-bound-decision", note: "", decisionId: "plan:000000000000" },
    {
      time: "broken-audit",
      note: "",
      decisionId: "plan:111111111111",
      planHash: "222222222222",
      audit: [{
        time: "audit",
        kind: "non_material_scope_narrowing",
        amendmentDecisionId: "amendment:test",
        previousPlanHash: "333333333333",
        planHash: "222222222222",
      }],
    },
  ];
  for (const approval of malformedApprovals) {
    const serialized = `${JSON.stringify({ ...baseState("approve"), plan: historicalPlan, approval })}\n`;
    writeFileSync(statePath(), serialized, "utf-8");
    let code = "";
    try { readState(); } catch (error: any) { code = error?.code ?? ""; }
    assert(code === "WORKFLOW_STATE_INVALID_APPROVAL", `malformed approval must make external state fail closed: ${serialized}`);
    assert(readFileSync(statePath(), "utf-8") === serialized, "approval normalization failure must not rewrite external state");
  }

  const invalidPending = `${JSON.stringify({ ...baseState("approve"), plan: historicalPlan, pendingApproval: {} })}\n`;
  writeFileSync(statePath(), invalidPending, "utf-8");
  let pendingCode = "";
  try { readState(); } catch (error: any) { pendingCode = error?.code ?? ""; }
  assert(pendingCode === "WORKFLOW_STATE_INVALID_PENDING_APPROVAL", "malformed pending approval must not replay a synthetic human decision");
  assert(readFileSync(statePath(), "utf-8") === invalidPending, "pending approval normalization failure must not rewrite external state");

  const impossiblePositions: Array<{ phase: WorkflowState["phase"]; stage: WorkflowState["stage"] }> = [
    { phase: "approve", stage: "approve.before_approve" },
    { phase: "branch", stage: "branch.create" },
    { phase: "edit", stage: "edit.after_edit" },
    { phase: "verify", stage: "verify.amendment" },
    { phase: "commit", stage: "commit.ci" },
    { phase: "merge", stage: "merge.sync" },
  ];
  for (const position of impossiblePositions) {
    writeState({ ...baseState(position.phase), stage: position.stage });
    const before = readFileSync(statePath(), "utf-8");
    const result = await handleStatus();
    assert(result.phase === position.phase && result.stage === position.stage,
      `status must preserve persisted impossible position ${position.phase}/${position.stage}: ${JSON.stringify(result)}`);
    assert(result.error?.code === "WORKFLOW_PLAN_MISSING"
      && result.recovery?.strategy === "reset"
      && result.nextAction.tool === "hy_reset",
    `status must break impossible-state loops through explicit reset recovery: ${JSON.stringify(result)}`);
    assert(readFileSync(statePath(), "utf-8") === before, "status recovery reporting must not mutate impossible state");
  }

  writeState({ ...baseState("plan"), stage: "plan.compose" });
  const planningStatus = await handleStatus();
  assert(planningStatus.stage === "plan.compose" && planningStatus.nextAction.stage === "plan.before_plan",
    `status must keep persisted current stage separate from the derived next target: ${JSON.stringify(planningStatus)}`);

  writeState({ ...baseState("approve"), plan: historicalPlan, approval: { time: "historical", note: "approved before plan hashes" } });
  const historicalStatus = await handleStatus();
  const normalizedHistoricalApproval = readState().approval;
  assert(historicalStatus.approved === true, `historical approval should remain bound to its persisted plan after upgrade: ${JSON.stringify(historicalStatus)}`);
  assert(normalizedHistoricalApproval?.planHash === computePlanHash(historicalPlan)
    && normalizedHistoricalApproval.decisionId === `plan:${computePlanHash(historicalPlan)}`,
  `historical approval should bind to the exact persisted PlanDoc during safe normalization: ${JSON.stringify(normalizedHistoricalApproval)}`);
  assert(historicalStatus.userAction === null && historicalStatus.control.reason !== "approval_required", `historical approval must not create a new approval gate: ${JSON.stringify(historicalStatus)}`);
  assert(historicalStatus.nextAction.tool === null && historicalStatus.nextAction.phase === "branch" && historicalStatus.nextAction.stage === "branch.create" && historicalStatus.control.reason === "information_required", `historical approval should preserve the decision while requiring only agent-composed branch arguments: ${JSON.stringify(historicalStatus)}`);

  writeState({
    ...baseState("verify"),
    stage: "verify.run",
    branch: "fix/historical",
    plan: historicalPlan,
    approval: { time: "historical", note: "approved" },
  });
  const missingAfterEditStatus = await handleStatus();
  assert(missingAfterEditStatus.phase === "verify"
    && missingAfterEditStatus.stage === "verify.run"
    && missingAfterEditStatus.nextAction.tool === "hy_read_docs"
    && missingAfterEditStatus.nextAction.arguments?.stage === "after_edit"
    && missingAfterEditStatus.nextAction.phase === "edit"
    && missingAfterEditStatus.nextAction.stage === "edit.after_edit"
    && missingAfterEditStatus.nextAction.automatic,
  `verify status must recover missing document evidence instead of looping to verify: ${JSON.stringify(missingAfterEditStatus)}`);

  const historicalPlanHash = computePlanHash(historicalPlan)!;
  writeState({
    ...readState(),
    documentReads: {
      afterEdit: {
        stage: "after_edit",
        purpose: "status recovery",
        time: new Date().toISOString(),
        task: historicalPlan.task,
        planHash: historicalPlanHash,
        docsDir: "docs",
        digest: "after-edit-status",
        files: [],
        findings: [],
        implementationFiles: [],
        implementationDigest: "status-digest",
      },
    },
  });
  const missingSyncStatus = await handleStatus();
  assert(missingSyncStatus.phase === "verify"
    && missingSyncStatus.stage === "verify.run"
    && missingSyncStatus.nextAction.tool === "hy_sync_docs"
    && missingSyncStatus.nextAction.phase === "edit"
    && missingSyncStatus.nextAction.stage === "edit.after_edit"
    && missingSyncStatus.nextAction.automatic,
  `verify status must route missing sync evidence to hy_sync_docs: ${JSON.stringify(missingSyncStatus)}`);

  writeState({ ...baseState("edit"), stage: "edit.implementation", plan: historicalPlan, approval: { time: "historical", note: "approved" } });
  const implementationStatus = await handleStatus();
  assert(implementationStatus.nextAction.tool === null
    && implementationStatus.nextAction.phase === "edit"
    && implementationStatus.nextAction.stage === "edit.implementation"
    && implementationStatus.nextAction.automatic === false
    && implementationStatus.control.stop
    && implementationStatus.control.reason === "external_action_required"
    && implementationStatus.userAction === null,
  `edit.implementation status must stop for real external editing work: ${JSON.stringify(implementationStatus)}`);

  writeState({ ...baseState("edit"), stage: "edit.after_edit", plan: historicalPlan, approval: { time: "historical", note: "approved" } });
  const afterEditStatus = await handleStatus();
  assert(afterEditStatus.nextAction.tool === null
    && afterEditStatus.nextAction.phase === "edit"
    && afterEditStatus.nextAction.stage === "edit.after_edit"
    && afterEditStatus.nextAction.automatic === false
    && afterEditStatus.control.stop
    && afterEditStatus.control.reason === "external_action_required"
    && afterEditStatus.userAction === null,
  `edit.after_edit status must stop until declared document edits are complete: ${JSON.stringify(afterEditStatus)}`);
  writeState({ ...readState(), stage: "edit.sync_docs" });
  const syncDocsStatus = await handleStatus();
  assert(syncDocsStatus.nextAction.tool === "hy_verify" && syncDocsStatus.nextAction.phase === "verify" && syncDocsStatus.nextAction.stage === "verify.run", `edit.sync_docs status should route to verify target: ${JSON.stringify(syncDocsStatus)}`);

  writeFileSync(statePath(), `${JSON.stringify({ ...baseState("plan"), stage: "before_plan" })}\n`, "utf-8");
  assert(readState().stage === "plan.before_plan", "historical unqualified persisted stages should migrate to their canonical phase-qualified value");
  writeState(readState());
  assert(JSON.parse(readFileSync(statePath(), "utf-8")).stage === "plan.before_plan", "historical stage aliases must never be persisted again");

  writeState({ ...baseState("commit"), plan: basePlan(), approval: { time: "old", note: "old" } });
  // A new plan must never reset a completed or active pipeline implicitly.
  writeState({ ...readState(), phase: "done" as const });
  const completedStatus = await handleStatus();
  assert(completedStatus.nextAction.automatic === completedStatus.control.automatic, `done status automation fields must agree: ${JSON.stringify(completedStatus)}`);
  assert(completedStatus.nextAction.tool === "hy_reset" && completedStatus.control.automatic && !completedStatus.control.stop, `done status should automatically resume required cleanup through hy_reset: ${JSON.stringify(completedStatus)}`);
  const beforeIllegalPlan = JSON.stringify(readState());
  try {
    await handlePlan({ task: "new task before explicit reset", plan: null });
    throw new Error("hy_plan should reject done phase before explicit reset");
  } catch (error: any) {
    assert(error?.name === "StateError", `expected StateError before reset, got ${JSON.stringify(error)}`);
  }
  assert(JSON.stringify(readState()) === beforeIllegalPlan, "hy_plan must preserve completed state and approval until hy_reset");

  writeState({ ...baseState("merge"), branch: "fix/old", prNumber: 123, mergeReceipt });
  const explicitReset = await handleReset();
  assert(explicitReset.next === "plan", "hy_reset should return to plan");
  assert(explicitReset.phase === "plan" && explicitReset.stage === "plan.before_plan", `hy_reset should expose the canonical before-plan stage: ${JSON.stringify(explicitReset)}`);
  assert(explicitReset.allowedTools?.includes("hy_read_docs") && explicitReset.nextAction.tool === null, `hy_reset must not invent a document read before the next task exists: ${JSON.stringify(explicitReset)}`);
  assert(explicitReset.control.reason === "completed" && explicitReset.userAction === null, `hy_reset should end the completed task without creating another user gate: ${JSON.stringify(explicitReset)}`);
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
  const beforeInvalid = JSON.stringify(readState());
  const invalidText = await handleApprove({ approved: "needs changes", note: "ambiguous" });
  assert(invalidText.error?.code === "APPROVAL_DECISION_INVALID", "unknown approval text should return a stable validation error");
  assert(JSON.stringify(readState()) === beforeInvalid, "unknown approval text must leave workflow state byte-equivalent");
  assert(invalidText.userAction === null && invalidText.nextAction.tool === null && invalidText.control.reason === "repair_required", "agent should repair an invalid enum without asking again or emitting an incomplete call");

  const booleanInput = await handleApprove({ approved: true as any, note: "boolean is invalid" });
  assert(booleanInput.error?.code === "APPROVAL_DECISION_INVALID", "boolean approved input should be invalid without crashing");
  assert(JSON.stringify(readState()) === beforeInvalid, "boolean approval input must not reject or mutate the plan");

  const rejected = await handleApprove({ approved: "reject", note: "needs changes" });
  assert(rejected.approved === false, "explicit reject should report approved false");
  assert(readState().phase === "plan", "explicit reject should return to plan");
  assert(readState().approval === null, "explicit reject should clear stale approval");

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
  const corruptReset = await handleReset();
  assert(corruptReset.phase === "plan" && readState().phase === "plan", `hy_reset should replace unreadable external state without touching project files: ${JSON.stringify(corruptReset)}`);

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
  writeState({ ...commitState, stage: "commit.ci" });
  const commitCiAfterReload = await handleStatus();
  assert(commitCiAfterReload.stage === "commit.ci" && commitCiAfterReload.nextAction?.stage === "commit.ci", `status must preserve commit.ci across reload: ${JSON.stringify(commitCiAfterReload)}`);
  writeState({ ...baseState("merge"), stage: "merge.sync" });
  const mergeSyncAfterReload = await handleStatus();
  assert(mergeSyncAfterReload.stage === "merge.sync" && mergeSyncAfterReload.nextAction?.stage === "merge.sync", `status must preserve merge.sync across reload: ${JSON.stringify(mergeSyncAfterReload)}`);
  writeState(commitState);
  writeFileSync(join(root, "README.md"), "changed after verify\n");
  const drift = await handleCommit({ title: "test", body: "test" });
  assert(drift.error?.code === "IMPLEMENTATION_DIGEST_MISMATCH", `expected digest mismatch, got ${JSON.stringify(drift)}`);

  const branchMismatchState: WorkflowState = { ...commitState, branch: "fix/not-current" };
  writeState(branchMismatchState);
  const mismatch = await handleCommit({ title: "test", body: "test" });
  assert(mismatch.error?.code === "GIT_BRANCH_MISMATCH", `expected branch mismatch, got ${JSON.stringify(mismatch)}`);
} finally {
  for (const file of [join(root, "AGENTS.md"), join(root, ".codex", "config.toml"), join(root, "codelint.json")]) {
    try { chmodSync(file, 0o644); } catch {}
  }
  chdir(originalCwd);
}

const minimalRoot = mkdtempSync(join(tmpdir(), "hy-minimal-artifacts-"));
run("git init -b main", minimalRoot);
run("git config user.name test", minimalRoot);
run("git config user.email test@example.com", minimalRoot);
mkdirSync(join(minimalRoot, "src"), { recursive: true });
mkdirSync(join(minimalRoot, "docs"), { recursive: true });
mkdirSync(join(minimalRoot, ".github", "workflows"), { recursive: true });
writeFileSync(join(minimalRoot, "src", "app.ts"), "export const value = 1;\n");
writeFileSync(join(minimalRoot, "docs", "README.md"), "# Facts\n\nMaintained project facts.\n");
writeFileSync(join(minimalRoot, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" } }, null, 2));
writeFileSync(join(minimalRoot, ".github", "workflows", "hy-workflow.yml"), "name: hy-workflow\n");
run("git add .", minimalRoot);
run("git commit -m init", minimalRoot);
run("git update-ref refs/remotes/origin/main HEAD", minimalRoot);
writeDeployment(minimalRoot, { setupVersion: "test", mode: "shared", clients: [], projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml"], tools: {}, artifacts: {}, projectContract: MINIMAL_PROJECT_CONTRACT });
writeFileSync(join(minimalRoot, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" }, policy: { profile: "standard" } }, null, 2));
writeFileSync(join(minimalRoot, ".github", "workflows", "hy-workflow.yml"), "name: hy-workflow\non: pull_request\n");
const minimalManifest = buildImplementationManifest(minimalRoot);
assert(minimalManifest.changed.includes("hy-workflow.json") && minimalManifest.changed.includes(".github/workflows/hy-workflow.yml"), `minimal-v1 artifact drift must remain visible: ${JSON.stringify(minimalManifest)}`);

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
