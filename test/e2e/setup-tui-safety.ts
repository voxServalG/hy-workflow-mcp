import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSetupArgs, setupHelp } from "../../src/setup-cli.js";
import { gitStatus, makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const unattended = parseSetupArgs(["--yes", "--clients", "codex"], "setup");
assert(!unattended.options.syncProjectArtifacts && !unattended.options.acceptArtifactChanges && !unattended.options.acceptCiCommands, "--yes must never imply project sync or acceptance of artifact/CI changes");
const explicitSync = parseSetupArgs(["--sync-project-artifacts", "--accept-artifact-changes"], "setup");
assert(explicitSync.errors.length === 0 && explicitSync.options.syncProjectArtifacts && explicitSync.options.acceptArtifactChanges, "project artifact sync intent must be parsed independently from acceptance");
const exactReview = parseSetupArgs(["--review-artifact", `hy-workflow.json:${"a".repeat(64)}:${"b".repeat(64)}`], "setup");
assert(exactReview.errors.length === 0 && exactReview.options.reviewedArtifactChanges?.[0]?.beforeHash === "a".repeat(64), "artifact review token must preserve exact before/after hashes");
assert(parseSetupArgs(["--review-artifact", "hy-workflow.json:latest:any"], "setup").errors.length === 1, "artifact review token must reject symbolic or malformed hashes");
assert(!setupHelp().includes("deployment mode") && !setupHelp().includes("--local") && !setupHelp().includes("--shared"), "setup must expose one shared artifact contract, not a deployment-mode choice");
assert(setupHelp().includes("--sync-project-artifacts"), "setup help must expose artifact sync as an independent operation intent");

if (process.platform !== "win32" && fs.existsSync("/usr/bin/script")) {
  const root = makeGitProject("hy-tui-safety-");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-tui-safety-runtime-"));
  const before = gitStatus(root);
  const started = Date.now();
  const setupCommand = "stty cols 120 rows 40 && exec " + JSON.stringify(process.execPath) + " " + JSON.stringify(path.resolve("dist/server.js")) + " setup";
  const child = spawn("/usr/bin/script", ["-qfec", setupCommand, "/dev/null"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      HY_WORKFLOW_CONFIG_HOME: path.join(runtime, "config"),
      HY_WORKFLOW_STATE_HOME: path.join(runtime, "state"),
      HY_WORKFLOW_CACHE_HOME: path.join(runtime, "cache"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let firstOutput = Number.POSITIVE_INFINITY;
  let cancelled = false;
  child.stdout.on("data", chunk => {
    if (!output) {
      firstOutput = Date.now() - started;
      cancelled = true;
      child.stdin.write("\u0003");
    }
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const status = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("TUI cancellation timed out")); }, 8_000);
    child.on("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert(cancelled && firstOutput < 1_000 && /hy-workflow/.test(output), `TUI intro must render before detection; first output ${firstOutput}ms`);
  assert((status === 0 || status === 130) && gitStatus(root) === before, `TUI Ctrl+C cancellation must leave the project unchanged (status ${status})`);
  assert(!fs.existsSync(path.join(runtime, "config")) && !fs.existsSync(path.join(runtime, "state")) && !fs.existsSync(path.join(runtime, "cache")), "TUI cancellation before confirmation must not create runtime state");

  const missingClientRoot = makeGitProject("hy-tui-no-client-");
  const missingClientRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-tui-no-client-runtime-"));
  const missingClientBefore = gitStatus(missingClientRoot);
  const missingClientChild = spawn("/usr/bin/script", ["-qfec", setupCommand, "/dev/null"], {
    cwd: missingClientRoot,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      HY_WORKFLOW_CONFIG_HOME: path.join(missingClientRuntime, "config"),
      HY_WORKFLOW_STATE_HOME: path.join(missingClientRuntime, "state"),
      HY_WORKFLOW_CACHE_HOME: path.join(missingClientRuntime, "cache"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let missingClientOutput = "";
  let choseLanguage = false;
  let choseAction = false;
  const drivePrompt = (chunk: Buffer): void => {
    missingClientOutput += chunk.toString();
    const promptText = missingClientOutput
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/[\s│◆◇●┌└┐┘↑↓•.]/g, "");
    if (!choseLanguage && /Chooselanguage|选择语言/.test(promptText)) {
      choseLanguage = true;
      missingClientChild.stdin.write("\r");
    } else if (choseLanguage && !choseAction && /要执行什么|Whatwouldyouliketodo/.test(promptText)) {
      choseAction = true;
      missingClientChild.stdin.write("\r");
    }
  };
  missingClientChild.stdout.on("data", drivePrompt);
  missingClientChild.stderr.on("data", drivePrompt);
  const missingClientStatus = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { missingClientChild.kill("SIGKILL"); reject(new Error("missing-client TUI test timed out: " + missingClientOutput)); }, 10_000);
    missingClientChild.on("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert(choseLanguage && choseAction, "missing-client TUI test did not reach the install action");
  assert(missingClientStatus !== 0 && /未检测到|were not detected|not installed/i.test(missingClientOutput), `missing-client TUI must exit nonzero with a reason (status ${missingClientStatus}): ${missingClientOutput}`);
  assert(gitStatus(missingClientRoot) === missingClientBefore, "missing-client TUI failure must not change project files");
  assert(!fs.existsSync(path.join(missingClientRuntime, "config")) && !fs.existsSync(path.join(missingClientRuntime, "state")), "missing-client TUI failure must not create external deployment state");
}

console.log("setup-tui-safety: immediate intro, cancellation no-write, explicit acceptance, and no-mode contracts pass");
