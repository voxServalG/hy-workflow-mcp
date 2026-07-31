import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleBranch } from "../../src/tools/branch.js";
import { readState, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function branches(root: string): string[] {
  return execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: root, encoding: "utf-8" })
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .sort();
}

function basePlan(): PlanDoc {
  return {
    task: "test branch recovery when origin base branch is missing",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "src/app.ts is the only implementation file under test.",
      entry_points: ["node --version"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: ["node --version"] },
      smoke: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
    },
    risks: ["Scenario: missing remote base branch; impact: branch creation fails; mitigation: return structured recovery."],
    discussion: "Return a structured recovery error instead of surfacing raw git fatal output. Falling back to a local base branch was rejected because branch provenance should stay explicit.",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
}

function branchState(plan: PlanDoc): WorkflowState {
  return {
    version: "1",
    phase: "branch",
    branch: null,
    prNumber: null,
    plan,
    approval: { time: new Date().toISOString(), note: "test" },
    verifyHash: null,
  };
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-branch-recovery-"));
const bare = mkdtempSync(join(tmpdir(), "hy-branch-recovery-origin-"));

try {
  run("git init -b dev", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "dev" } }, null, 2) + "\n", "utf-8");
  run("git add .", root);
  run("git commit -m init", root);
  run("git init --bare", bare);
  run(`git remote add origin ${bare}`, root);
  run("git push -u origin dev", root);

  chdir(root);
  const plan = basePlan();
  const beforeBranches = branches(root);

  writeState({ ...branchState(plan), approval: null });
  const unapproved = await handleBranch({ category: "fix", topic: "unapproved" });
  if (unapproved.ok !== false || unapproved.error?.code !== "APPROVAL_PLAN_MISMATCH") {
    throw new Error(`hy_branch must reject a missing approval before Git execution: ${JSON.stringify(unapproved)}`);
  }
  if (unapproved.stage !== "branch.create"
      || unapproved.nextAction?.tool !== "hy_reset"
      || unapproved.recovery?.strategy !== "reset") {
    throw new Error(`an approval failure must remain stopped at branch.create: ${JSON.stringify(unapproved)}`);
  }
  if (JSON.stringify(branches(root)) !== JSON.stringify(beforeBranches) || readState().phase !== "branch") {
    throw new Error("a missing approval must not create or switch a Git branch or advance workflow state");
  }

  writeState({
    ...branchState(plan),
    approval: { time: new Date().toISOString(), note: "stale", decisionId: "plan:000000000000", planHash: "000000000000" },
  });
  const staleApproval = await handleBranch({ category: "fix", topic: "stale-approval" });
  if (staleApproval.ok !== false || staleApproval.error?.code !== "APPROVAL_PLAN_MISMATCH") {
    throw new Error(`hy_branch must reject approval bound to another PlanDoc: ${JSON.stringify(staleApproval)}`);
  }
  if (JSON.stringify(branches(root)) !== JSON.stringify(beforeBranches)) {
    throw new Error("a stale approval must not create or switch a Git branch");
  }

  writeState({ ...branchState(plan), plan: null });
  const missingPlan = await handleBranch({ category: "fix", topic: "missing-plan" });
  if (missingPlan.ok !== false || missingPlan.error?.code !== "PLAN_MISSING") {
    throw new Error(`hy_branch must reject missing PlanDoc state: ${JSON.stringify(missingPlan)}`);
  }
  if (JSON.stringify(branches(root)) !== JSON.stringify(beforeBranches)) {
    throw new Error("a missing PlanDoc must not create or switch a Git branch");
  }

  writeState({ ...branchState(plan), phase: "approve", stage: "approve.decision" });
  const resumedApproval = await handleBranch({ category: "fix", topic: "upgraded-approved" });
  const resumedState = readState();
  if (resumedApproval.phase !== "edit"
      || resumedApproval.stage !== "edit.scope"
      || resumedState.phase !== "edit"
      || resumedState.stage !== "edit.scope"
      || resumedState.branch !== "fix/upgraded-approved"
      || !branches(root).includes("fix/upgraded-approved")) {
    throw new Error(`a valid historical approve state must persist approve to branch to edit around the Git side effect: ${JSON.stringify({ resumedApproval, resumedState })}`);
  }
  run("git checkout dev", root);

  run("git remote remove origin", root);
  writeState(branchState(plan));

  const sentinel = join(root, "branch-injection-sentinel");
  const dangerous = await handleBranch({ category: "fix", topic: `bad;touch${"${IFS}"}${sentinel}` });
  if (dangerous.ok !== false || dangerous.error?.code !== "INVALID_BRANCH_TOPIC") {
    throw new Error(`dangerous branch topic should fail before git execution, got ${JSON.stringify(dangerous)}`);
  }
  if (existsSync(sentinel)) {
    throw new Error("dangerous branch topic should not execute shell payload");
  }

  const result = await handleBranch({ category: "fix", topic: "missing-origin" });
  if (result.ok !== false) throw new Error(`hy_branch should fail without origin/dev, got ${JSON.stringify(result)}`);
  if (result.next !== "branch" || result.phase !== "branch") {
    throw new Error(`hy_branch should stay in branch phase, got ${JSON.stringify(result)}`);
  }
  if (result.error?.type !== "config") {
    throw new Error(`missing origin/dev should be a config error, got ${JSON.stringify(result.error)}`);
  }
  if (result.error?.subtype !== "config_invalid") {
    throw new Error(`missing origin/dev should be config_invalid, got ${JSON.stringify(result.error)}`);
  }
  if (result.error?.code !== "BASE_BRANCH_REMOTE_MISSING") {
    throw new Error(`missing origin/dev should expose BASE_BRANCH_REMOTE_MISSING, got ${JSON.stringify(result.error)}`);
  }
  if (!result.error?.message.includes("origin/dev")) {
    throw new Error(`missing origin/dev message should name the missing ref, got ${JSON.stringify(result.error)}`);
  }
  if (result.error?.subtype === "uncaught_exception") {
    throw new Error(`missing origin/dev must not be classified as internal uncaught, got ${JSON.stringify(result.error)}`);
  }
  if (!result.requires_user || !result.stop_here) {
    throw new Error(`branch recovery should stop for user-visible git setup, got ${JSON.stringify(result)}`);
  }
} finally {
  chdir(originalCwd);
}
