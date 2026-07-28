import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { checkSetupStamp, createSetupGate, SETUP_VERSION, setupStampPath, setupUpdateRequiredResult } from "../../src/bootstrap.js";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { setupHelp } from "../../src/setup-cli.js";
import { MCP_DEFINITIONS } from "../../src/setup/types.js";
import { sharedArtifactEvidence, SHARED_PROJECT_FILES } from "../../src/setup/shared.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-check-"));
  execSync("git init -q", { cwd: root });
  return root;
}

type StampTools = {
  "hy-workflow": { command: string; executable: string; version: string; catalogHash: string };
  "docs-gardener": { command: string; executable: string; version: string; catalogHash: string };
};

let defaultStampTools: StampTools;

function writeToolExecutable(dir: string, command: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(dir, process.platform === "win32" ? `${command}.cmd` : command);
  const content = process.platform === "win32"
    ? `@echo ${version}\r\n`
    : `#!/usr/bin/env sh\nprintf '%s\\n' '${version}'\n`;
  fs.writeFileSync(executable, content, "utf-8");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  return executable;
}

function stampTools(dir: string, hyVersion = "1.0.0", docsVersion = "1.0.0"): StampTools {
  return {
    "hy-workflow": {
      command: "hy-workflow",
      executable: writeToolExecutable(dir, "hy-workflow", hyVersion),
      version: hyVersion,
      catalogHash: "test-hy",
    },
    "docs-gardener": {
      command: "docs-gardener",
      executable: writeToolExecutable(dir, "docs-gardener", docsVersion),
      version: docsVersion,
      catalogHash: "test-docs",
    },
  };
}

function writeStamp(root: string, setupVersion: string, tools = defaultStampTools): void {
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "hy-workflow.json"), "{}\n", "utf-8");
  fs.writeFileSync(path.join(root, ".github", "workflows", "hy-workflow.yml"), "name: hy-workflow\n", "utf-8");
  let agents = "";
  try { agents = fs.readFileSync(path.join(process.cwd(), "AGENTS.md"), "utf-8"); } catch { agents = "<!-- hy-workflow-rules -->\n<!-- hy-workflow-rules-version: 2026.07.16.1 -->\n内置、离线、第一方规则；旧 JSON 仅作只读迁移或漂移输入。\n<!-- /hy-workflow-rules -->\n"; }
  fs.writeFileSync(path.join(root, "AGENTS.md"), agents, "utf-8");
  writeDeployment(root, {
    setupVersion,
    mode: "shared",
    clients: [],
    projectFiles: [...SHARED_PROJECT_FILES],
    tools,
    artifacts: sharedArtifactEvidence(root),
  });
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(root, fullPath);
      if (rel.startsWith(".git")) continue;
      if (entry.isDirectory()) walk(fullPath);
      else files.push(rel);
    }
  };
  walk(root);
  return files.sort();
}

const originalCwd = process.cwd();
const originalPath = process.env.PATH ?? "";
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-check-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(runtimeHome, "cache");
const defaultToolBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-live-tools-"));
defaultStampTools = stampTools(defaultToolBin);
process.env.PATH = `${defaultToolBin}${path.delimiter}${originalPath}`;
const help = setupHelp();
assert(help.includes("Interactive install/update/unset TUI"), "setup help should describe the unified TUI");
assert(!help.includes("--shared") && !help.includes("--local") && help.includes("--remove-global"), "setup help should expose one default deployment and safe global removal");
assert(MCP_DEFINITIONS["hy-workflow"].command === "hy-workflow", "setup should configure the direct hy-workflow command");
assert(MCP_DEFINITIONS["docs-gardener"].command === "docs-gardener", "setup should configure the direct docs-gardener command");
assert(fs.existsSync(path.join(originalCwd, "templates", "hy-workflow.yml")), "default setup should ship one workflow template");
assert(fs.existsSync(path.join(originalCwd, "templates", "lint", "index.mjs")), "default setup should ship the built-in lint bundle entrypoint");

