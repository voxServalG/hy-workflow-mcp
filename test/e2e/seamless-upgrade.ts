import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { checkSetupStamp } from "../../src/bootstrap.js";
import { checkConfig, projectRuntimeConfigSource, resolveRuntimeConfig, runConfigCli, RUNTIME_CONFIG_SOURCE_ENV } from "../../src/config.js";
import { readDeployment, writeDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { executeSetup } from "../../src/setup/operations.js";
import { runSetupPreflight } from "../../src/setup/preflight.js";
import type { SetupOptions } from "../../src/setup/types.js";
import { makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hy-seamless-upgrade-"));
const root = path.join(sandbox, "project");
const external = path.join(sandbox, "external");
fs.mkdirSync(root, { recursive: true });
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(external, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(external, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(external, "cache");
delete process.env[RUNTIME_CONFIG_SOURCE_ENV];

git(root, ["init", "-b", "main"]);
git(root, ["config", "user.email", "test@example.com"]);
git(root, ["config", "user.name", "hy test"]);
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "main.ts"), "export const value = 1;\n");
fs.writeFileSync(path.join(root, "docs", "README.md"), "# Documentation\n");

const legacyFiles = new Map<string, string>([
  ["hy-workflow.json", "{ this legacy injection is intentionally invalid json\n"],
  [".github/workflows/hy-workflow.yml", "name: legacy injected workflow\non: [push]\n"],
  ["AGENTS.md", "<!-- hy-workflow-rules -->\nlegacy injected rules\n<!-- /hy-workflow-rules -->\n"],
  ["codelint.json", "{\"legacy\":true}\n"],
  ["doclint.json", "{\"legacy\":true}\n"],
  ["docs-gardener.json", "{ this legacy docs config is intentionally invalid json\n"],
  [".hy/workflow.json", "{ this legacy workflow state is intentionally invalid json\n"],
  [".hy/scope.json", "{ this legacy scope state is intentionally invalid json\n"],
  [".opencode/opencode.json", "{ this legacy project client config is intentionally invalid json\n"],
  [".codex/config.toml", "this is not valid legacy project client toml = [\n"],
  [".mcp.json", "{ this legacy project MCP config is intentionally invalid json\n"],
]);
for (const [relative, content] of legacyFiles) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
git(root, ["add", "."]);
git(root, ["commit", "-m", "legacy project"]);

const orphanRoot = path.join(sandbox, "orphan-project");
fs.mkdirSync(orphanRoot, { recursive: true });
git(orphanRoot, ["init", "-b", "main"]);
git(orphanRoot, ["config", "user.email", "test@example.com"]);
git(orphanRoot, ["config", "user.name", "hy test"]);
for (const directory of ["src", "docs", ".github/workflows"]) fs.mkdirSync(path.join(orphanRoot, directory), { recursive: true });
fs.writeFileSync(path.join(orphanRoot, "src", "main.ts"), "export const orphan = true;\n");
fs.writeFileSync(path.join(orphanRoot, "docs", "README.md"), "# Orphan fixture\n");
const orphanArtifacts = new Map<string, string>([
  ["hy-workflow.json", "{ invalid orphan config must never be opened\n"],
  [".github/workflows/hy-workflow.yml", "name: unreadable orphan workflow\non: [push]\n"],
]);
for (const [relative, content] of orphanArtifacts) fs.writeFileSync(path.join(orphanRoot, relative), content);
git(orphanRoot, ["add", "."]);
git(orphanRoot, ["commit", "-m", "orphan legacy injections"]);
const orphanBeforeStatus = git(orphanRoot, ["status", "--porcelain"]);
const orphanUnreadable = [...orphanArtifacts.keys()].map(relative => path.join(orphanRoot, relative));
if (process.platform !== "win32") for (const file of orphanUnreadable) fs.chmodSync(file, 0o000);
try {
  const orphanResolution = resolveRuntimeConfig(orphanRoot);
  assert(orphanResolution.authority.kind === "legacy-detected" && orphanResolution.issues.length === 0, "orphan root config must not become runtime authority");
  const orphanCheck = checkConfig(orphanRoot);
  assert(orphanCheck.ok && orphanCheck.source?.includes("read-only project detection"), "public config check must use detected authority without opening orphan root config");
  const cliCheck = runConfigCli(["--check", "--json"], orphanRoot);
  assert(cliCheck.exitCode === 0, `public config CLI check must ignore unreadable orphan config: ${cliCheck.stdout}`);
  const cliApply = runConfigCli(["--apply", "--json", "--base-branch", "main"], orphanRoot);
  assert(cliApply.exitCode === 0, `public config apply must write external state without opening orphan config: ${cliApply.stdout}`);
  const orphanExternal = JSON.parse(fs.readFileSync(projectPaths(orphanRoot).config, "utf-8"));
  assert(orphanExternal.project?.baseBranch === "main" && orphanExternal.schema !== "hy-workflow.runtime-config-source.v1", "orphan config apply must persist a full external config rather than a project-source marker");

  const orphanOptions: SetupOptions = {
    action: "setup",
    mode: "shared",
    clients: [],
    language: "en",
    yes: true,
    dryRun: false,
    json: true,
    removeGlobal: false,
  };
  const orphanPreview = await executeSetup(orphanRoot, { ...orphanOptions, dryRun: true }, []);
  assert(orphanPreview.artifactChanges?.length === 0 && orphanPreview.projectFilesChanged.length === 0, "orphan setup preview must not manufacture hashes or diffs");
  const orphanSetup = await executeSetup(orphanRoot, orphanOptions, []);
  const orphanDeployment = readDeployment(orphanRoot);
  assert(orphanSetup.ok && orphanSetup.projectFilesChanged.length === 0, "ordinary orphan setup must succeed without a project artifact gate");
  assert(orphanSetup.projectFileDisposition === "external-only" && orphanSetup.configAuthority === "external", "orphan setup result must explain its external-only authority instead of hiding the branch");
  assert(orphanSetup.message.includes("ready using complete external config"), "external-only success must tell the user the project is ready");
  assert(orphanDeployment?.schemaVersion === "3" && !orphanDeployment.projectContract && orphanDeployment.projectFiles.length === 0, "orphan setup must record an external-only inert deployment");
  assert(Object.keys(orphanDeployment?.artifacts ?? {}).length === 0, "orphan deployment must not record hashes for ignored project artifacts");
} finally {
  if (process.platform !== "win32") for (const file of orphanUnreadable) fs.chmodSync(file, 0o644);
}
for (const [relative, content] of orphanArtifacts) {
  assert(fs.readFileSync(path.join(orphanRoot, relative), "utf-8") === content, `orphan setup touched ${relative}`);
}
assert(git(orphanRoot, ["status", "--porcelain"]) === orphanBeforeStatus, "orphan config/setup paths must not dirty the worktree");

writeDeployment(root, {
  setupVersion: "2026.01.01.0",
  mode: "shared",
  clients: [],
  projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"],
  tools: {},
  artifacts: {
    "hy-workflow.json": { sha256: "0".repeat(64), size: 1 },
    ".github/workflows/hy-workflow.yml": { sha256: "1".repeat(64), size: 1 },
    "AGENTS.md": { sha256: "2".repeat(64), size: 1 },
  },
});

const paths = projectPaths(root);
fs.mkdirSync(path.dirname(paths.workflowState), { recursive: true });
const activeState = "{\"phase\":\"edit\",\"approval\":{\"decisionId\":\"legacy-approved\"}}\n";
fs.writeFileSync(paths.workflowState, activeState);

const beforeFiles = new Map([...legacyFiles.keys()].map(relative => [relative, fs.readFileSync(path.join(root, relative), "utf-8")]));
const beforeStatus = git(root, ["status", "--porcelain"]);
const unreadable = [...legacyFiles.keys()].map(relative => path.join(root, relative));
for (const file of unreadable) fs.chmodSync(file, 0o000);
try {
  const setup = checkSetupStamp(root);
  assert(setup.status === "current", `old deployment must remain current after upgrade: ${JSON.stringify(setup)}`);
  assert(setup.compatibility === "legacy-inert", "old deployment must be explicitly classified as legacy-inert");

  const resolution = resolveRuntimeConfig(root);
  assert(resolution.authority.kind === "legacy-detected", `legacy root injection must not become config authority: ${JSON.stringify(resolution.authority)}`);
  assert(resolution.issues.length === 0, `detected legacy config must be valid: ${resolution.issues.join("; ")}`);
  assert(resolution.config.codelint.maxLinesWarning === 300 && resolution.config.codelint.maxLinesError === 500, "legacy code thresholds must remain frozen at 300/500");
  assert(resolution.config.doclint.maxLinesWarning === 200 && resolution.config.doclint.maxLinesError === 500, "legacy doc thresholds must remain frozen at 200/500");

  const options: SetupOptions = {
    action: "setup",
    mode: "shared",
    clients: [],
    language: "en",
    yes: true,
    dryRun: true,
    json: true,
    removeGlobal: false,
  };
  const preflight = await runSetupPreflight(root, options, [], resolution.config, false);
  assert(!preflight.managesProjectFiles, "legacy deployment must never enter the new project-file writer");
  assert(preflight.artifactChanges.length === 0, "legacy setup preflight must not inspect or diff injected files");
} finally {
  for (const file of unreadable) fs.chmodSync(file, 0o644);
}

for (const [relative, before] of beforeFiles) {
  assert(fs.readFileSync(path.join(root, relative), "utf-8") === before, `upgrade touched legacy injection ${relative}`);
}
assert(fs.readFileSync(paths.workflowState, "utf-8") === activeState, "upgrade checks must preserve active workflow state and approval");
assert(git(root, ["status", "--porcelain"]) === beforeStatus, "upgrade checks must not dirty the project worktree");

const legacyExternal = JSON.stringify({
  mode: "shared",
  project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"] },
}, null, 2) + "\n";
fs.mkdirSync(path.dirname(paths.config), { recursive: true });
fs.writeFileSync(paths.config, legacyExternal);
const legacyUnset: SetupOptions = { action: "unset", mode: "shared", clients: [], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false };
await executeSetup(root, legacyUnset, []);
assert(fs.readFileSync(paths.config, "utf-8") === legacyExternal, "unset must preserve a legacy/full external config instead of reclassifying it as a setup marker");

const freshRoot = makeGitProject("hy-seamless-fresh-");
const freshSetup: SetupOptions = {
  action: "setup",
  mode: "shared",
  clients: [],
  language: "en",
  yes: true,
  dryRun: false,
  json: true,
  removeGlobal: false,
  ciCommands: ["npm ci", "npm run build", "npm test"],
};
const freshResult = await executeSetup(freshRoot, freshSetup, []);
const freshPaths = projectPaths(freshRoot);
const freshDeployment = readDeployment(freshRoot);
assert(freshResult.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "fresh setup must create exactly the config and thin workflow");
assert(JSON.stringify(JSON.parse(fs.readFileSync(freshPaths.config, "utf-8"))) === JSON.stringify(projectRuntimeConfigSource()), "fresh setup must establish the exact external project-authority marker");
assert(freshDeployment?.schemaVersion === "3" && freshDeployment.projectContract === "minimal-v1", "fresh setup must record the minimal-v1 project contract");
assert(Object.keys(freshDeployment.artifacts).sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "fresh deployment must record strict evidence for exactly two artifacts");
const freshUnset: SetupOptions = { ...freshSetup, action: "unset", ciCommands: undefined };
await executeSetup(freshRoot, freshUnset, []);
assert(!fs.existsSync(freshPaths.config), "unset must remove the exact setup-owned minimal-v1 authority marker");
assert(fs.existsSync(path.join(freshRoot, "hy-workflow.json")) && fs.existsSync(path.join(freshRoot, ".github", "workflows", "hy-workflow.yml")), "unset must keep team-owned project artifacts");

console.log("seamless-upgrade: legacy injections stay inert; fresh markers are strict and reversibly external");
