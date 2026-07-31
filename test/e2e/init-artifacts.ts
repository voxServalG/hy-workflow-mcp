import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectRuntimeConfigSource } from "../../src/config.js";
import { MINIMAL_PROJECT_CONTRACT, writeDeployment } from "../../src/runtime/deployment.js";
import { atomicWriteJson, projectPaths } from "../../src/runtime/user-paths.js";
import { ensureLocalArtifactIgnores, handleInit, harnessArtifactStatus, initArtifactGuidance } from "../../src/tools/init.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function project(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "hy test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "docs", "README.md"), "# Documentation\n\nMaintained project facts.\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function fullConfig(): Record<string, unknown> {
  return {
    project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
    docsGardener: { catalogs: {} },
    policy: { profile: "standard" },
  };
}

function deployment(root: string, options: { version?: string; minimal?: boolean; mode?: "local" | "shared" } = {}): void {
  writeDeployment(root, {
    setupVersion: options.version ?? "2026.07.30.0",
    mode: options.mode ?? "shared",
    clients: [],
    projectFiles: options.minimal ? ["hy-workflow.json", ".github/workflows/hy-workflow.yml"] : ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"],
    tools: {},
    artifacts: {},
    ...(options.minimal ? { projectContract: MINIMAL_PROJECT_CONTRACT } : {}),
  });
}

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-init-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(runtime, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(runtime, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(runtime, "cache");

const guidance = initArtifactGuidance();
assert(guidance.commitArtifacts.length === 0, "hy_init must never request a project commit");
assert(guidance.body.includes("hy_init changes no project files") && guidance.body.includes("Historical repository injections are inert"), "init guidance must state the seamless boundary plainly");
const ignoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-init-ignore-"));
assert(!ensureLocalArtifactIgnores(ignoreRoot) && !fs.existsSync(path.join(ignoreRoot, ".gitignore")), "hy_init must never change .gitignore");

const missingRoot = project("hy-init-missing-");
const missing = harnessArtifactStatus(missingRoot);
assert(!missing.ready && missing.requiredArtifacts.length === 1 && missing.missingArtifacts.includes(projectPaths(missingRoot).deployment), "only the external deployment is a required setup artifact");

const legacyRoot = project("hy-init-legacy-");
fs.writeFileSync(path.join(legacyRoot, "hy-workflow.json"), "{ invalid legacy injection\n");
fs.writeFileSync(path.join(legacyRoot, "AGENTS.md"), "old injected rules\n");
atomicWriteJson(projectPaths(legacyRoot).config, fullConfig());
deployment(legacyRoot, { version: "2025.01.01.0", mode: "local" });
assert(harnessArtifactStatus(legacyRoot).ready, "old local/shared naming and old setup version must not require migration");

const newRoot = project("hy-init-new-");
fs.writeFileSync(path.join(newRoot, "hy-workflow.json"), JSON.stringify(fullConfig(), null, 2) + "\n");
atomicWriteJson(projectPaths(newRoot).config, projectRuntimeConfigSource());
deployment(newRoot, { minimal: true });
const before = git(newRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
const oldCwd = process.cwd();
try {
  process.chdir(newRoot);
  const result = await handleInit();
  assert(result.next === "plan", `hy_init should advance to plan: ${JSON.stringify(result)}`);
  assert(result.phase === "plan" && result.stage === "plan.before_plan", `hy_init should emit the canonical before-plan stage: ${JSON.stringify(result)}`);
  assert(result.allowedTools?.includes("hy_read_docs") && result.nextAction.tool === null, `hy_init must not invent an executable document read before a task exists: ${JSON.stringify(result)}`);
  assert(result.control.reason === "information_required" && result.userAction?.kind === "provide_information", `hy_init should request task information without inventing an approval: ${JSON.stringify(result)}`);
  assert(result.projectFilesChanged?.length === 0, "hy_init must report zero project changes");
  assert(result.configAuthority?.kind === "project", "new minimal deployment must report project config authority");
} finally {
  process.chdir(oldCwd);
}
assert(git(newRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) === before, "hy_init must preserve exact Git status");

const invalidRoot = project("hy-init-invalid-new-");
fs.writeFileSync(path.join(invalidRoot, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main" } }) + "\n");
atomicWriteJson(projectPaths(invalidRoot).config, projectRuntimeConfigSource());
deployment(invalidRoot, { minimal: true });
try {
  process.chdir(invalidRoot);
  const result = await handleInit();
  assert(result.error?.code === "ROOT_CONFIG_INVALID" && result.requires_user === true, "invalid authoritative new config must stop init with a typed repair action");
} finally {
  process.chdir(oldCwd);
}

const outdatedRoot = project("hy-init-outdated-");
deployment(outdatedRoot, { version: "0.0.0" });
try {
  process.chdir(outdatedRoot);
  const result = await handleInit();
  assert(result.next === "plan" && !result.error, "old deployment version must upgrade silently without setup or approval");
} finally {
  process.chdir(oldCwd);
}

console.log("init-artifacts: external authority only, legacy upgrade silent, worktree unchanged");
