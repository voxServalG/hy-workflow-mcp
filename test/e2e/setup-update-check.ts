import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { checkSetupStamp, createSetupGate, SETUP_STAMP, SETUP_VERSION, setupUpdateRequiredResult } from "../../src/bootstrap.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-check-"));
  execSync("git init -q", { cwd: root });
  return root;
}

function writeStamp(root: string, setupVersion: string): void {
  const stampPath = path.join(root, SETUP_STAMP);
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
const setupPrompt = fs.readFileSync(path.join(originalCwd, "setup"), "utf-8");

assert(setupPrompt.includes(".github/workflows/hy-workflow.yml"), "setup prompt should name the single tracked workflow");
assert(setupPrompt.includes("hy-workflow.json 是唯一人工维护配置源"), "setup prompt should describe unified config as source of truth");
assert(setupPrompt.includes("只有在用户明确要求配置某个客户端时"), "setup prompt should not ask agents to always write client config");
assert(setupPrompt.includes(".opencode/opencode.json"), "setup prompt should describe OpenCode config path as local client state");
assert(setupPrompt.includes(".codex/config.toml"), "setup prompt should describe Codex config path as local client state");
assert(!setupPrompt.includes("[mcp_servers.hy-workflow]"), "setup prompt should not include a concrete Codex config block by default");
assert(!setupPrompt.includes("\"\\$schema\": \"https://opencode.ai/config.json\""), "setup prompt should not include a concrete OpenCode JSON block by default");
assert(setupPrompt.includes("hy_read_docs(before_plan)"), "setup prompt should include before_plan document read gate");
assert(setupPrompt.includes("hy_read_docs(before_approve)"), "setup prompt should include before_approve document read gate");
assert(setupPrompt.includes("hy_read_docs(after_edit)"), "setup prompt should include after_edit document read gate");
assert(setupPrompt.includes("hy_sync_docs"), "setup prompt should include docs sync gate");
assert(setupPrompt.includes("hy_amend_plan"), "setup prompt should include amend plan guidance");
assert(setupPrompt.includes("理想项目状态"), "setup prompt should describe the ideal project state");

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
  assert(Boolean(missingResult.hint), "missing setup envelope should include hint");
  assert(missingResult.requires_user === true, "missing setup envelope should require user");
  assert(missingResult.stop_here === true, "missing setup envelope should stop here");
  assert(missingResult.allowedTools?.includes("hy_status"), "missing setup envelope should allow hy_status");
  assert(missingResult.blockedTools?.includes("hy_plan"), "missing setup envelope should block hy_plan");
  assert(missingResult.recovery?.instruction?.includes("curl -fsSL"), "missing setup envelope should include recovery command");
  assert(JSON.stringify(before) === JSON.stringify(listFiles(missingRoot)), "setup check must not write files");

  const gate = createSetupGate(missingRoot);
  assert(gate()?.error?.subtype === "setup_update_required", "gate should stop on first missing setup check");
  assert(gate() === null, "gate should only run once per session");

  const outdatedRoot = tempRepo();
  writeStamp(outdatedRoot, "0.0.0");
  const outdated = checkSetupStamp(outdatedRoot);
  assert(outdated.status === "outdated", `expected outdated, got ${outdated.status}`);
  assert(outdated.currentVersion === "0.0.0", "outdated check should expose current version");

  const currentRoot = tempRepo();
  writeStamp(currentRoot, SETUP_VERSION);
  const current = checkSetupStamp(currentRoot);
  assert(current.status === "current", `expected current, got ${current.status}`);
  assert(createSetupGate(currentRoot)() === null, "current setup should not stop tool dispatch");
} finally {
  process.chdir(originalCwd);
}
