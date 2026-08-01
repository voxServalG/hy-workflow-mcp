import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env },
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  assert(!result.error, `node ${args.join(" ")} failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(result.status !== null, `node ${args.join(" ")} terminated without an exit code`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const main = resolve(root, pkg.main ?? "");
assert(pkg.name === "@voxstudio/hy-workflow", "package name must remain @voxstudio/hy-workflow");
assert(pkg.main === "dist/main.js", "package main must be the thin CLI entrypoint");
assert(pkg.bin?.["hy-workflow"] === "dist/main.js", "npm bin must resolve to the thin CLI entrypoint");
assert(existsSync(main), "dist/main.js is missing; contract tests must run after build");
assert(readFileSync(main, "utf8").startsWith("#!/usr/bin/env node\n"), "compiled CLI must preserve its portable Node shebang");

const outsideGit = mkdtempSync(join(tmpdir(), "hy-bin-help-"));
try {
  const version = run([main, "--version"], outsideGit);
  assert(version.status === 0 && version.stderr === "", `--version failed: ${version.stderr}`);
  assert(version.stdout.trim() === pkg.version, "installed CLI version must equal package.json version");

  const help = run([main, "--help"], outsideGit);
  assert(help.status === 0 && help.stderr === "", `--help failed: ${help.stderr}`);
  for (const line of [
    "hy-workflow helper install|update|status|remove [--json]",
    "hy-workflow inspect --json",
    "hy-workflow verify --input-file <evidence.json> --json",
    "hy-workflow verify --input '<JSON object>' --json",
    "hy-workflow --version",
  ]) {
    assert(help.stdout.includes(line), `CLI help is missing the thin public command: ${line}`);
  }
  for (const retired of ["hy-workflow setup", "hy-workflow lint", "hy-workflow plan", "hy-workflow commit", "Start MCP", "dist/server.js"]) {
    assert(!help.stdout.includes(retired), `CLI help exposes retired surface: ${retired}`);
  }

  const unavailable = run([main, "inspect", "--json"], outsideGit);
  const unavailableEnvelope = JSON.parse(unavailable.stdout);
  assert(unavailable.status === 0, "inspect outside Git must report unavailable without treating it as malformed input");
  assert(unavailableEnvelope.schema === "hy-workflow.inspect.v1" && unavailableEnvelope.status === "unavailable", "inspect outside Git returned the wrong envelope");

  const unknown = run([main, "retired-command"], outsideGit);
  const unknownEnvelope = JSON.parse(unknown.stdout);
  assert(unknown.status === 1, "unknown commands must fail with exit code 1");
  assert(unknownEnvelope.schema === "hy-workflow.error.v1" && unknownEnvelope.status === "invalid", "unknown command must return the thin structured error envelope");
  assert(unknownEnvelope.issues?.[0]?.code === "COMMAND_UNKNOWN", "unknown command must have a stable machine code");
} finally {
  rmSync(outsideGit, { recursive: true, force: true });
}

process.stdout.write("bin-help: thin bin, help, version, unavailable, and error envelopes pass\n");
