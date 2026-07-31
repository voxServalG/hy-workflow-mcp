import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleApprove } from "../../src/tools/approve.js";
import { handlePlan } from "../../src/tools/plan.js";
import { handleReadDocs } from "../../src/tools/read_docs.js";
import { handleStatus } from "../../src/tools/status.js";
import { readState, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

const DOC_BODY = "# Workflow\n\nDocument reads are automatic agent gates, not user review gates.\n";

function basePlan(): PlanDoc {
  return {
    task: "add automatic document read gates before plan and approve",
    scope: { changes: ["src/server.ts"], new_files: ["src/tools/read_docs.ts"], delete: [] },
    boundary: {
      dependency_dag: "read_docs writes document snapshots; plan and approve read them before phase transitions.",
      entry_points: ["node --version"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: ["node --version"] },
      smoke: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
    },
    risks: ["Scenario: document reads become user review gates; impact: workflow slows down; mitigation: keep read_docs automatic and only gate missing snapshots."],
    discussion: "Use a native hy_read_docs tool with two modes. A prompt-only approach was rejected because it cannot enforce document reads.",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

function planState(): WorkflowState {
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

const originalCwd = cwd();
useRuntimeHome("hy-docs-read-runtime-");
const root = mkdtempSync(join(tmpdir(), "hy-docs-read-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "guides"), { recursive: true });
  writeFileSync(join(root, "src", "server.ts"), "export const server = true;\n");
  writeFileSync(join(root, "AGENTS.md"), "# Agent Instructions\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "guides" },
    codelint: { lintDirs: ["src"] },
  }, null, 2) + "\n");
  writeFileSync(join(root, "guides", "README.md"), "# Guide README\n");
  writeFileSync(join(root, "guides", "workflow.md"), DOC_BODY);
  run("git add .", root);
  run("git commit -m init", root);
  chmodSync(join(root, "AGENTS.md"), 0o000);
  chdir(root);

  const plan = basePlan();
  const baselineTask = "add document read gates before planning and approval";
  writeState(planState());

  const missingBaseline = await handlePlan({ task: plan.task, plan });
  if (!(missingBaseline.error?.message ?? String(missingBaseline.error)).includes("before_plan")) {
    throw new Error(`hy_plan should require before_plan baseline, got ${JSON.stringify(missingBaseline)}`);
  }

  const baseline = await handleReadDocs({ stage: "before_plan", task: baselineTask });
  if (baseline.phase !== "plan" || baseline.stage !== "plan.before_plan") {
    throw new Error(`before_plan should keep workflow in plan, got ${JSON.stringify(baseline)}`);
  }
  const baselineStatus = await handleStatus();
  if (baselineStatus.nextAction.tool !== null || baselineStatus.nextAction.phase !== "plan" || baselineStatus.nextAction.stage !== "plan.compose" || baselineStatus.control.reason !== "information_required") {
    throw new Error(`status should expose plan composition without inventing task or PlanDoc arguments, got ${JSON.stringify(baselineStatus)}`);
  }
  // Check new graph-driven fields in the returned snapshot
  const bsnap = baseline.snapshot;
  if (!bsnap || !bsnap.docsGraphDigest) {
    throw new Error(`before_plan snapshot should include docsGraphDigest, got ${JSON.stringify(bsnap)}`);
  }
  if (!bsnap.traversalRoots || bsnap.traversalRoots.length === 0) {
    throw new Error(`before_plan snapshot should include traversalRoots, got ${JSON.stringify(bsnap)}`);
  }
  if (!existsSync(projectPaths(root).docsGraph) || existsSync(join(root, ".git", "hy-workflow", "docs-graph.json"))) {
    throw new Error("before_plan should create DocsGraph only in the identity-scoped user cache");
  }
  const baselineFiles = bsnap.files.map((file: any) => file.path);
  if (!baselineFiles.includes("guides/README.md") || baselineFiles.includes("AGENTS.md")) {
    throw new Error(`before_plan should read configured docs while leaving legacy AGENTS.md unread, got ${baselineFiles.join(", ")}`);
  }

  const stateWithBaseline = readState();
  if (stateWithBaseline.documentReads?.beforePlan?.task !== baselineTask) {
    throw new Error("before_plan should write the provided baseline task");
  }
  // Check persisted snapshot also has graph fields
  const persistedBeforePlan = stateWithBaseline.documentReads!.beforePlan!;
  if (!persistedBeforePlan.docsGraphDigest) {
    throw new Error("before_plan persisted snapshot missing docsGraphDigest");
  }

  const planned = await handlePlan({ task: plan.task, plan });
  if (planned.phase !== "approve") {
    throw new Error(`hy_plan should pass after before_plan even when task text differs, got ${JSON.stringify(planned)}`);
  }
  if (!planned.warnings?.some((warning: string) => warning.includes("before_plan task differs"))) {
    throw new Error(`hy_plan should warn when before_plan task differs, got ${JSON.stringify(planned)}`);
  }
  const waitingDecision = await handleStatus();
  if (waitingDecision.userAction?.kind !== "approval" || waitingDecision.nextAction.tool !== null || waitingDecision.stage !== "approve.decision") {
    throw new Error(`status must wait for the first user decision before the automatic before_approve audit: ${JSON.stringify(waitingDecision)}`);
  }

  const stateBeforePrematureAudit = JSON.stringify(readState());
  const prematureAudit = await handleReadDocs({ stage: "before_approve" });
  if (prematureAudit.phase !== "approve"
      || prematureAudit.stage !== "approve.decision"
      || prematureAudit.userAction?.kind !== "approval"
      || prematureAudit.nextAction.tool !== null
      || prematureAudit.control.reason !== "approval_required") {
    throw new Error(`before_approve must stop at the user decision when no approval has been persisted: ${JSON.stringify(prematureAudit)}`);
  }
  const stateAfterPrematureAudit = readState();
  if (JSON.stringify(stateAfterPrematureAudit) !== stateBeforePrematureAudit
      || stateAfterPrematureAudit.documentReads?.beforeApprove
      || stateAfterPrematureAudit.pendingApproval
      || stateAfterPrematureAudit.approval) {
    throw new Error(`a premature before_approve call must not audit, persist, or imply approval: ${JSON.stringify(stateAfterPrematureAudit)}`);
  }

  const missingAudit = await handleApprove({ approved: "approve", note: "user approved" });
  if (!(missingAudit.error?.message ?? String(missingAudit.error)).includes("before_approve")) {
    throw new Error(`hy_approve should require before_approve audit, got ${JSON.stringify(missingAudit)}`);
  }
  const pendingAudit = await handleStatus();
  if (pendingAudit.userAction !== null || pendingAudit.nextAction.tool !== "hy_read_docs" || pendingAudit.nextAction.arguments?.stage !== "before_approve") {
    throw new Error(`the existing approval should resume through an automatic document audit without another user gate: ${JSON.stringify(pendingAudit)}`);
  }
  const stateBeforeDrift = readState();

  writeFileSync(join(root, "guides", "workflow.md"), `${DOC_BODY}\nNew approval-relevant workflow fact.\n`);
  const driftAudit = await handleReadDocs({ stage: "before_approve" });
  if (driftAudit.changedSinceBaseline !== true || driftAudit.status !== "warning") {
    throw new Error(`before_approve should report document drift, got ${JSON.stringify(driftAudit)}`);
  }
  const auditedDecision = await handleStatus();
  if (auditedDecision.userAction !== null
      || auditedDecision.nextAction.tool !== null
      || auditedDecision.control.reason !== "review_required"
      || !auditedDecision.control.stop) {
    throw new Error(`document drift should stop for an agent audit decision without asking the user again: ${JSON.stringify(auditedDecision)}`);
  }
  const driftAuditState = readState();
  const missingAuditDecision = await handleApprove({ approved: "approve", note: "user approved" });
  if (missingAuditDecision.error?.code !== "APPROVAL_AUDIT_DECISION_REQUIRED" || missingAuditDecision.userAction !== null) {
    throw new Error(`document drift must require an explicit agent audit decision, not another user approval: ${JSON.stringify(missingAuditDecision)}`);
  }
  const replanned = await handleApprove({ approved: "approve", note: "user approved", auditDecision: "replan" });
  if (replanned.phase !== "plan"
      || replanned.nextAction.tool !== "hy_read_docs"
      || replanned.nextAction.arguments?.stage !== "before_plan"
      || replanned.nextAction.arguments?.task !== plan.task
      || replanned.userAction !== null
      || readState().plan !== null
      || readState().pendingApproval !== null) {
    throw new Error(`material document drift must return to a fresh plan baseline without fabricating a user revision: ${JSON.stringify(replanned)}`);
  }

  writeState(driftAuditState);
  const driftApproval = await handleApprove({ approved: "approve", note: "user approved", auditDecision: "continue" });
  if (driftApproval.phase !== "branch" || driftApproval.approved !== true) {
    throw new Error(`digest drift alone must not consume another user approval; the agent decides whether facts require replanning: ${JSON.stringify(driftApproval)}`);
  }

  writeState(stateBeforeDrift);
  writeFileSync(join(root, "guides", "workflow.md"), DOC_BODY);
  const audit = await handleReadDocs({ stage: "before_approve" });
  if (audit.phase !== "approve" || audit.stage !== "approve.before_approve") {
    throw new Error(`before_approve should keep workflow in approve, got ${JSON.stringify(audit)}`);
  }
  if (audit.changedSinceBaseline !== false) {
    throw new Error(`before_approve should clear drift after docs return to baseline, got ${JSON.stringify(audit)}`);
  }
  const stateWithAudit = readState();
  if (!stateWithAudit.documentReads?.beforeApprove?.planHash) {
    throw new Error("before_approve should write plan-hash-bound document audit");
  }
  // Check graph fields in before_approve snapshot
  if (!stateWithAudit.documentReads!.beforeApprove!.docsGraphDigest) {
    throw new Error("before_approve snapshot missing docsGraphDigest");
  }

  writeState({
    ...stateWithAudit,
    documentReads: {
      ...(stateWithAudit.documentReads ?? {}),
      beforeApprove: stateWithAudit.documentReads?.beforeApprove
        ? { ...stateWithAudit.documentReads.beforeApprove, planHash: "000000000000" }
        : null,
    },
  });
  const staleAudit = await handleApprove({ approved: "approve", note: "user approved" });
  if (!String(staleAudit.hint).includes("before_approve plan hash does not match")) {
    throw new Error(`hy_approve should reject stale before_approve audit, got ${JSON.stringify(staleAudit)}`);
  }

  writeState(stateWithAudit);
  writeFileSync(join(root, "guides", "unread.md"), "# Unread graph-only change\n");
  const graphOnlyDrift = await handleReadDocs({ stage: "before_approve" });
  if (graphOnlyDrift.changedSinceBaseline !== true) {
    throw new Error(`before_approve should report DocsGraph-only drift, got ${JSON.stringify(graphOnlyDrift)}`);
  }
  unlinkSync(join(root, "guides", "unread.md"));

  writeState(stateWithAudit);
  const approved = await handleApprove({ approved: "approve", note: "user approved" });
  if (approved.phase !== "branch" || approved.approved !== true) {
    throw new Error(`hy_approve should pass after before_approve, got ${JSON.stringify(approved)}`);
  }
} finally {
  try { chmodSync(join(root, "AGENTS.md"), 0o644); } catch {}
  chdir(originalCwd);
}
