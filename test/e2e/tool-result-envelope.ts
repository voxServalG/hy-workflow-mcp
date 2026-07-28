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
import { OUTPUT_CONTROL_FIELDS } from "../../src/output/contract.js";
import { computePlanHash, writeState } from "../../src/state.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";
import { createGitGhHarness, type GitGhHarness } from "../helpers/git-gh-harness.js";

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
  if (!result.phase) throw new Error(`${name} missing phase`);
  if (!result.next) throw new Error(`${name} missing next`);
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
        purpose: "test baseline",
        time: new Date().toISOString(),
        task: "add envelope",
        planHash: null,
        docsDir: "docs",
        digest: "test",
        files: [],
        findings: [],
      },
    },
  });
  const planResult = await handlePlan({ task: "add envelope", plan: planForPlan });
  assertEnvelope("hy_plan", planResult);
  if (!planResult.summary || planResult.display?.body !== planResult.summary) {
    throw new Error("hy_plan should preserve summary and mirror it into display.body");
  }
  if (!planResult.requires_user || !planResult.stop_here) {
    throw new Error("hy_plan should require user and stop");
  }

  const planForApprove = basePlan();
  writeState({
    ...baseState("approve"),
    plan: planForApprove,
    documentReads: {
      beforeApprove: {
        stage: "before_approve",
        purpose: "test audit",
        time: new Date().toISOString(),
        task: planForApprove.task,
        planHash: computePlanHash(planForApprove),
        docsDir: "docs",
        digest: "test",
        files: [],
        findings: [],
      },
    },
  });
  const approveResult = await handleApprove({ approved: "approve", note: "test" });
  assertEnvelope("hy_approve", approveResult);
  if (approveResult.stopAfter !== "hy_reset") {
    throw new Error("hy_approve should continue the approved pipeline through hy_reset");
  }
  const pipelineSteps = approveResult.pipeline?.map((item: any) => item.step) ?? [];
  for (const step of ["hy_commit", "hy_ci", "hy_merge", "hy_chain", "hy_reset"]) {
    if (!pipelineSteps.includes(step)) throw new Error(`hy_approve pipeline missing ${step}`);
  }
  if (!approveResult.resumeAfter?.includes("baseBranch")) {
    throw new Error("hy_approve should describe merge-to-baseBranch completion");
  }

  writeState(baseState("edit"));
  const verifyResult = await handleVerify();
  assertEnvelope("hy_verify", verifyResult);
  if (!verifyResult.error || !verifyResult.allowedTools?.includes("hy_status")) {
    throw new Error("hy_verify error should include envelope guidance");
  }

  writeState(baseState("commit"));
  const noPlanCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:no-plan", noPlanCommit);
  if (!noPlanCommit.error?.message.includes("No plan")) {
    throw new Error(`hy_commit without plan should report No plan, got ${JSON.stringify(noPlanCommit)}`);
  }

  writeState({ ...baseState("commit"), plan: basePlan(), branch: "feat/envelope" });
  const commitResult = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:missing-verify", commitResult);
  if (!commitResult.error || !commitResult.hint || !commitResult.error.message.includes("Missing verified implementation digest") || !commitResult.allowedTools?.includes("hy_exam_plan") || !commitResult.allowedTools?.includes("hy_exam_submit")) {
    throw new Error("hy_commit missing digest precondition should include error and hint");
  }

  writeState({ ...baseState("commit"), plan: basePlan(), verifiedImplementationDigest: "abc123" });
  const noBranchCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:no-branch", noBranchCommit);
  if (!noBranchCommit.error?.message.includes("No active branch")) {
    throw new Error(`hy_commit without branch should report No active branch, got ${JSON.stringify(noBranchCommit)}`);
  }

  writeState({ ...baseState("commit"), plan: basePlan(), branch: "feat/not-current", verifiedImplementationDigest: "abc123" });
  const branchMismatchCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:branch-mismatch", branchMismatchCommit);
  if (branchMismatchCommit.error?.code !== "GIT_BRANCH_MISMATCH") {
    throw new Error(`hy_commit should reject current branch mismatch, got ${JSON.stringify(branchMismatchCommit)}`);
  }

  writeState(baseState("merge"));
  const mergeResult = await handleMerge();
  assertEnvelope("hy_merge", mergeResult);
  if (!mergeResult.error) throw new Error("hy_merge without PR should report error");

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
  if (!result.requires_user || !result.stop_here || result.recovery?.tool !== "hy_merge" || !result.allowedTools?.includes("hy_merge") || !result.allowedTools?.includes("hy_status")) {
    throw new Error(`hy_merge local recovery failure should expose retry controls: ${JSON.stringify(result)}`);
  }
});

await withEnvelopeMergeHarness("merge-envelope-unknown-outcome", async harness => {
  harness.setGhCapability("unavailable");
  const result = await handleMerge();
  assertEnvelope("hy_merge:unknown-outcome", result);
  if (result.ok !== false || result.phase !== "merge" || result.next !== "merge") {
    throw new Error(`hy_merge unknown outcome should preserve merge phase: ${JSON.stringify(result)}`);
  }
  if (result.error?.code !== "PR_MERGE_OUTCOME_UNCONFIRMED" || result.error?.retryable !== true) {
    throw new Error(`hy_merge unknown outcome should expose a stable retryable error: ${JSON.stringify(result.error)}`);
  }
  assertMergeIdentityDetail("hy_merge:unknown-outcome", result, harness);
  assertExactAllowedTools("hy_merge:unknown-outcome", result, ["hy_merge", "hy_status"]);
  if (!result.requires_user || !result.stop_here || result.recovery?.tool !== "hy_merge") {
    throw new Error(`hy_merge unknown outcome should direct retry through hy_merge: ${JSON.stringify(result)}`);
  }
});
