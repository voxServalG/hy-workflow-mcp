import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SETUP_VERSION } from "../../src/bootstrap.js";
import { ensureConfigDefaults } from "../../src/config.js";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { sharedArtifactEvidence, SHARED_PROJECT_FILES } from "../../src/setup/shared.js";
import { AGENTS_OPEN, AGENTS_CLOSE } from "../../src/setup/agents-rules.js";
import { MANAGED_RULES_VERSION } from "../../src/policy/docs.js";
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
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, "docs", "index.md"), "# Docs\n\nMaintained project facts and verification expectations.\n");
  writeFileSync(join(root, ".github", "workflows", "hy-workflow.yml"), "name: hy-workflow\non: [push]\njobs: {}\n");
  writeFileSync(join(root, "README.md"), "# Test\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  const canonicalSource = readFileSync(join(process.cwd(), "AGENTS.md"), "utf-8");
  const match = canonicalSource.match(new RegExp(`${AGENTS_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${AGENTS_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const agentsBlock = match?.[0]?.includes(`hy-workflow-rules-version: ${MANAGED_RULES_VERSION}`) ? match[0] : null;
  if (agentsBlock) writeFileSync(join(root, "AGENTS.md"), agentsBlock + "\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

const toolBin = mkdtempSync(join(tmpdir(), "hy-init-live-tools-"));
function liveTool(command: string): string {
  const executable = join(toolBin, process.platform === "win32" ? `${command}.cmd` : command);
  writeFileSync(executable, process.platform === "win32" ? "@echo 1.0.0\r\n" : "#!/usr/bin/env sh\nprintf '1.0.0\\n'\n", "utf-8");
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  return executable;
}
const hyExecutable = liveTool("hy-workflow");
const docsExecutable = liveTool("docs-gardener");
process.env.PATH = `${toolBin}${delimiter}${process.env.PATH ?? ""}`;

function deployment(root: string, setupVersion: string, mode: "local" | "shared"): void {
  writeDeployment(root, {
    setupVersion,
    mode,
    clients: [],
    projectFiles: [...SHARED_PROJECT_FILES],
    tools: {
      "hy-workflow": { command: "hy-workflow", executable: hyExecutable, version: "1.0.0", catalogHash: "test-hy" },
      "docs-gardener": { command: "docs-gardener", executable: docsExecutable, version: "1.0.0", catalogHash: "test-docs" },
    },
    artifacts: sharedArtifactEvidence(root),
  });
}

const runtimeHome = mkdtempSync(join(tmpdir(), "hy-init-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");

const guidance = initArtifactGuidance();
assert(guidance.commitArtifacts.length === 0, "default init must not request project commits");
assert(guidance.body.includes("hy_init itself changes no project files"), "guidance should separate setup team artifacts from hy_init behavior");
const ignoreRoot = mkdtempSync(join(tmpdir(), "hy-init-ignore-"));
assert(!ensureLocalArtifactIgnores(ignoreRoot), "hy_init must not create or update .gitignore");
assert(!existsSync(join(ignoreRoot, ".gitignore")), "hy_init ignore helper must leave the project untouched");

const missingRoot = project("hy-init-missing-");
const missing = harnessArtifactStatus(missingRoot);
assert(!missing.ready && missing.missingArtifacts.length > 0, "project without setup must not be ready");

const legacyOnlyRoot = project("hy-init-legacy-only-");
const legacyConfigPath = projectPaths(legacyOnlyRoot).config;
mkdirSync(join(legacyConfigPath, ".."), { recursive: true });
writeFileSync(legacyConfigPath, JSON.stringify({
  project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"], maxLines: 500 },
  doclint: { maxLines: 200 },
  docsGardener: { catalogs: {} },
}, null, 2) + "\n");
deployment(legacyOnlyRoot, SETUP_VERSION, "local");
assert(!harnessArtifactStatus(legacyOnlyRoot).ready, "legacy user config plus deployment must not bypass the required shared project config");
ensureConfigDefaults(legacyOnlyRoot);
assert(existsSync(join(legacyOnlyRoot, "hy-workflow.json")), "legacy config migration should create the canonical root config");
assert(!harnessArtifactStatus(legacyOnlyRoot).ready, "migrating config must not make a legacy local-mode deployment current");
deployment(legacyOnlyRoot, SETUP_VERSION, "shared");
assert(harnessArtifactStatus(legacyOnlyRoot).ready, "rerunning setup with the single shared deployment should make the migrated project ready");

const readyRoot = project("hy-init-ready-");
ensureConfigDefaults(readyRoot);
deployment(readyRoot, SETUP_VERSION, "shared");
assert(harnessArtifactStatus(readyRoot).ready, "shared config and deployment should satisfy init prerequisites");
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

const incompleteRoot = project("hy-init-incomplete-");
writeFileSync(join(incompleteRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: "main", docsDir: "docs" },
}, null, 2) + "\n");
deployment(incompleteRoot, SETUP_VERSION, "shared");
try {
  process.chdir(incompleteRoot);
  const result = await handleInit();
  assert(result.configCheck?.ok === false, `hy_init should reject an incomplete root config: ${JSON.stringify(result)}`);
  assert(result.configCheck?.issues?.some((issue: string) => issue.includes("project.codeExt is required at runtime")), "hy_init should expose the missing runtime field instead of accepting a normalized default");
  assert(result.next === "init" && result.requires_user === true && result.stop_here === true, "invalid root config must keep hy_init stopped");
} finally {
  process.chdir(oldCwd);
}

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
deployment(outdatedRoot, "0.0.0", "shared");
try {
  process.chdir(outdatedRoot);
  const result = await handleInit();
  assert(result.error?.subtype === "setup_update_required", "hy_init should reject an outdated external deployment");
  assert(result.requires_user === true && result.stop_here === true, "outdated deployment should stop hy_init");
} finally {
  process.chdir(oldCwd);
}
