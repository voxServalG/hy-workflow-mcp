import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitStatus, makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertTypedContract(payload: any, action: "setup" | "unset", ok: boolean): void {
  const stage = action === "setup" ? "setup.apply" : "setup.unset";
  assert(payload.ok === ok && payload.phase === "setup" && payload.action === action, `${action} JSON must expose typed phase/action`);
  assert(payload.stage === stage && payload.status === (ok ? "completed" : "failed"), `${action} JSON must expose canonical stage/status`);
  assert(payload.nextAction?.phase === "setup" && payload.nextAction?.stage === stage && typeof payload.nextAction?.automatic === "boolean", `${action} JSON must expose typed nextAction`);
  assert(typeof payload.control?.automatic === "boolean" && typeof payload.control?.stop === "boolean" && typeof payload.control?.reason === "string", `${action} JSON must expose typed control`);
  assert(Object.prototype.hasOwnProperty.call(payload, "userAction"), `${action} JSON must expose userAction, including null`);
  if (!ok) {
    assert(typeof payload.error?.type === "string" && typeof payload.error?.subtype === "string" && typeof payload.error?.message === "string", `${action} failure must expose a structured error`);
    assert(payload.recovery && !Array.isArray(payload.recovery) && typeof payload.recovery.strategy === "string", `${action} failure recovery must be a discriminated object`);
  }
}

