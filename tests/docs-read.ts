import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleApprove } from "../src/tools/approve.js";
import { handlePlan } from "../src/tools/plan.js";
import { handleReadDocs } from "../src/tools/read_docs.js";
import { readState, writeState, type PlanDoc, type WorkflowState } from "../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

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
const root = mkdtempSync(join(tmpdir(), "hy-docs-read-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "server.ts"), "export const server = true;\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { docsDir: "docs" } }, null, 2) + "\n");
  writeFileSync(join(root, "docs", "workflow.md"), "# Workflow\n\nDocument reads are automatic agent gates, not user review gates.\n");
  run("git add .", root);
  run("git commit -m init", root);
  chdir(root);

  const plan = basePlan();
  writeState(planState());

  const missingBaseline = await handlePlan({ task: plan.task, plan });
  if (!String(missingBaseline.error).includes("before_plan")) {
    throw new Error(`hy_plan should require before_plan baseline, got ${JSON.stringify(missingBaseline)}`);
  }

  const baseline = await handleReadDocs({ stage: "before_plan", task: plan.task });
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

  const stateWithBaseline = readState();
  if (stateWithBaseline.documentReads?.beforePlan?.task !== plan.task) {
    throw new Error("before_plan should write task-bound document baseline");
  }
  // Check persisted snapshot also has graph fields
  const persistedBeforePlan = stateWithBaseline.documentReads!.beforePlan!;
  if (!persistedBeforePlan.docsGraphDigest) {
    throw new Error("before_plan persisted snapshot missing docsGraphDigest");
  }

  const planned = await handlePlan({ task: plan.task, plan });
  if (planned.phase !== "approve") {
    throw new Error(`hy_plan should pass after before_plan, got ${JSON.stringify(planned)}`);
  }

  const missingAudit = await handleApprove({ approved: "approve", note: "user approved" });
  if (!String(missingAudit.error).includes("before_approve")) {
    throw new Error(`hy_approve should require before_approve audit, got ${JSON.stringify(missingAudit)}`);
  }

  const audit = await handleReadDocs({ stage: "before_approve" });
  if (audit.phase !== "approve" || audit.stage !== "before_approve") {
    throw new Error(`before_approve should keep workflow in approve, got ${JSON.stringify(audit)}`);
  }
  const stateWithAudit = readState();
  if (!stateWithAudit.documentReads?.beforeApprove?.planHash) {
    throw new Error("before_approve should write plan-hash-bound document audit");
  }
  // Check graph fields in before_approve snapshot
  if (!stateWithAudit.documentReads!.beforeApprove!.docsGraphDigest) {
    throw new Error("before_approve snapshot missing docsGraphDigest");
  }

  const approved = await handleApprove({ approved: "approve", note: "user approved" });
  if (approved.phase !== "branch" || approved.approved !== true) {
    throw new Error(`hy_approve should pass after before_approve, got ${JSON.stringify(approved)}`);
  }
} finally {
  chdir(originalCwd);
}
