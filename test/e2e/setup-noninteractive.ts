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
  const server = path.resolve("dist/server.js");
  const cli = path.join(bin, "hy-workflow");
  fs.writeFileSync(cli, [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HY_WORKFLOW_CONFIG_HOME: path.join(runtime, "config"),
    HY_WORKFLOW_STATE_HOME: path.join(runtime, "state"),
    HY_WORKFLOW_CACHE_HOME: path.join(runtime, "cache"),
  };
  const before = gitStatus(root);
  const result = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--dry-run", "--json"], {
    cwd: root,
    env,
    encoding: "utf-8",
  });
  assert(result.status === 0, `non-interactive dry-run should succeed: ${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert(payload.ok && payload.dryRun && payload.mode === "shared", "non-interactive JSON should expose the single shared mode");
  assert(payload.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "non-interactive dry-run should report both planned team artifacts");
  assert(gitStatus(root) === before, "non-interactive dry-run must not touch the project");

  const removedLocal = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--local", "--json"], { cwd: root, env, encoding: "utf-8" });
  const removedError = JSON.parse(removedLocal.stdout).error;
  assert(removedLocal.status === 1 && removedError.code === "CLI_USAGE" && removedError.message.includes("--local has been removed"), "removed local mode should fail with a typed migration message");

  const inverted = spawnSync(process.execPath, [server, "unset", "--yes", "--clients", "codex", "--action", "setup", "--json"], { cwd: root, env, encoding: "utf-8" });
  const invertedError = JSON.parse(inverted.stdout).error;
  assert(inverted.status === 1 && invertedError.code === "CLI_USAGE" && invertedError.message.includes("--action is not supported"), "a hidden flag must never invert setup/unset subcommand semantics");

  const bareCi = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--accept-ci-commands", "--json"], { cwd: root, env, encoding: "utf-8" });
  const bareCiError = JSON.parse(bareCi.stdout).error;
  assert(bareCi.status === 1 && bareCiError.code === "SETUP_PREFLIGHT_FAILED" && /exact reviewed commands/i.test(bareCiError.message), "bare non-interactive CI acceptance must fail closed");

  const bareArtifacts = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--accept-artifact-changes", "--ci-command", "npm test", "--json"], { cwd: root, env, encoding: "utf-8" });
  const bareArtifactError = JSON.parse(bareArtifacts.stdout).error;
  assert(bareArtifacts.status === 1 && bareArtifactError.code === "SETUP_ARTIFACT_DRIFT" && /exact reviewed before\/after hashes/i.test(bareArtifactError.message), "bare non-interactive artifact acceptance must fail closed");
  assert(gitStatus(root) === before, "rejected bare approvals must not touch the project");

  const missing = spawnSync(process.execPath, [server, "setup", "--clients", "codex", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(missing.status === 1, "non-TTY setup without --yes should fail");
  const missingError = JSON.parse(missing.stdout).error;
  assert(missingError.code === "CLI_USAGE" && missingError.message.includes("--yes"), "non-interactive error should explain required flags");
}
