import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chdir, cwd } from "node:process";
import { runCompile } from "../../src/checks.js";
import { configuredBaseBranch } from "../../src/runtime/project.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { computePlanHash, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";
import { handleReadDocs } from "../../src/tools/read_docs.js";
import { handleSyncDocs } from "../../src/tools/sync_docs.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function fullConfig(baseBranch = "main"): Record<string, unknown> {
  return {
    project: { baseBranch, codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"] },
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

function basePlan(): PlanDoc {
  return {
    task: "verify the runtime root config source",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: { dependency_dag: "root config controls all runtime consumers", entry_points: ["node --version"], no_new_external: true },
    verify: {
      platform: { python_version: "N/A", setup: [] },
      smoke: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node exists" }],
    },
    risks: ["Scenario: legacy config is consumed; impact: runtime behavior drifts; mitigation: fail closed without complete root config."],
    discussion: "Use direct runtime consumers. A config-only unit test was rejected because tool envelopes are part of the contract.",
    branch: "fix/runtime-config-source",
    verify_hash: null,
    pr_number: null,
  };
}

const originalCwd = cwd();
useRuntimeHome("hy-runtime-config-source-home-");
const root = mkdtempSync(join(tmpdir(), "hy-runtime-config-source-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "docs", "README.md"), "# Docs\n");
  writeFileSync(join(root, "codelint.json"), JSON.stringify({ baseBranch: "legacy-main", codeExt: ".ts", codeDirs: ["src"], lintDirs: ["src"] }) + "\n");
  writeFileSync(join(root, "doclint.json"), JSON.stringify({ docsDir: "docs" }) + "\n");
  const localConfig = projectPaths(root).config;
  mkdirSync(dirname(localConfig), { recursive: true });
  writeFileSync(localConfig, JSON.stringify(fullConfig("local-main"), null, 2) + "\n");
  run("git add .", root);
  run("git commit -m init", root);
  chdir(root);

  let branchError: any = null;
  try {
    configuredBaseBranch(root);
  } catch (error) {
    branchError = error;
  }
  assert(branchError?.code === "ROOT_CONFIG_REQUIRED" && branchError?.subtype === "config_invalid", `legacy config must not provide baseBranch without root config: ${JSON.stringify(branchError)}`);

  const compileMissing = runCompile(root)[0];
  assert(!compileMissing.passed && compileMissing.hard && compileMissing.detail.includes("Runtime project config is required"), `legacy codelint must not provide compile config: ${JSON.stringify(compileMissing)}`);

  writeState(planState());
  const readMissing = await handleReadDocs({ stage: "before_plan", task: "read runtime docs" });
  assert(readMissing.error?.code === "ROOT_CONFIG_REQUIRED" && readMissing.error?.subtype === "config_invalid", `hy_read_docs should return structured missing-root error: ${JSON.stringify(readMissing)}`);
  const serializedReadMissing = JSON.parse(JSON.stringify(readMissing));
  assert(serializedReadMissing.error?.message?.includes("Runtime project config is required"), `structured root config errors must retain message after MCP JSON serialization: ${JSON.stringify(serializedReadMissing)}`);

  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", docsDir: "docs" },
  }, null, 2) + "\n");
  const readIncomplete = await handleReadDocs({ stage: "before_plan", task: "read runtime docs" });
  assert(readIncomplete.error?.code === "ROOT_CONFIG_INVALID", `hy_read_docs should reject incomplete root config despite compat files: ${JSON.stringify(readIncomplete)}`);
  assert(readIncomplete.error?.detail?.issues?.some((issue: string) => issue.includes("project.codeExt is required at runtime")), `hy_read_docs should expose missing required fields: ${JSON.stringify(readIncomplete.error)}`);

  const plan = basePlan();
  const planHash = computePlanHash(plan);
  writeState({
    ...planState(),
    phase: "edit",
    branch: plan.branch,
    plan,
    approval: { time: new Date().toISOString(), note: "test" },
    documentReads: {
      beforePlan: null,
      beforeApprove: null,
      afterEdit: { planHash } as any,
    },
  });
  const syncIncomplete = await handleSyncDocs();
  assert(syncIncomplete.error?.code === "ROOT_CONFIG_INVALID", `hy_sync_docs should reject incomplete root config before using compat or defaults: ${JSON.stringify(syncIncomplete)}`);

  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify(fullConfig("main"), null, 2) + "\n");
  assert(configuredBaseBranch(root) === "main", "configuredBaseBranch should use the complete root config instead of conflicting legacy values");
} finally {
  chdir(originalCwd);
}