try {
  const missingRoot = tempRepo();
  process.chdir(missingRoot);
  const before = listFiles(missingRoot);
  const missing = checkSetupStamp(missingRoot);
  assert(missing.status === "missing_stamp", `expected missing_stamp, got ${missing.status}`);
  const missingResult = setupUpdateRequiredResult(missing);
  assert(missingResult.ok === false, "missing setup envelope should not be ok");
  assert(missingResult.phase === "init", "missing setup envelope should include phase");
  assert(missingResult.next === "init", "missing setup envelope should include next");
  assert(missingResult.display?.title === "hy-workflow setup update required", "missing setup envelope should include display title");
  assert(missingResult.error?.message.includes("hy-workflow setup update required"), "missing setup error should have a human-readable message");
  assert(!missingResult.error?.message.trim().startsWith("{"), "missing setup error message should not be serialized JSON");
  assert(missingResult.error?.code === "SETUP_UPDATE_REQUIRED", "missing setup error should expose a stable code");
  assert(Boolean(missingResult.hint), "missing setup envelope should include hint");
  assert(missingResult.requires_user === true, "missing setup envelope should require user");
  assert(missingResult.stop_here === true, "missing setup envelope should stop here");
  assert(missingResult.allowedTools?.includes("hy_status"), "missing setup envelope should allow hy_status");
  assert(missingResult.blockedTools?.includes("hy_plan"), "missing setup envelope should block hy_plan");
  assert(missingResult.recovery?.instruction?.includes("npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest"), "missing setup envelope should include npm update command");
  assert(missingResult.recovery?.instruction?.includes("hy-workflow setup"), "missing setup envelope should rerun the installed setup command");
  assert(missingResult.display?.body?.includes("registry.npmmirror.com"), "missing setup display should include the optional mainland mirror");
  assert(JSON.stringify(before) === JSON.stringify(listFiles(missingRoot)), "setup check must not write files");

  const gate = createSetupGate(missingRoot);
  assert(gate()?.error?.subtype === "setup_update_required", "gate should stop on first missing setup check");
  assert(gate()?.error?.subtype === "setup_update_required", "gate should re-check missing setup on later dispatches");

  const outdatedRoot = tempRepo();
  writeStamp(outdatedRoot, "0.0.0");
  const outdated = checkSetupStamp(outdatedRoot);
  assert(outdated.status === "outdated", `expected outdated, got ${outdated.status}`);
  assert(outdated.currentVersion === "0.0.0", "outdated check should expose current version");

  const previousDeploymentRoot = tempRepo();
  writeStamp(previousDeploymentRoot, "2026.07.14.3");
  const previousDeployment = checkSetupStamp(previousDeploymentRoot);
  assert(previousDeployment.status === "outdated", `previous deployment must rerun setup, got ${previousDeployment.status}`);
  assert(previousDeployment.latestVersion === SETUP_VERSION, "setup gate should advertise the new deployment version");

  const legacyStampRoot = tempRepo();
  const legacyStampPath = path.join(legacyStampRoot, ".git", "hy-workflow", "setup.json");
  fs.mkdirSync(path.dirname(legacyStampPath), { recursive: true });
  fs.writeFileSync(legacyStampPath, JSON.stringify({ setupVersion: "2026.07.14.2" }) + "\n", "utf-8");
  const legacyStamp = checkSetupStamp(legacyStampRoot);
  assert(legacyStamp.status === "missing_stamp", `legacy project stamp must not count as an external deployment, got ${legacyStamp.status}`);
  assert(legacyStamp.currentVersion === null, "legacy project stamp must not supply the active deployment version");
  assert(legacyStamp.stampPath === setupStampPath(legacyStampRoot), "legacy reads should still direct users to the external deployment path");

  const currentLegacyStampRoot = tempRepo();
  const currentLegacyStampPath = path.join(currentLegacyStampRoot, ".git", "hy-workflow", "setup.json");
  fs.mkdirSync(path.dirname(currentLegacyStampPath), { recursive: true });
  fs.writeFileSync(currentLegacyStampPath, JSON.stringify({ setupVersion: SETUP_VERSION }) + "\n", "utf-8");
  const currentLegacyStamp = checkSetupStamp(currentLegacyStampRoot);
  assert(currentLegacyStamp.status === "missing_stamp" && currentLegacyStamp.currentVersion === null, "even a current-version legacy stamp must not bypass the required external deployment");

  const corruptDeploymentRoot = tempRepo();
  const corruptDeploymentPath = setupStampPath(corruptDeploymentRoot);
  fs.mkdirSync(path.dirname(corruptDeploymentPath), { recursive: true });
  fs.writeFileSync(corruptDeploymentPath, JSON.stringify({ setupVersion: SETUP_VERSION }) + "\n", "utf-8");
  const corruptDeployment = checkSetupStamp(corruptDeploymentRoot);
  assert(corruptDeployment.status === "unreadable", "an external file without the deployment schema must fail closed as unreadable");

  const mismatchedIdentityRoot = tempRepo();
  writeStamp(mismatchedIdentityRoot, SETUP_VERSION);
  const mismatchedIdentityPath = setupStampPath(mismatchedIdentityRoot);
  const mismatchedIdentity = JSON.parse(fs.readFileSync(mismatchedIdentityPath, "utf-8"));
  mismatchedIdentity.identity.root = `${mismatchedIdentity.identity.root}-other`;
  fs.writeFileSync(mismatchedIdentityPath, JSON.stringify(mismatchedIdentity, null, 2) + "\n", "utf-8");
  assert(checkSetupStamp(mismatchedIdentityRoot).status === "unreadable", "a deployment for another canonical project identity must fail closed");

  const missingBinaryRoot = tempRepo();
  const missingBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-missing-tool-"));
  const missingTools = stampTools(missingBin);
  writeStamp(missingBinaryRoot, SETUP_VERSION, missingTools);
  fs.unlinkSync(missingTools["docs-gardener"].executable);
  process.env.PATH = `${missingBin}${path.delimiter}${originalPath}`;
  const missingBinary = checkSetupStamp(missingBinaryRoot);
  assert(missingBinary.status === "tool_mismatch" && missingBinary.issues?.some(issue => issue.includes("recorded executable is missing")), `missing recorded binary must fail closed: ${JSON.stringify(missingBinary)}`);

  const versionMismatchRoot = tempRepo();
  const versionBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-version-tool-"));
  const versionTools = stampTools(versionBin);
  writeStamp(versionMismatchRoot, SETUP_VERSION, versionTools);
  writeToolExecutable(versionBin, "hy-workflow", "2.0.0");
  process.env.PATH = `${versionBin}${path.delimiter}${originalPath}`;
  const versionMismatch = checkSetupStamp(versionMismatchRoot);
  assert(versionMismatch.status === "tool_mismatch" && versionMismatch.issues?.some(issue => issue.includes("version changed")), `replaced binary version must fail closed: ${JSON.stringify(versionMismatch)}`);

  const pathMismatchRoot = tempRepo();
  const recordedBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-recorded-tool-"));
  const replacementBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-replacement-tool-"));
  const recordedTools = stampTools(recordedBin);
  stampTools(replacementBin);
  writeStamp(pathMismatchRoot, SETUP_VERSION, recordedTools);
  process.env.PATH = `${replacementBin}${path.delimiter}${originalPath}`;
  const pathMismatch = checkSetupStamp(pathMismatchRoot);
  assert(pathMismatch.status === "tool_mismatch" && pathMismatch.issues?.some(issue => issue.includes("executable path changed")), `PATH replacement must fail closed: ${JSON.stringify(pathMismatch)}`);

  process.env.PATH = `${defaultToolBin}${path.delimiter}${originalPath}`;

  const currentRoot = tempRepo();
  writeStamp(currentRoot, SETUP_VERSION);
  const current = checkSetupStamp(currentRoot);
  assert(current.status === "current", `expected current, got ${current.status}`);
  const currentGate = createSetupGate(currentRoot);
  assert(currentGate() === null, "current setup should not stop tool dispatch");
  const currentConfig = path.join(currentRoot, "hy-workflow.json");
  const originalConfig = fs.readFileSync(currentConfig, "utf-8");
  fs.appendFileSync(currentConfig, " ");
  const drift = checkSetupStamp(currentRoot);
  assert(drift.status === "artifact_drift" && drift.artifactDrift?.some(item => item.file === "hy-workflow.json"), "team artifact content drift must fail closed");
  const driftResult = setupUpdateRequiredResult(drift);
  assert(driftResult.error?.code === "SETUP_ARTIFACT_DRIFT", "artifact drift should expose a stable setup code");
  assert(driftResult.recovery?.instruction === "hy-workflow setup --dry-run --json", "artifact drift recovery must begin with a no-write review");
  const driftGuidance = JSON.stringify(driftResult);
  assert(driftGuidance.includes("--review-artifact") && !driftGuidance.includes("--accept-artifact-changes --json"), "artifact drift recovery must never suggest an unusable bare acceptance flag");
  fs.writeFileSync(currentConfig, originalConfig, "utf-8");
  assert(currentGate() === null, "restoring accepted artifact bytes should restore the current gate");
  fs.unlinkSync(setupStampPath(currentRoot));
  assert(currentGate()?.error?.subtype === "setup_update_required", "gate should detect setup stamp drift after an earlier successful check");
} finally {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
}
