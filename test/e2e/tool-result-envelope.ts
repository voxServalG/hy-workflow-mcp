import { mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handlePlan } from "../../src/tools/plan.js";
import { handleVerify } from "../../src/tools/verify.js";
import { handleCommit } from "../../src/tools/commit.js";
import { handleCi } from "../../src/tools/ci.js";
import { handleMerge } from "../../src/tools/merge.js";
import { handleStatus } from "../../src/tools/status.js";
import { handleApprove } from "../../src/tools/approve.js";
import { OUTPUT_CONTROL_FIELDS } from "../../src/output/contract.js";
import { computePlanHash, writeState } from "../../src/state.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";

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

function assertEnvelope(name: string, result: any): void {
  if (typeof result.ok !== "boolean") throw new Error(`${name} missing ok`);
  if (!result.phase) throw new Error(`${name} missing phase`);
  if (!result.next) throw new Error(`${name} missing next`);
}

for (const field of ["ok", "phase", "next", "status", "data", "error", "summary", "checks", "findings", "pagination", "meta", "_notice"]) {
  if (!(OUTPUT_CONTROL_FIELDS as readonly string[]).includes(field)) throw new Error(`output contract missing ${field}`);
}

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

const originalCwd = cwd();
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
  if (!commitResult.error || !commitResult.hint || !commitResult.error.message.includes("Missing verifyHash")) {
    throw new Error("hy_commit missing verifyHash precondition should include error and hint");
  }

  writeState({ ...baseState("commit"), plan: basePlan(), verifyHash: "abc123" });
  const noBranchCommit = await handleCommit({ title: "test", body: "test" });
  assertEnvelope("hy_commit:no-branch", noBranchCommit);
  if (!noBranchCommit.error?.message.includes("No active branch")) {
    throw new Error(`hy_commit without branch should report No active branch, got ${JSON.stringify(noBranchCommit)}`);
  }

  writeState(baseState("ci"));
  const ciResult = await handleCi({ timeoutSeconds: 0, intervalSeconds: 2 });
  assertEnvelope("hy_ci", ciResult);
  if (!ciResult.error) throw new Error("hy_ci without PR should report error");

  writeState(baseState("merge"));
  const mergeResult = await handleMerge();
  assertEnvelope("hy_merge", mergeResult);
  if (!mergeResult.error) throw new Error("hy_merge without PR should report error");

  const statusResult = await handleStatus();
  assertEnvelope("hy_status", statusResult);
} finally {
  chdir(originalCwd);
}
