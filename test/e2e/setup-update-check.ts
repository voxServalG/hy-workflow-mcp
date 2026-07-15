import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { checkSetupStamp, createSetupGate, SETUP_VERSION, setupStampPath, setupUpdateRequiredResult } from "../../src/bootstrap.js";
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
  const stampPath = setupStampPath(root);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, JSON.stringify({ schemaVersion: "1", setupVersion }, null, 2) + "\n", "utf-8");
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
assert(help.includes("--shared") && help.includes("--remove-global"), "setup help should expose shared mode and safe global removal");
assert(MCP_DEFINITIONS["hy-workflow"].command === "hy-workflow", "setup should configure the direct hy-workflow command");
assert(MCP_DEFINITIONS["docs-gardener"].command === "docs-gardener", "setup should configure the direct docs-gardener command");
assert(fs.existsSync(path.join(originalCwd, "templates", "hy-workflow.yml")), "explicit shared mode should ship one workflow template");

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
