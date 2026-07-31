import { mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handlePlan } from "../../src/tools/plan.js";
import { handleVerify } from "../../src/tools/verify.js";
import { handleCommit } from "../../src/tools/commit.js";
import { handleMerge } from "../../src/tools/merge.js";
import { handleStatus } from "../../src/tools/status.js";
import { handleApprove } from "../../src/tools/approve.js";
import { handleEdit } from "../../src/tools/edit.js";
import { handleSyncDocs } from "../../src/tools/sync_docs.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { OUTPUT_CONTROL_FIELDS } from "../../src/output/contract.js";
import { computePlanHash, readState, writeState } from "../../src/state.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";
import { createGitGhHarness, type GitGhHarness } from "../helpers/git-gh-harness.js";
import { workflowStageMatchesPhase } from "../../src/runtime/state-machine.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;

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

function basePlan(): PlanDoc {
  return {
    task: "add agent-facing result envelope",
    scope: { changes: ["src/tools/_base.ts"], new_files: [], delete: [] },
    boundary: { dependency_dag: "tool result helpers feed tool handlers only", entry_points: ["npx tsc --noEmit"], no_new_external: true },
    verify: {
      platform: { python_version: "3.11", setup: ["node --version"] },
      smoke: [{ command: "npx tsc --noEmit", expected_exit: 0, description: "compile" }],
      tests: [{ command: "npm test", expected_exit: 0, description: "test" }],
    },
    risks: ["Scenario: extra fields surprise clients; impact: parsing drift; mitigation: keep legacy fields."],
    discussion: "Use additive envelope fields instead of replacing the existing result shape. A breaking schema change was rejected to preserve compatibility.",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

function mergePlanFor(harness: GitGhHarness): PlanDoc {
  return {
    task: "recover one exact pull request merge while preserving the result envelope",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "verified commit -> pull request -> configured base branch -> downstream synchronization",
      entry_points: ["npx tsc --noEmit", "npm run test:e2e"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: [] },
      smoke: [{ command: "npx tsc --noEmit", expected_exit: 0, description: "compile" }],
      tests: [{ command: "npm run test:e2e", expected_exit: 0, description: "merge envelope" }],
    },
    risks: ["Scenario: remote merge succeeds before local recovery fails; impact: envelope may hide confirmed remote outcome; mitigation: assert structured outcome, evidence, and recovery fields."],
    discussion: "Exercise the real handler with an offline Git/GitHub harness. A mocked result object was rejected because it would not verify toolResult normalization.",
    branch: harness.sourceBranch,
    verify_hash: null,
    pr_number: harness.prNumber,
  };
}

function seedEnvelopeMergeState(harness: GitGhHarness): void {
  const implementationDigest = `merge-envelope-${harness.verifiedOid}`;
  writeState({
    version: "1",
    phase: "merge",
    branch: harness.sourceBranch,
    prNumber: harness.prNumber,
    plan: mergePlanFor(harness),
    approval: {
      time: new Date().toISOString(),
      note: "approved",
      commitRecovery: {
        version: 1,
        commitOid: harness.verifiedOid,
        implementationDigest,
        branch: harness.sourceBranch,
        baseBranch: harness.baseBranch,
        repository: harness.repository,
      },
    } as WorkflowState["approval"],
    verifiedImplementationDigest: implementationDigest,
  });
}

async function withEnvelopeMergeHarness(name: string, runHarness: (harness: GitGhHarness) => Promise<void>): Promise<void> {
  const previousCwd = cwd();
  const harness = createGitGhHarness(name);
  try {
    chdir(harness.root);
    seedEnvelopeMergeState(harness);
    await runHarness(harness);
  } finally {
    chdir(previousCwd);
    harness.cleanup();
  }
}

function assertEnvelope(name: string, result: any): void {
  if (typeof result.ok !== "boolean") throw new Error(`${name} missing ok`);
  if (typeof result.phase !== "string" || !result.phase) throw new Error(`${name} missing typed phase`);
  if (typeof result.stage !== "string" || !result.stage) throw new Error(`${name} missing typed stage`);
  if (!workflowStageMatchesPhase(result.phase, result.stage)) {
    throw new Error(`${name} stage ${result.stage} does not belong to phase ${result.phase}`);
  }
  if (typeof result.status !== "string" || !result.status) throw new Error(`${name} missing typed status`);
  if (typeof result.next !== "string" || !result.next) throw new Error(`${name} missing next`);
  if (!result.nextAction || (result.nextAction.tool !== null && typeof result.nextAction.tool !== "string")
      || typeof result.nextAction.phase !== "string" || typeof result.nextAction.stage !== "string"
      || typeof result.nextAction.automatic !== "boolean") {
    throw new Error(`${name} missing typed nextAction`);
  }
  if (!workflowStageMatchesPhase(result.nextAction.phase, result.nextAction.stage)) {
    throw new Error(`${name} nextAction stage ${result.nextAction.stage} does not belong to phase ${result.nextAction.phase}`);
  }
  if (!result.control || typeof result.control.automatic !== "boolean"
      || typeof result.control.stop !== "boolean" || typeof result.control.reason !== "string") {
    throw new Error(`${name} missing typed control`);
  }
  if (result.nextAction.automatic !== result.control.automatic || (result.control.stop && result.control.automatic)) {
    throw new Error(`${name} has contradictory nextAction/control automation: ${JSON.stringify(result)}`);
  }
  if (result.userAction !== null && (typeof result.userAction !== "object" || typeof result.userAction.kind !== "string")) {
    throw new Error(`${name} missing typed userAction`);
  }
}

function assertProseFreeResult(name: string, result: any): void {
  for (const field of ["display", "summary", "hint", "message", "pipeline", "stopAfter", "resumeAfter"]) {
    if (field in result) throw new Error(`${name} must not emit top-level Agent prose field ${field}: ${JSON.stringify(result)}`);
  }
  if (result.error) {
    if ("hint" in result.error) throw new Error(`${name} error must retain machine facts without presentation guidance: ${JSON.stringify(result.error)}`);
    if (typeof result.error.message !== "string") throw new Error(`${name} error must retain its diagnostic message`);
  }
  if (result.recovery && ("instruction" in result.recovery || "byLayer" in result.recovery)) {
    throw new Error(`${name} recovery must retain only machine routing facts: ${JSON.stringify(result.recovery)}`);
  }
  if (result.userAction && ("prompt" in result.userAction || "instruction" in result.userAction)) {
    throw new Error(`${name} user action must contain no Agent prose: ${JSON.stringify(result.userAction)}`);
  }
}

function assertGitExecutor(name: string, executor: any): void {
  if (executor?.executor !== "git" || executor?.available !== true || typeof executor?.checkedAt !== "string" || !executor.checkedAt) {
    throw new Error(`${name} should expose the actual available Git executor capability: ${JSON.stringify(executor)}`);
  }
}

function assertMergeIdentityDetail(name: string, result: any, harness: GitGhHarness): void {
  const identity = result.error?.detail?.identity;
  const expected = {
    repository: harness.repository,
    prNumber: harness.prNumber,
    baseBranch: harness.baseBranch,
    headBranch: harness.sourceBranch,
    verifiedOid: harness.verifiedOid,
  };
  if (!identity || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
    throw new Error(`${name} must expose exactly the five merge identity fields: ${JSON.stringify(identity)}`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (identity[field] !== value) throw new Error(`${name} identity.${field} mismatch: ${JSON.stringify(identity)}`);
  }
}

function assertExactAllowedTools(name: string, result: any, expected: string[]): void {
  if (JSON.stringify(result.allowedTools) !== JSON.stringify(expected)) {
    throw new Error(`${name} should allow exactly ${JSON.stringify(expected)}: ${JSON.stringify(result.allowedTools)}`);
  }
}

for (const field of ["ok", "phase", "next", "status", "data", "error", "summary", "checks", "findings", "pagination", "meta", "_notice"]) {
  if (!(OUTPUT_CONTROL_FIELDS as readonly string[]).includes(field)) throw new Error(`output contract missing ${field}`);
}

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

const originalCwd = cwd();
const runtimeHome = useRuntimeHome("hy-envelope-runtime-");
const root = mkdtempSync(join(tmpdir(), "hy-envelope-"));

try {
  run("git init -b main", root);
  chdir(root);

  const planForPlan = basePlan();
  writeState({
    ...baseState("plan"),
    documentReads: {
      beforePlan: {
        stage: "before_plan",
        time: new Date().toISOString(),
        task: "add envelope",
        planHash: null,
        docsDir: "docs",
        digest: "test",
        files: [],
        docsGraphDigest: "test-baseline-graph",
        entryPoints: [],
        traversalRoots: [],
      },
    },
  });
  const planResult = await handlePlan({ task: "add envelope", plan: planForPlan });
  assertEnvelope("hy_plan", planResult);
  if (planResult.plan?.task !== planForPlan.task || typeof planResult.decisionId !== "string") {
    throw new Error("hy_plan should return PlanDoc facts bound to a decision identity");
  }
  for (const field of ["display", "summary", "hint", "message"]) {
    if (field in planResult) throw new Error(`hy_plan must not produce Agent prose field ${field}`);
  }
  if ("prompt" in (planResult.userAction ?? {}) || "instruction" in (planResult.userAction ?? {})) {
    throw new Error("hy_plan userAction must contain decision facts only");
  }
  if (!planResult.requires_user || !planResult.stop_here) {
    throw new Error("hy_plan should require user and stop");
  }
  if (planResult.userAction?.kind !== "approval") {
    throw new Error(`hy_plan should request approval: ${JSON.stringify(planResult.userAction)}`);
  }

  const planForApprove = basePlan();
  writeState({
    ...baseState("approve"),
    plan: planForApprove,
    documentReads: {
      beforeApprove: {
        stage: "before_approve",
        time: new Date().toISOString(),
        task: planForApprove.task,
        planHash: computePlanHash(planForApprove),
        docsDir: "docs",
        digest: "test",
        files: [],
        docsGraphDigest: "test-audit-graph",
        entryPoints: [],
        traversalRoots: [],
      },
    },
  });
  const approveResult = await handleApprove({
    approved: "approve",
    note: "test",
    decisionId: `plan:${computePlanHash(planForApprove)}`,
  });
  assertEnvelope("hy_approve", approveResult);
  if (approveResult.userAction !== null) {
    throw new Error(`hy_approve should not request another user action: ${JSON.stringify(approveResult.userAction)}`);
  }
  if (approveResult.approved !== true || typeof approveResult.decisionId !== "string"
      || approveResult.stage !== "branch.create") {
    throw new Error(`hy_approve should return approval and branch-route facts: ${JSON.stringify(approveResult)}`);
  }
  for (const field of ["display", "summary", "hint", "message", "pipeline", "stopAfter", "resumeAfter"]) {
    if (field in approveResult) throw new Error(`hy_approve must not produce Agent prose field ${field}`);
  }

  writeState({ ...baseState("branch"), branch: "feat/envelope", plan: basePlan(), approval: { time: "historical", note: "approved" } });
  const editResult = await handleEdit();
  assertEnvelope("hy_edit", editResult);
  if (editResult.nextAction.tool !== null
      || editResult.nextAction.phase !== "edit"
      || editResult.nextAction.stage !== "edit.implementation"
      || editResult.control.reason !== "external_action_required"
      || !editResult.control.stop) {
    throw new Error(`hy_edit must stop for actual file editing instead of claiming an automatic tool transition: ${JSON.stringify(editResult)}`);
  }

  writeState(baseState("edit"));
  const verifyResult = await handleVerify();
  assertEnvelope("hy_verify", verifyResult);
  if (verifyResult.error?.code !== "VERIFY_PLAN_MISSING"
      || verifyResult.recovery?.strategy !== "reset"
      || verifyResult.nextAction.tool !== "hy_reset"
      || verifyResult.phase !== "edit"
      || verifyResult.stage !== "edit.implementation") {
    throw new Error(`hy_verify impossible state should preserve position and route reset: ${JSON.stringify(verifyResult)}`);
  }

  writeState({ ...baseState("verify"), stage: "verify.amendment" });
  const noPlanSync = await handleSyncDocs();
  assertEnvelope("hy_sync_docs:no-plan", noPlanSync);
  if (noPlanSync.phase !== "verify" || noPlanSync.stage !== "verify.amendment") {
    throw new Error(`hy_sync_docs errors must preserve the persisted verify.amendment stage: ${JSON.stringify(noPlanSync)}`);
  }
  if (noPlanSync.recovery?.strategy !== "reset" || noPlanSync.nextAction.tool !== "hy_reset") {
    throw new Error(`hy_sync_docs impossible state must expose executable reset recovery: ${JSON.stringify(noPlanSync)}`);
  }

  writeState({ ...baseState("commit"), stage: "commit.ci" });
  const noPlanCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:no-plan", noPlanCommit);
  if (noPlanCommit.error?.code !== "COMMIT_PLAN_MISSING"
      || noPlanCommit.recovery?.strategy !== "reset"
      || noPlanCommit.nextAction.tool !== "hy_reset") {
    throw new Error(`hy_commit without plan should route reset, got ${JSON.stringify(noPlanCommit)}`);
  }
  if (noPlanCommit.stage !== "commit.ci") {
    throw new Error(`hy_commit errors must preserve the persisted commit.ci stage: ${JSON.stringify(noPlanCommit)}`);
  }

  writeState({ ...baseState("commit"), plan: basePlan(), branch: "feat/envelope" });
  const commitResult = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:missing-verify", commitResult);
  assertProseFreeResult("hy_commit:missing-verify", commitResult);
  if (!commitResult.error || !commitResult.error.message.includes("Missing verified implementation digest") || !commitResult.allowedTools?.includes("hy_exam_plan") || !commitResult.allowedTools?.includes("hy_exam_submit")) {
    throw new Error("hy_commit missing digest precondition should retain the error and executable verify routes");
  }
  if (commitResult.phase !== "edit" || commitResult.stage !== "edit.implementation" || commitResult.nextAction.tool !== "hy_verify" || commitResult.nextAction.phase !== "verify" || readState().phase !== "edit") {
    throw new Error(`hy_commit verify recovery must first persist an executable edit phase: ${JSON.stringify(commitResult)}`);
  }

  writeState({ ...baseState("commit"), plan: basePlan(), verifiedImplementationDigest: "abc123" });
  const noBranchCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:no-branch", noBranchCommit);
  if (noBranchCommit.error?.code !== "COMMIT_BRANCH_MISSING"
      || noBranchCommit.recovery?.strategy !== "reset"
      || noBranchCommit.nextAction.tool !== "hy_reset") {
    throw new Error(`hy_commit without branch should route reset, got ${JSON.stringify(noBranchCommit)}`);
  }

  writeState({ ...baseState("commit"), plan: basePlan(), branch: "feat/not-current", verifiedImplementationDigest: "abc123" });
  const branchMismatchCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:branch-mismatch", branchMismatchCommit);
  assertProseFreeResult("hy_commit:branch-mismatch", branchMismatchCommit);
  if (branchMismatchCommit.error?.code !== "GIT_BRANCH_MISMATCH") {
    throw new Error(`hy_commit should reject current branch mismatch, got ${JSON.stringify(branchMismatchCommit)}`);
  }

  writeState(baseState("merge"));
  const mergeResult = await handleMerge();
  assertEnvelope("hy_merge", mergeResult);
  if (!mergeResult.error) throw new Error("hy_merge without PR should report error");

  writeState(baseState("plan"));
  const statusResult = await handleStatus();
  assertEnvelope("hy_status", statusResult);
  if (!statusResult.capabilities?.git || !statusResult.capabilities?.gh) {
    throw new Error("hy_status should expose startup git/gh capabilities");
  }
  if (!statusResult.localArtifacts?.every((item: string) => item.startsWith(runtimeHome))) {
    throw new Error(`hy_status should report identity-scoped user directories, got ${JSON.stringify(statusResult.localArtifacts)}`);
  }
  if (!statusResult.runtimePaths?.workflowState?.startsWith(runtimeHome) || statusResult.localArtifacts.includes(".hy/")) {
    throw new Error(`hy_status must not advertise project-local runtime state, got ${JSON.stringify(statusResult.runtimePaths)}`);
  }
} finally {
  chdir(originalCwd);
}

await withEnvelopeMergeHarness("merge-envelope-success", async harness => {
  harness.integrateRemote();
  harness.setGhCapability("unavailable");
  const result = await handleMerge();
  assertEnvelope("hy_merge:already-integrated", result);
  assertProseFreeResult("hy_merge:already-integrated", result);
  if (result.ok !== true || result.phase !== "done" || result.next !== "done") {
    throw new Error(`hy_merge Git recovery should complete: ${JSON.stringify(result)}`);
  }
  if (result.data?.outcome !== "already_integrated" || result.data?.evidence !== "git" || typeof result.data?.baseOid !== "string" || !result.data.baseOid) {
    throw new Error(`hy_merge Git recovery should expose outcome evidence and baseOid: ${JSON.stringify(result.data)}`);
  }
  assertGitExecutor("hy_merge:already-integrated", result.data?.executor);
});

await withEnvelopeMergeHarness("merge-envelope-sync-failure", async harness => {
  harness.setGhMergeExit("remote-success-error");
  harness.setGhViewMode("unavailable-after-merge");
  harness.failGitOnce("checkout", harness.baseBranch);
  const result = await handleMerge();
  assertEnvelope("hy_merge:post-sync-incomplete", result);
  assertProseFreeResult("hy_merge:post-sync-incomplete", result);
  if (result.ok !== false || result.phase !== "merge" || result.next !== "merge") {
    throw new Error(`hy_merge local recovery failure should preserve merge phase: ${JSON.stringify(result)}`);
  }
  if (result.error?.type !== "io" || result.error?.subtype !== "io_failure" || result.error?.code !== "POST_MERGE_SYNC_INCOMPLETE" || result.error?.retryable !== true) {
    throw new Error(`hy_merge local recovery failure should expose structured error identity: ${JSON.stringify(result.error)}`);
  }
  if (result.data?.outcome !== "already_integrated" || result.data?.evidence !== "git" || typeof result.data?.baseOid !== "string" || !result.data.baseOid) {
    throw new Error(`hy_merge local recovery failure should preserve remote outcome evidence: ${JSON.stringify(result.data)}`);
  }
  assertGitExecutor("hy_merge:post-sync-incomplete", result.data?.executor);
  assertMergeIdentityDetail("hy_merge:post-sync-incomplete", result, harness);
  if (!result.requires_user || !result.stop_here || result.recovery?.strategy !== "wait_and_retry" || result.recovery.tool !== "hy_merge" || !result.allowedTools?.includes("hy_merge") || !result.allowedTools?.includes("hy_status")) {
    throw new Error(`hy_merge local recovery failure should expose retry controls: ${JSON.stringify(result)}`);
  }
});

await withEnvelopeMergeHarness("merge-envelope-unknown-outcome", async harness => {
  harness.setGhCapability("unavailable");
  const result = await handleMerge();
  assertEnvelope("hy_merge:unknown-outcome", result);
  assertProseFreeResult("hy_merge:unknown-outcome", result);
  if (result.ok !== false || result.phase !== "merge" || result.next !== "merge") {
    throw new Error(`hy_merge unknown outcome should preserve merge phase: ${JSON.stringify(result)}`);
  }
  if (result.error?.code !== "PR_MERGE_OUTCOME_UNCONFIRMED" || result.error?.retryable !== true) {
    throw new Error(`hy_merge unknown outcome should expose a stable retryable error: ${JSON.stringify(result.error)}`);
  }
  assertMergeIdentityDetail("hy_merge:unknown-outcome", result, harness);
  assertExactAllowedTools("hy_merge:unknown-outcome", result, ["hy_merge", "hy_status"]);
  if (!result.requires_user || !result.stop_here || result.recovery?.strategy !== "wait_and_retry" || result.recovery.tool !== "hy_merge") {
    throw new Error(`hy_merge unknown outcome should direct retry through hy_merge: ${JSON.stringify(result)}`);
  }
});
