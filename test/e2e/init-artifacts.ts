import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETUP_VERSION } from "../../src/bootstrap.js";
import { ensureConfigDefaults } from "../../src/config.js";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { ensureLocalArtifactIgnores, handleInit, harnessArtifactStatus, initArtifactGuidance, trackedLocalArtifactDiagnostics } from "../../src/tools/init.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function project(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, "docs", "index.md"), "# Docs\n");
  writeFileSync(join(root, "README.md"), "# Test\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

const runtimeHome = mkdtempSync(join(tmpdir(), "hy-init-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");

const guidance = initArtifactGuidance();
assert(guidance.commitArtifacts.length === 0, "default init must not request project commits");
assert(guidance.body.includes("do not change project files"), "guidance should state the zero-project-change default");
const ignoreRoot = mkdtempSync(join(tmpdir(), "hy-init-ignore-"));
assert(!ensureLocalArtifactIgnores(ignoreRoot), "hy_init must not create or update .gitignore");
assert(!existsSync(join(ignoreRoot, ".gitignore")), "hy_init ignore helper must leave the project untouched");

const missingRoot = project("hy-init-missing-");
const missing = harnessArtifactStatus(missingRoot);
assert(!missing.ready && missing.missingArtifacts.length > 0, "project without setup must not be ready");

const readyRoot = project("hy-init-ready-");
ensureConfigDefaults(readyRoot);
writeDeployment(readyRoot, { setupVersion: SETUP_VERSION, mode: "local", clients: [] });
assert(harnessArtifactStatus(readyRoot).ready, "external config and deployment should satisfy init prerequisites");
const before = git(readyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
const oldCwd = process.cwd();
try {
  process.chdir(readyRoot);
  const result = await handleInit();
  assert(result.next === "plan", `hy_init should advance to plan: ${JSON.stringify(result)}`);
  assert(Array.isArray(result.projectFilesChanged) && result.projectFilesChanged.length === 0, "hy_init must report zero project file changes");
} finally {
  process.chdir(oldCwd);
}
const after = git(readyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
assert(after === before, `hy_init must preserve exact git status; before=${before} after=${after}`);

const trackedRoot = project("hy-init-tracked-");
mkdirSync(join(trackedRoot, ".hy"), { recursive: true });
writeFileSync(join(trackedRoot, ".hy", "workflow.json"), "{}\n");
writeFileSync(join(trackedRoot, "codelint.json"), "{}\n");
git(trackedRoot, ["add", ".hy/workflow.json", "codelint.json"]);
git(trackedRoot, ["commit", "-m", "legacy"]);
const tracked = trackedLocalArtifactDiagnostics(trackedRoot);
assert(tracked.includes(".hy/workflow.json") && tracked.includes("codelint.json"), "legacy tracked artifacts should remain diagnosable");
assert(initArtifactGuidance(tracked).body.includes("separate cleanup change"), "legacy cleanup must be explicit and separate");

const outdatedRoot = project("hy-init-outdated-");
ensureConfigDefaults(outdatedRoot);
writeDeployment(outdatedRoot, { setupVersion: "0.0.0", mode: "local", clients: [] });
try {
  process.chdir(outdatedRoot);
  const result = await handleInit();
  assert(result.error?.subtype === "setup_update_required", "hy_init should reject an outdated external deployment");
  assert(result.requires_user === true && result.stop_here === true, "outdated deployment should stop hy_init");
} finally {
  process.chdir(oldCwd);
}
