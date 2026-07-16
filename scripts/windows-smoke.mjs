import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runCheckCommand } from "../dist/checks.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !existsSync(npmExecPath)) {
  throw new Error("Windows smoke must be run via npm run test:windows so npm_execpath resolves npm-cli.js");
}
const npmCommand = process.execPath;
const npmCommandPrefix = [npmExecPath];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(label, command, args, options = {}) {
  const result = runCheckCommand(
    { file: command, args },
    options.cwd ?? sourceRoot,
    options.timeout ?? 180_000,
    options.env ?? process.env,
  );
  if (!result.ok) {
    throw new Error(`${label} failed (${result.timedOut ? `timeout after ${result.timeoutMs}ms` : result.status === null ? "unknown exit" : `exit ${result.status}`}):\n${(result.stderr || result.stdout || "").slice(-8_000)}`);
  }
  return result.stdout.trim();
}

function runJson(label, command, args, options = {}) {
  const output = run(label, command, args, options);
  try { return JSON.parse(output); }
  catch { throw new Error(`${label} returned invalid JSON:\n${output.slice(-8_000)}`); }
}

const npmVersion = run("npm CLI", npmCommand, [...npmCommandPrefix, "--version"], { timeout: 30_000 });
assert(/^\d+\.\d+\.\d+/.test(npmVersion), `npm CLI returned an invalid version: ${npmVersion}`);

for (const test of [
  "test/unit/compile-lint-checks.ts",
  "test/unit/project-profile.ts",
  "test/unit/doclint-output.ts",
  "test/unit/setup-clients.ts",
  "test/e2e/setup-project-artifacts.ts",
  "test/contract/npm-release-provenance.ts",
]) {
  run(`focused test ${test}`, process.execPath, [tsxCli, test], { timeout: 180_000 });
}

