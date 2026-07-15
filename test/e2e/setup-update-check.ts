import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { checkSetupStamp, createSetupGate, SETUP_VERSION, setupStampPath, setupUpdateRequiredResult } from "../../src/bootstrap.js";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { setupHelp } from "../../src/setup-cli.js";
import { MCP_DEFINITIONS } from "../../src/setup/types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-check-"));
  execSync("git init -q", { cwd: root });
  return root;
}

function writeStamp(root: string, setupVersion: string): void {
  writeDeployment(root, { setupVersion, mode: "shared", clients: [] });
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
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-check-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(runtimeHome, "cache");
const help = setupHelp();
assert(help.includes("Interactive install/update/unset TUI"), "setup help should describe the unified TUI");
assert(!help.includes("--shared") && !help.includes("--local") && help.includes("--remove-global"), "setup help should expose one default deployment and safe global removal");
assert(MCP_DEFINITIONS["hy-workflow"].command === "hy-workflow", "setup should configure the direct hy-workflow command");
assert(MCP_DEFINITIONS["docs-gardener"].command === "docs-gardener", "setup should configure the direct docs-gardener command");
assert(fs.existsSync(path.join(originalCwd, "templates", "hy-workflow.yml")), "default setup should ship one workflow template");

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
  assert(previousDeployment.latestVersion === "2026.07.14.4", "setup gate should advertise the new deployment version");

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

  const currentRoot = tempRepo();
  writeStamp(currentRoot, SETUP_VERSION);
  const current = checkSetupStamp(currentRoot);
  assert(current.status === "current", `expected current, got ${current.status}`);
  const currentGate = createSetupGate(currentRoot);
  assert(currentGate() === null, "current setup should not stop tool dispatch");
  fs.unlinkSync(setupStampPath(currentRoot));
  assert(currentGate()?.error?.subtype === "setup_update_required", "gate should detect setup stamp drift after an earlier successful check");
} finally {
  process.chdir(originalCwd);
}