if (process.platform !== "win32") {
  const root = makeGitProject("hy-setup-noninteractive-");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-setup-noninteractive-runtime-"));
  const home = path.join(runtime, "home");
  const inheritedCodexConfig = path.join(home, ".codex", "config.toml");
  const isolatedCodexHome = path.join(runtime, "codex-home");
  const poisonConfig = "[mcp_servers.hy-workflow\n";
  fs.mkdirSync(path.dirname(inheritedCodexConfig), { recursive: true });
  fs.writeFileSync(inheritedCodexConfig, poisonConfig);
  const bin = path.join(runtime, "bin");
  fs.mkdirSync(bin);
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo codex-test; exit 0; fi",
    "if [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"get\" ]; then echo \"MCP server not found\" >&2; exit 1; fi",
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
  const fakeMcpServer = path.resolve("test/helpers/fake-mcp-server.mjs");
  const docsGardener = path.join(bin, "docs-gardener");
  const docsGardenerTools = JSON.stringify([
    "garden-fix",
    "garden-grow",
    "garden-polish",
    "garden-scan",
    "garden-scan-hard",
    "garden-scan-soft",
  ]);
  fs.writeFileSync(docsGardener, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo docs-gardener-test; exit 0; fi',
    'if [ "$1" != "mcp" ]; then echo "expected docs-gardener mcp" >&2; exit 64; fi',
    "FAKE_MCP_TOOLS=" + JSON.stringify(docsGardenerTools) + " exec " + JSON.stringify(process.execPath) + " " + JSON.stringify(fakeMcpServer),
    "",
  ].join("\n"), { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(runtime, "xdg-config"),
    XDG_STATE_HOME: path.join(runtime, "xdg-state"),
    XDG_CACHE_HOME: path.join(runtime, "xdg-cache"),
    CODEX_HOME: isolatedCodexHome,
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
  assertTypedContract(payload, "setup", true);
  assert(payload.ok && payload.dryRun && payload.mode === "shared", "non-interactive JSON should expose the single shared mode");
  assert(payload.tools?.["docs-gardener"]?.version === "docs-gardener-test", "non-interactive setup must inspect the isolated docs-gardener version");
  assert(fs.realpathSync(payload.tools["docs-gardener"].executable) === fs.realpathSync(docsGardener), "non-interactive setup must not depend on a developer-machine docs-gardener binary");
  assert(/^[0-9a-f]{64}$/.test(payload.tools["docs-gardener"].catalogHash), "non-interactive setup must complete the docs-gardener MCP catalog handshake");
  assert(payload.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "non-interactive dry-run should report only the config and thin workflow");
  assert(gitStatus(root) === before, "non-interactive dry-run must not touch the project");
  assert(fs.readFileSync(inheritedCodexConfig, "utf8") === poisonConfig, "non-interactive dry-run must not read or rewrite inherited Codex config");
  assert(!fs.existsSync(path.join(isolatedCodexHome, "config.toml")), "non-interactive dry-run must not create isolated Codex config");

  const removedLocal = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--local", "--json"], { cwd: root, env, encoding: "utf-8" });
  const removedPayload = JSON.parse(removedLocal.stdout);
  assertTypedContract(removedPayload, "setup", false);
  assert(removedPayload.nextAction.tool === "hy-workflow"
    && JSON.stringify(removedPayload.nextAction.arguments?.argv) === JSON.stringify(["setup", "--yes", "--clients", "codex", "--local", "--json"]),
  `setup failure must preserve exact typed retry argv: ${JSON.stringify(removedPayload.nextAction)}`);
  assert(JSON.stringify(removedPayload.recovery?.arguments?.argv) === JSON.stringify(removedPayload.nextAction.arguments.argv)
    && typeof removedPayload.recovery?.command === "string",
  `setup recovery must mirror the exact attempted invocation: ${JSON.stringify(removedPayload.recovery)}`);
  const removedError = removedPayload.error;
  assert(removedLocal.status === 1 && removedError.code === "CLI_USAGE" && removedError.message.includes("--local has been removed"), "removed local mode should fail with a typed migration message");

  const sharedCompat = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--shared", "--dry-run", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(sharedCompat.status === 0 && JSON.parse(sharedCompat.stdout).mode === "shared", `deprecated --shared must remain an inert compatibility input for canonical setup: ${sharedCompat.stderr || sharedCompat.stdout}`);

  const migrationCompat = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--migrate-legacy-clients", "--dry-run", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(migrationCompat.status === 0 && fs.readFileSync(inheritedCodexConfig, "utf8") === poisonConfig, `deprecated client migration input must be a no-op and leave old files unread and untouched: ${migrationCompat.stderr || migrationCompat.stdout}`);

  const inverted = spawnSync(process.execPath, [server, "unset", "--yes", "--clients", "codex", "--action", "setup", "--json"], { cwd: root, env, encoding: "utf-8" });
  const invertedPayload = JSON.parse(inverted.stdout);
  assertTypedContract(invertedPayload, "unset", false);
  assert(invertedPayload.nextAction.tool === "hy-workflow"
    && JSON.stringify(invertedPayload.nextAction.arguments?.argv) === JSON.stringify(["unset", "--yes", "--clients", "codex", "--action", "setup", "--json"]),
  `unset failure must preserve exact typed retry argv: ${JSON.stringify(invertedPayload.nextAction)}`);
  const invertedError = invertedPayload.error;
  assert(inverted.status === 1 && invertedError.code === "CLI_USAGE" && invertedError.message.includes("--action is not supported"), "a hidden flag must never invert setup/unset subcommand semantics");

  const bareCi = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--accept-ci-commands", "--json"], { cwd: root, env, encoding: "utf-8" });
  const bareCiError = JSON.parse(bareCi.stdout).error;
  assert(bareCi.status === 1 && bareCiError.code === "SETUP_PREFLIGHT_FAILED" && /exact reviewed commands/i.test(bareCiError.message), "bare non-interactive CI acceptance must fail closed");

  const bareArtifacts = spawnSync(process.execPath, [server, "setup", "--yes", "--clients", "codex", "--accept-artifact-changes", "--ci-command", "npm test", "--dry-run", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(bareArtifacts.status === 0 && JSON.parse(bareArtifacts.stdout).ok, "artifact acceptance must not demand hash replies when no existing file would be overwritten");
  assert(gitStatus(root) === before, "dry-run compatibility and approval checks must not touch the project");

  const missing = spawnSync(process.execPath, [server, "setup", "--clients", "codex", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(missing.status === 1, "non-TTY setup without --yes should fail");
  const missingError = JSON.parse(missing.stdout).error;
  assert(missingError.code === "CLI_USAGE" && missingError.message.includes("--yes"), "non-interactive error should explain required flags");

  const unset = spawnSync(process.execPath, [server, "unset", "--yes", "--clients", "codex", "--json"], { cwd: root, env, encoding: "utf-8" });
  assert(unset.status === 0, `no-deployment unset should succeed: ${unset.stderr || unset.stdout}`);
  assertTypedContract(JSON.parse(unset.stdout), "unset", true);
}
