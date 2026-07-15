import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleApprove } from "../../src/tools/approve.js";
import { handlePlan } from "../../src/tools/plan.js";
import { handleReadDocs } from "../../src/tools/read_docs.js";
import { readState, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

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
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { docsDir: "guides" } }, null, 2) + "\n");
  writeFileSync(join(root, "guides", "README.md"), "# Guide README\n");
  writeFileSync(join(root, "guides", "workflow.md"), DOC_BODY);
  run("git add .", root);
  run("git commit -m init", root);
  chdir(root);

  const plan = basePlan();
  const baselineTask = "add document read gates before planning and approval";
  writeState(planState());

  const missingBaseline = await handlePlan({ task: plan.task, plan });
  if (!(missingBaseline.error?.message ?? String(missingBaseline.error)).includes("before_plan")) {
    throw new Error(`hy_plan should require before_plan baseline, got ${JSON.stringify(missingBaseline)}`);
  }

  const baseline = await handleReadDocs({ stage: "before_plan", task: baselineTask });
  if (baseline.phase !== "plan" || baseline.stage !== "before_plan") {
    throw new Error(`before_plan should keep workflow in plan, got ${JSON.stringify(baseline)}`);
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
  if (!baselineFiles.includes("guides/README.md") || !baselineFiles.includes("AGENTS.md")) {
    throw new Error(`before_plan should consistently read custom docsDir README and AGENTS.md supplemental entries, got ${baselineFiles.join(", ")}`);
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

  const missingAudit = await handleApprove({ approved: "approve", note: "user approved" });
  if (!(missingAudit.error?.message ?? String(missingAudit.error)).includes("before_approve")) {
    throw new Error(`hy_approve should require before_approve audit, got ${JSON.stringify(missingAudit)}`);
  }

  writeFileSync(join(root, "guides", "workflow.md"), `${DOC_BODY}\nNew approval-relevant workflow fact.\n`);
  const driftAudit = await handleReadDocs({ stage: "before_approve" });
  if (driftAudit.changedSinceBaseline !== true) {
    throw new Error(`before_approve should report document drift, got ${JSON.stringify(driftAudit)}`);
  }
  const driftApproval = await handleApprove({ approved: "approve", note: "user approved" });
  if (!String(driftApproval.hint).includes("document changes since before_plan")) {
    throw new Error(`hy_approve should reject before_approve document drift, got ${JSON.stringify(driftApproval)}`);
  }

  writeFileSync(join(root, "guides", "workflow.md"), DOC_BODY);
  const audit = await handleReadDocs({ stage: "before_approve" });
  if (audit.phase !== "approve" || audit.stage !== "before_approve") {
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

  const changedPlan = { ...plan, discussion: `${plan.discussion} Changed after the approval audit.` };
  writeState({ ...stateWithAudit, plan: changedPlan });
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
  chdir(originalCwd);
}
