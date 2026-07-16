import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { runCheckCommand } from "../../src/checks.js";
import { runCheckCommandAsync, runAllChecksAsync } from "../../src/checks-async.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  spawnSync(cmd, { cwd: root, shell: true, stdio: "ignore" });
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-verify-async-"));

try {
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" }, codelint: { lintDirs: ["src"] } }, null, 2) + "\n");
  run("git add .", root);
  run("git commit -m init", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);
  run("git checkout -b fix/verify-async", root);
  chdir(root);

  const syncRes = runCheckCommand("node -e \"console.log('hello')\"", root);
  const asyncRes = await runCheckCommandAsync("node -e \"console.log('hello')\"", root);
  assert(syncRes.ok === true, `sync should pass: ${JSON.stringify(syncRes)}`);
  assert(asyncRes.ok === true, `async should pass: ${JSON.stringify(asyncRes)}`);
  assert(syncRes.status === asyncRes.status, `exit codes should match: sync=${syncRes.status} async=${asyncRes.status}`);
  assert(syncRes.stdout.trim() === asyncRes.stdout.trim(), `stdout should match: sync=${syncRes.stdout} async=${asyncRes.stdout}`);
  assert(asyncRes.durationMs >= 0, "durationMs should be non-negative");

  const syncFail = runCheckCommand("node -e \"process.exit(3)\"", root);
  const asyncFail = await runCheckCommandAsync("node -e \"process.exit(3)\"", root);
  assert(!syncFail.ok && !asyncFail.ok, "both paths should report failure for non-zero exit");
  assert(syncFail.status === asyncFail.status, "status should match on failure");

  const timed = await runCheckCommandAsync("node -e \"setTimeout(() => {}, 10000)\"", root, 200);
  assert(timed.timedOut === true, `short timeout should mark timedOut: ${JSON.stringify(timed)}`);
  assert(timed.ok === false, "timed out command should fail");

  let ticksDuring: number = 0;
  const tickInterval = setInterval(() => { ticksDuring += 1; }, 50);
  const plan: PlanDoc = {
    task: "verify event loop regression",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: { dependency_dag: "single file", entry_points: ["node --version"], no_new_external: true },
    verify: {
      platform: { python_version: "N/A", setup: [] },
      smoke: [{ command: "node -e \"setTimeout(() => console.log('tick'), 500)\"", expected_exit: 0, description: "yields event loop" }],
      tests: [{ command: "node --version", expected_exit: 0, description: "node version" }],
    },
    risks: ["event loop blocked during verify — mitigated by async supervisor"],
    discussion: "Async supervisor lets setInterval fire during the check, proving the event loop is not blocked.",
    branch: null, verify_hash: null, pr_number: null,
  };
  writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n");
  const wfState: WorkflowState = {
    version: "1", phase: "edit", branch: "fix/verify-async", prNumber: null, plan,
    approval: { time: new Date().toISOString(), note: "test" }, verifyHash: null,
  };
  const report = await runAllChecksAsync(root, wfState);
  clearInterval(tickInterval);
  assert(ticksDuring > 0, `event loop should pump during async verify; ticksDuring=${ticksDuring}`);
  assert(report.total > 0, "report should contain checks");
} finally {
  chdir(originalCwd);
}
