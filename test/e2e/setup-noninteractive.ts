import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitStatus, makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

if (process.platform !== "win32") {
  const root = makeGitProject("hy-setup-noninteractive-");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-noninteractive-runtime-"));
  const bin = path.join(runtime, "bin");
  fs.mkdirSync(bin);
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo codex-test; exit 0; fi",
    "if [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"get\" ]; then exit 1; fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HY_WORKFLOW_CONFIG_HOME: path.join(runtime, "config"),
    HY_WORKFLOW_STATE_HOME: path.join(runtime, "state"),
    HY_WORKFLOW_CACHE_HOME: path.join(runtime, "cache"),
  };
  const server = path.resolve("dist/server.js");
  const before = gitStatus(root);
  const result = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--dry-run", "--json"], {
    cwd: root,
    env,
    encoding: "utf-8",
  });
  assert(result.status === 0, `non-interactive dry-run should succeed: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert(payload.ok && payload.dryRun && payload.mode === "shared", "non-interactive JSON should expose the single shared mode");
  assert(payload.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "non-interactive dry-run should report both planned team artifacts");
  assert(gitStatus(root) === before, "non-interactive dry-run must not touch the project");

  const removedLocal = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--local", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(removedLocal.status === 1 && JSON.parse(removedLocal.stdout).error.includes("--local has been removed"), "removed local mode should fail with a direct migration message");

  const missing = spawnSync(process.execPath, [server, "setup", "--clients", "codex", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(missing.status === 1, "non-TTY setup without --yes should fail");
  assert(JSON.parse(missing.stdout).error.includes("--yes"), "non-interactive error should explain required flags");
}