const workspace = mkdtempSync(join(tmpdir(), "hy-workflow-windows-smoke-"));
try {
  const packDir = join(workspace, "pack");
  const prefix = join(workspace, "npm-prefix");
  const home = join(workspace, "home");
  const stubBin = join(workspace, "stub-bin");
  const project = join(workspace, "project");
  const prefixBin = process.platform === "win32" ? prefix : join(prefix, "bin");
  for (const directory of [packDir, prefix, home, stubBin, project]) mkdirSync(directory, { recursive: true });

  const npmUserConfig = join(home, ".npmrc");
  writeFileSync(npmUserConfig, "", "utf8");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
    HY_WORKFLOW_CONFIG_HOME: join(home, "hy-workflow-config"),
    HY_WORKFLOW_STATE_HOME: join(home, "hy-workflow-state"),
    HY_WORKFLOW_CACHE_HOME: join(home, "hy-workflow-cache"),
    HY_ACCEPTANCE_CLIENT_STATE: join(workspace, "client-state.json"),
    HY_ACCEPTANCE_CLIENT_EVENTS: join(workspace, "client-events.ndjson"),
    npm_config_prefix: prefix,
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_userconfig: npmUserConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    GIT_TERMINAL_PROMPT: "0",
    PATH: [stubBin, prefixBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    CI: "1",
  };
  for (const secret of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]) delete env[secret];

  const stubSource = join(sourceRoot, "test", "acceptance", "client-stub.mjs");
  const stubTarget = join(stubBin, "codex");
  copyFileSync(stubSource, stubTarget);
  if (process.platform === "win32") {
    writeFileSync(join(stubBin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${stubTarget}" %*\r\n`, "utf8");
  } else chmodSync(stubTarget, 0o755);

  const packReport = runJson("npm pack", npmCommand, [...npmCommandPrefix, "pack", "--json", "--pack-destination", packDir], { env, timeout: 300_000 });
  assert(Array.isArray(packReport) && packReport.length === 1 && typeof packReport[0]?.filename === "string", "npm pack must produce exactly one tarball");
  const archive = join(packDir, packReport[0].filename);
  assert(existsSync(archive), "npm pack report points to a missing tarball");
  run("global tarball install", npmCommand, [
    ...npmCommandPrefix, "install", "--global", archive, "@voxstudio/docs-gardener@1.0.0-next.0", "--no-audit", "--no-fund",
  ], { env, timeout: 300_000 });
  const globalRoot = run("npm global root", npmCommand, [...npmCommandPrefix, "root", "--global"], { env, timeout: 30_000 });
  const installedServer = join(globalRoot, "@voxstudio", "hy-workflow", "dist", "server.js");
  const installedBin = process.platform === "win32" ? join(prefix, "hy-workflow.cmd") : join(prefix, "bin", "hy-workflow");
  assert(existsSync(installedServer) && existsSync(installedBin), "global tarball install did not expose the compiled server and bin");
  const expectedVersion = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
  assert(run("installed version", process.execPath, [installedServer, "--version"], { env, timeout: 30_000 }) === expectedVersion, "installed CLI version drifted from package.json");

  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "src", "index.js"), "export const value = 1;\n", "utf8");
  writeFileSync(join(project, "docs", "index.md"), "# Windows smoke\n\nSetup and unset must work from the installed npm tarball.\n", "utf8");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "windows-smoke-fixture", private: true, type: "module" }, null, 2) + "\n", "utf8");
  const config = {
    project: { baseBranch: "main", codeExt: ".js", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
    ci: { commands: ["node --version"] },
  };
  const configText = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(join(project, "hy-workflow.json"), configText, "utf8");
  run("git init", "git", ["init", "-b", "main"], { cwd: project, env, timeout: 30_000 });
  run("git email", "git", ["config", "user.email", "windows-smoke@example.invalid"], { cwd: project, env, timeout: 30_000 });
  run("git name", "git", ["config", "user.name", "Windows Smoke"], { cwd: project, env, timeout: 30_000 });
  run("git add", "git", ["add", "."], { cwd: project, env, timeout: 30_000 });
  run("git commit", "git", ["commit", "-m", "fixture"], { cwd: project, env, timeout: 30_000 });

  const setupArgs = [installedServer, "setup", "--yes", "--clients", "codex", "--json", "--language", "en"];
  let setup;
  try {
    setup = runJson("installed setup", process.execPath, setupArgs, { cwd: project, env, timeout: 120_000 });
  } catch (error) {
    const codexFixture = join(env.CODEX_HOME, "config.toml");
    const fixture = existsSync(codexFixture) ? readFileSync(codexFixture, "utf8") : "<absent>";
    const message = [
      error instanceof Error ? error.message : String(error),
      "Codex fixture after failure:",
      fixture,
    ].join("\n");
    throw new Error(message, { cause: error });
  }
  assert(setup.ok === true, "installed setup did not return ok=true");
  assert(readFileSync(join(project, "hy-workflow.json"), "utf8") === configText, "setup rewrote the explicit shared config");
  assert(existsSync(join(project, ".github", "workflows", "hy-workflow.yml")), "setup did not create the shared workflow");
  const repeated = runJson("repeated installed setup", process.execPath, setupArgs, { cwd: project, env, timeout: 120_000 });
  assert(repeated.ok === true && repeated.projectFilesChanged?.length === 0, "repeated setup was not idempotent");
  const unset = runJson("installed unset", process.execPath, [
    installedServer, "unset", "--yes", "--clients", "codex", "--remove-global", "--json", "--language", "en",
  ], { cwd: project, env, timeout: 120_000 });
  assert(unset.ok === true, "installed unset did not return ok=true");
  assert(existsSync(join(project, "hy-workflow.json")) && existsSync(join(project, ".github", "workflows", "hy-workflow.yml")), "unset removed shared project artifacts");
  for (const forbidden of [".hy", ".codex", ".opencode", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) {
    assert(!existsSync(join(project, forbidden)), "setup/unset left project-local runtime artifact " + forbidden);
  }
  const clientState = existsSync(env.HY_ACCEPTANCE_CLIENT_STATE) ? JSON.parse(readFileSync(env.HY_ACCEPTANCE_CLIENT_STATE, "utf8")) : {};
  assert(Object.keys(clientState.codex ?? {}).length === 0, "unset left global Codex MCP definitions");
  assert(readdirSync(packDir).filter(name => name.endsWith(".tgz")).length === 1, "Windows smoke must test one concrete tarball");
  process.stdout.write("windows-smoke: focused tests and installed tarball setup/repeat/unset pass\n");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
