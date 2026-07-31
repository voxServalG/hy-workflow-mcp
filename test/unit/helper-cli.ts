import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HELPER_CLI_SCHEMA,
  HelperCliInputError,
  helperCommandArgv,
  parseHelperCliArgs,
  runHelperCli,
} from "../../src/helper/cli.js";
import {
  helperOperationLockPath,
  withHelperOperationLock,
} from "../../src/helper/operation-lock.js";
import { projectRuntimeConfigSource } from "../../src/config.js";
import { registerHelperProject } from "../../src/helper/project.js";
import type { DetectedHelperSkillTarget, HelperSkillPaths } from "../../src/helper/skills.js";
import {
  readDeployment,
  writeDeployment,
  type ClientName,
} from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { MCP_DEFINITIONS, type ClientAdapter, type ClientServerSnapshot, type McpDefinition, type ServerName } from "../../src/setup/types.js";
import { gitStatus, makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertFactOnlyHelperValue(value: unknown, location = "helper"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFactOnlyHelperValue(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert(
      !["display", "summary", "hint", "prompt", "instruction", "byLayer"].includes(key),
      `${location} must not expose Agent presentation field ${key}`,
    );
    assert(
      key !== "recovery" || typeof child !== "string",
      `${location}.recovery must be structured routing facts, not prose`,
    );
    assertFactOnlyHelperValue(child, `${location}.${key}`);
  }
}

function expectParseCode(argv: string[], code: string): void {
  try {
    parseHelperCliArgs(argv);
    throw new Error(`Expected ${code}`);
  } catch (error) {
    if (!(error instanceof HelperCliInputError) || error.code !== code) throw error;
  }
}

function setRuntimeRoots(base: string): void {
  process.env.HY_WORKFLOW_CONFIG_HOME = path.join(base, "config");
  process.env.HY_WORKFLOW_STATE_HOME = path.join(base, "state");
  process.env.HY_WORKFLOW_CACHE_HOME = path.join(base, "cache");
}

function skillPathsFor(base: string): HelperSkillPaths {
  const dataRoot = path.join(base, "skill-data");
  const stateRoot = path.join(base, "skill-state");
  return {
    dataRoot,
    stateRoot,
    ssotRoot: path.join(dataRoot, "skills"),
    manifestPath: path.join(stateRoot, "skill-ownership.json"),
    lockPath: path.join(stateRoot, "skill-projector.lock"),
  };
}

function target(agent: "codex" | "claude" | "opencode", base: string, detected: boolean): DetectedHelperSkillTarget {
  return {
    agent,
    skillsDir: path.join(base, `agent-${agent}`, "skills"),
    detected,
    evidence: detected ? ["test"] : [],
  };
}

function bytes(file: string): Buffer | null {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function assertSameBytes(file: string, expected: Buffer | null, message: string): void {
  const actual = bytes(file);
  assert(
    actual === null ? expected === null : expected !== null && actual.equals(expected),
    message,
  );
}

class FakeAdapter implements ClientAdapter {
  readonly name = "codex" as const;
  readonly definitions = new Map<ServerName, McpDefinition>();
  installed = false;
  removeCalls: ServerName[] = [];

  detect() {
    return {
      name: this.name,
      installed: this.installed,
      executable: this.installed ? "fake-codex" : null,
      version: this.installed ? "test" : null,
      configured: [...this.definitions.keys()],
    };
  }

  inspect(server: ServerName): ClientServerSnapshot {
    const definition = this.definitions.get(server) ?? null;
    return {
      definition,
      state: definition ? "active" : "absent",
      source: `/fake/${server}`,
      scope: "user",
      enabled: definition ? true : null,
      raw: { stable: server },
    };
  }

  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot {
    const previous = this.inspect(server);
    this.definitions.set(server, definition);
    return previous;
  }

  remove(
    server: ServerName,
    _expected: McpDefinition,
    previous?: ClientServerSnapshot | null,
  ): void {
    this.removeCalls.push(server);
    if (previous?.definition) this.definitions.set(server, previous.definition);
    else this.definitions.delete(server);
  }
}

function seedOwnership(root: string, adapter: FakeAdapter): void {
  const file = projectPaths(root).clientOwnership;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = (server: ServerName) => ({
    desired: MCP_DEFINITIONS[server],
    previous: { definition: null, state: "absent", source: `/fake/${server}`, scope: "user", enabled: null, raw: { stable: server } },
    applied: adapter.inspect(server),
  });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: "1",
    revision: 1,
    clients: { codex: { "hy-workflow": entry("hy-workflow"), "docs-gardener": entry("docs-gardener") } },
  }, null, 2)}\n`);
}

const parsed = parseHelperCliArgs(["install", "--clients", "all", "--mode", "copy", "--json"]);
assert(parsed.clients?.join(",") === "codex,claude,opencode" && parsed.mode === "copy" && parsed.json, "install options must parse deterministically");
assert(
  helperCommandArgv(parsed).join(" ") === "hy-workflow helper install --clients codex,claude,opencode --mode copy --json",
  "helper recovery argv must be exact and shell-free",
);
assert(parseHelperCliArgs(["update", "--repair"]).repair, "update must accept --repair");
expectParseCode([], "HELPER_COMMAND_MISSING");
expectParseCode(["unknown"], "HELPER_COMMAND_UNKNOWN");
expectParseCode(["status", "--repair"], "HELPER_OPTION_NOT_ALLOWED");
expectParseCode(["remove", "--clients", "codex"], "HELPER_OPTION_NOT_ALLOWED");
expectParseCode(["install", "--clients", "codex, codex"], "HELPER_CLIENTS_INVALID");
expectParseCode(["install", "--clients", "codex,codex"], "HELPER_CLIENTS_INVALID");
expectParseCode(["install", "--mode", "hardlink"], "HELPER_MODE_INVALID");
expectParseCode(["install", "--clients"], "HELPER_OPTION_VALUE_MISSING");

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundleRoot = path.join(repositoryRoot, "skills");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-cli-runtime-"));
setRuntimeRoots(runtime);
const root = makeGitProject("hy-helper-cli-project-");
const skillPaths = skillPathsFor(runtime);
const detectedTargets = [
  target("codex", runtime, true),
  target("claude", runtime, false),
  target("opencode", runtime, false),
];
const paths = projectPaths(root);
fs.mkdirSync(paths.stateDir, { recursive: true });
fs.writeFileSync(paths.workflowState, "workflow-state-preserve\n");
fs.writeFileSync(paths.scope, "scope-preserve\n");
const workflowBefore = bytes(paths.workflowState);
const scopeBefore = bytes(paths.scope);
const gitBefore = gitStatus(root);
const adapter = new FakeAdapter();
adapter.definitions.set("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
adapter.definitions.set("docs-gardener", MCP_DEFINITIONS["docs-gardener"]);
seedOwnership(root, adapter);

const dependencies = {
  cwd: root,
  bundleRoot,
  skillPaths,
  detectedTargets,
  adapters: [adapter],
  skillHooks: { createSymlink: () => { throw new Error("force deterministic copy fallback"); } },
};
const partial = await runHelperCli(["install", "--clients", "codex", "--mode", "copy", "--json"], dependencies);
assert(
  partial.exitCode === 1 && partial.envelope.status === "partial",
  `unavailable MCP client must produce partial-safe recovery: ${JSON.stringify(partial.envelope)}`,
);
assert(partial.envelope.layers.skills.status === "installed" && partial.envelope.layers.project.status === "registered", "Skills and external registration must remain complete when retirement is pending");
assert(
  partial.envelope.layers.mcp.status === "partial",
  `MCP retirement must identify the incomplete layer: ${JSON.stringify(partial.envelope.layers.mcp)}`,
);
assert(
  JSON.stringify(partial.envelope.recovery?.argv)
    === JSON.stringify(["hy-workflow", "helper", "install", "--clients", "codex", "--mode", "copy", "--json"]),
  "partial recovery must rerun the same exact helper command",
);
assertFactOnlyHelperValue(partial.envelope);
assert(partial.envelope.schema === HELPER_CLI_SCHEMA && partial.stdout === `${JSON.stringify(partial.envelope)}\n`, "helper output must be one versioned compact JSON document");
assert(gitStatus(root) === gitBefore && !fs.existsSync(path.join(root, ".git", "hy-workflow")), "helper registration must not write the project or .git");
assertSameBytes(paths.workflowState, workflowBefore, "fresh registration must preserve existing workflow state bytes");
assertSameBytes(paths.scope, scopeBefore, "fresh registration must preserve existing scope bytes");

const nestedHintFailure = new Error("Injected helper fact failure.");
Object.assign(nestedHintFailure, {
  type: "helper",
  subtype: "test",
  code: "HELPER_TEST_FACT_FAILURE",
  hint: "Top-level Agent guidance.",
  detail: {
    stable: true,
    hint: "Nested Agent guidance.",
    nested: {
      instruction: "Do something.",
      recovery: "Run a shell command.",
      code: "NESTED_FACT",
    },
  },
});
const sanitizedFailure = await runHelperCli(["update", "--json"], {
  ...dependencies,
  registerProject: async () => { throw nestedHintFailure; },
});
const sanitizedDetail = sanitizedFailure.envelope.error?.detail as
  | { stable?: boolean; nested?: { code?: string } }
  | undefined;
const sanitizedLayerError = sanitizedFailure.envelope.layers.project.error as
  | { code?: string; detail?: { stable?: boolean; nested?: { code?: string } } }
  | undefined;
assert(
  sanitizedFailure.exitCode === 1
    && sanitizedFailure.envelope.error?.code === "HELPER_TEST_FACT_FAILURE"
    && sanitizedDetail?.stable === true
    && sanitizedDetail.nested?.code === "NESTED_FACT",
  "helper top-level failures must preserve nested machine facts",
);
assert(
  sanitizedLayerError?.code === "HELPER_TEST_FACT_FAILURE"
    && sanitizedLayerError.detail?.stable === true
    && sanitizedLayerError.detail.nested?.code === "NESTED_FACT",
  "helper layer failures must preserve nested machine facts",
);
assertFactOnlyHelperValue(sanitizedFailure.envelope);

const deployment = readDeployment(root);
assert(deployment?.schemaVersion === "3", "fresh helper registration must write schema 3 deployment");
assert(deployment.projectFiles.length === 0, "helper deployment must own no project files");
assert("artifacts" in deployment && Object.keys(deployment.artifacts).length === 0, "helper deployment artifacts must be empty");
const externalConfig = JSON.parse(fs.readFileSync(paths.config, "utf8"));
assert(externalConfig.project?.baseBranch === "main" && externalConfig.codelint?.lintDirs?.length, "fresh helper registration must write a complete external config");
const registry = JSON.parse(fs.readFileSync(paths.registry, "utf8"));
assert(registry.projects[paths.identity.id]?.root === root, "fresh helper registration must register the exact project identity");

adapter.installed = true;
const completed = await runHelperCli(["install", "--clients", "codex", "--mode", "copy", "--json"], dependencies);
assert(completed.exitCode === 0 && completed.envelope.layers.skills.status === "unchanged", "retry must reuse completed Skill work idempotently");
assert(completed.envelope.layers.project.status === "preserved" && completed.envelope.layers.mcp.status === "retired", "retry must preserve project state and finish only retirement");
assert(adapter.removeCalls.join(",") === "hy-workflow", "retirement must remove only the legacy hy-workflow MCP entry");
assert(!adapter.definitions.has("hy-workflow") && adapter.definitions.has("docs-gardener"), "docs-gardener must remain configured");
const ownershipAfterRetire = JSON.parse(fs.readFileSync(paths.clientOwnership, "utf8"));
assert(!ownershipAfterRetire.clients.codex?.["hy-workflow"] && ownershipAfterRetire.clients.codex?.["docs-gardener"], "retirement must preserve docs-gardener ownership");

const stableFiles = [paths.config, paths.deployment, paths.registry, paths.workflowState, paths.scope, paths.clientOwnership, skillPaths.manifestPath];
const stableBytes = new Map(stableFiles.map(file => [file, bytes(file)]));
const repeated = await runHelperCli(["install", "--clients", "codex", "--mode", "copy", "--json"], dependencies);
assert(repeated.exitCode === 0 && repeated.envelope.layers.skills.status === "unchanged" && repeated.envelope.layers.mcp.status === "unchanged", "repeated helper install must be a complete no-op");
for (const file of stableFiles) assertSameBytes(file, stableBytes.get(file) ?? null, `repeated install must preserve bytes: ${file}`);

const statusBefore = new Map(stableFiles.map(file => [file, bytes(file)]));
const status = await runHelperCli(["status", "--json"], dependencies);
assert(status.exitCode === 0 && status.envelope.layers.skills.status === "healthy" && status.envelope.layers.project.status === "registered", "status must report healthy installed state");
for (const file of stableFiles) assertSameBytes(file, statusBefore.get(file) ?? null, `status must be read-only: ${file}`);

const manifestBeforeMismatch = bytes(skillPaths.manifestPath);
const clientMismatch = await runHelperCli(["update", "--clients", "claude", "--json"], dependencies);
assert(clientMismatch.envelope.error?.code === "HELPER_TARGET_SET_IMMUTABLE", "update must reject target-set drift");
assertSameBytes(skillPaths.manifestPath, manifestBeforeMismatch, "target-set rejection must not rewrite the manifest");
const modeMismatch = await runHelperCli(["update", "--mode", "symlink", "--json"], dependencies);
assert(modeMismatch.envelope.error?.code === "HELPER_MODE_IMMUTABLE", "update must reject projection-mode drift");
assertSameBytes(skillPaths.manifestPath, manifestBeforeMismatch, "mode rejection must not rewrite the manifest");

const update = await runHelperCli(["update", "--clients", "codex", "--mode", "copy", "--json"], dependencies);
assert(update.exitCode === 0 && update.envelope.layers.skills.status === "unchanged", "same bundle update must be idempotent");
for (const file of stableFiles) assertSameBytes(file, stableBytes.get(file) ?? null, `idempotent update must preserve bytes: ${file}`);

const projectBytesBeforeRemove = new Map([paths.config, paths.deployment, paths.registry, paths.workflowState, paths.scope, paths.clientOwnership].map(file => [file, bytes(file)]));
const removeCallsBefore = adapter.removeCalls.length;
const removed = await runHelperCli(["remove", "--json"], dependencies);
assert(removed.exitCode === 0 && removed.envelope.layers.skills.status === "removed", "helper remove must remove the owned Skill bundle");
assert(removed.envelope.layers.project.status === "preserved" && removed.envelope.layers.mcp.status === "preserved", "helper remove must preserve project and MCP state");
assert(!fs.existsSync(skillPaths.manifestPath) && !fs.existsSync(skillPaths.ssotRoot), "helper remove must delete only Skill-owned SSOT and manifest");
assert(adapter.removeCalls.length === removeCallsBefore && adapter.definitions.has("docs-gardener"), "helper remove must not restore or change MCP entries");
for (const [file, expected] of projectBytesBeforeRemove) assertSameBytes(file, expected, `helper remove must preserve external project bytes: ${file}`);
assert((await runHelperCli(["remove", "--json"], dependencies)).envelope.layers.skills.status === "unchanged", "repeated helper remove must be idempotent");
assert(gitStatus(root) === gitBefore, "the complete helper lifecycle must leave the project worktree unchanged");

const runtimeUnion = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-cli-union-runtime-"));
setRuntimeRoots(runtimeUnion);
const unionRoot = makeGitProject("hy-helper-cli-union-project-");
await registerHelperProject(unionRoot, ["codex"]);
const unionPaths = skillPathsFor(runtimeUnion);
const unionDetected = [
  target("codex", runtimeUnion, false),
  target("claude", runtimeUnion, false),
  target("opencode", runtimeUnion, true),
];
const deploymentBeforeUnionInstall = bytes(projectPaths(unionRoot).deployment);
const unionInstall = await runHelperCli(["install", "--mode", "copy", "--json"], {
  cwd: unionRoot,
  bundleRoot,
  skillPaths: unionPaths,
  detectedTargets: unionDetected,
  skillHooks: { createSymlink: () => { throw new Error("copy"); } },
});
assert(unionInstall.exitCode === 0 && unionInstall.envelope.clients.join(",") === "codex,opencode", "first install must union existing deployment clients with detected installed Agents");
assertSameBytes(projectPaths(unionRoot).deployment, deploymentBeforeUnionInstall, "existing deployment must remain byte-for-byte unchanged");
await runHelperCli(["remove", "--json"], { cwd: unionRoot, bundleRoot, skillPaths: unionPaths, detectedTargets: unionDetected });


const legacyRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-cli-legacy-runtime-"));
setRuntimeRoots(legacyRuntime);
const legacyRoot = makeGitProject("hy-helper-cli-legacy-project-");
const legacyPaths = projectPaths(legacyRoot);
const legacyProjectConfigPath = path.join(legacyRoot, "hy-workflow.json");
fs.writeFileSync(legacyProjectConfigPath, `${JSON.stringify({
  project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"], maxLines: 500 },
  doclint: { maxLines: 200 },
  docsGardener: { catalogs: {} },
  ci: { commands: ["npm test"] },
}, null, 2)}\n`);
writeDeployment(legacyRoot, {
  setupVersion: "2026.07.16.1",
  mode: "shared",
  clients: ["codex"],
  projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"],
  tools: {},
  artifacts: {},
});
fs.mkdirSync(legacyPaths.stateDir, { recursive: true });
fs.writeFileSync(legacyPaths.workflowState, "legacy-workflow-preserve\n");
fs.writeFileSync(legacyPaths.scope, "legacy-scope-preserve\n");
const legacyGitBefore = gitStatus(legacyRoot);
const legacyPreservedFiles = [legacyProjectConfigPath, legacyPaths.deployment, legacyPaths.registry, legacyPaths.workflowState, legacyPaths.scope];
const legacyPreservedBytes = new Map(legacyPreservedFiles.map(file => [file, bytes(file)]));
assert(!fs.existsSync(legacyPaths.config), "v0.4.0 fixture must begin without an external config");
const legacyRegistration = await registerHelperProject(legacyRoot, ["codex"]);
assert(
  legacyRegistration.action === "preserved"
    && legacyRegistration.readiness.state === "ready"
    && legacyRegistration.localFilesChanged.join(",") === legacyPaths.config,
  "owned v0.4.0 root config must project only an external authority marker",
);
assert(
  JSON.stringify(JSON.parse(fs.readFileSync(legacyPaths.config, "utf8"))) === JSON.stringify(projectRuntimeConfigSource()),
  "legacy migration must establish the exact project-authority marker",
);
for (const file of legacyPreservedFiles) assertSameBytes(file, legacyPreservedBytes.get(file) ?? null, `legacy projection must preserve bytes: ${file}`);
assert(gitStatus(legacyRoot) === legacyGitBefore, "legacy projection must leave the project worktree unchanged");
const legacyMarkerBefore = bytes(legacyPaths.config);
const legacyRepeated = await registerHelperProject(legacyRoot, ["codex"]);
assert(legacyRepeated.action === "preserved" && legacyRepeated.localFilesChanged.length === 0, "repeated legacy projection must be a no-op");
assertSameBytes(legacyPaths.config, legacyMarkerBefore, "repeated legacy projection must preserve marker bytes");

const readinessRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-cli-readiness-runtime-"));
setRuntimeRoots(readinessRuntime);
const readinessRoot = makeGitProject("hy-helper-cli-readiness-project-");
const readinessPaths = projectPaths(readinessRoot);
const readinessSkillPaths = skillPathsFor(readinessRuntime);
const readinessDetected = [
  target("codex", readinessRuntime, true),
  target("claude", readinessRuntime, false),
  target("opencode", readinessRuntime, false),
];
fs.mkdirSync(readinessPaths.stateDir, { recursive: true });
fs.writeFileSync(readinessPaths.workflowState, "readiness-workflow-preserve\n");
fs.writeFileSync(readinessPaths.scope, "readiness-scope-preserve\n");
await registerHelperProject(readinessRoot, ["codex"]);

const readinessAdapter = new FakeAdapter();
readinessAdapter.installed = true;
const readinessDependencies = {
  cwd: readinessRoot,
  bundleRoot,
  skillPaths: readinessSkillPaths,
  detectedTargets: readinessDetected,
  adapters: [readinessAdapter],
  skillHooks: { createSymlink: () => { throw new Error("copy"); } },
};
const readinessInstall = await runHelperCli(
  ["install", "--clients", "codex", "--mode", "copy", "--json"],
  readinessDependencies,
);
assert(readinessInstall.exitCode === 0, "readiness fixture must begin with a healthy helper installation");

readinessAdapter.definitions.set("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
readinessAdapter.definitions.set("docs-gardener", MCP_DEFINITIONS["docs-gardener"]);
seedOwnership(readinessRoot, readinessAdapter);
const validReadinessConfig = bytes(readinessPaths.config);
assert(validReadinessConfig, "readiness fixture must have an external config");
const readinessGitBefore = gitStatus(readinessRoot);

async function assertProjectAttention(
  label: string,
  expectedConfigExists: boolean,
  expectedCode: string,
): Promise<void> {
  const preservedFiles = [
    readinessPaths.config,
    readinessPaths.deployment,
    readinessPaths.registry,
    readinessPaths.workflowState,
    readinessPaths.scope,
    readinessPaths.clientOwnership,
    readinessSkillPaths.manifestPath,
  ];
  const preservedBytes = new Map(preservedFiles.map(file => [file, bytes(file)]));
  const removeCallsBefore = readinessAdapter.removeCalls.length;

  const registration = await registerHelperProject(readinessRoot, ["codex"]);
  assert(registration.action === "attention", `${label}: registration must not report preserved`);
  assert(
    registration.readiness.configExists === expectedConfigExists
      && registration.readiness.issues.some(issue => issue.code === expectedCode),
    `${label}: registration must expose exact readiness facts`,
  );
  assertFactOnlyHelperValue(registration.readiness, `${label}.registration.readiness`);

  const statusResult = await runHelperCli(["status", "--json"], readinessDependencies);
  const statusReadiness = statusResult.envelope.layers.project.readiness as
    | { configExists: boolean; issues: Array<{ code: string }> }
    | undefined;
  const statusErrorDetail = statusResult.envelope.error?.detail as
    | { issues?: Array<{ code?: string; message?: string; recovery?: unknown }> }
    | undefined;
  assert(
    statusResult.exitCode === 1
      && statusResult.envelope.status === "attention"
      && statusResult.envelope.layers.project.status === "attention",
    `${label}: helper status must return project attention`,
  );
  assert(
    statusResult.envelope.error?.code === expectedCode
      && statusReadiness?.configExists === expectedConfigExists
      && statusReadiness.issues.some(issue => issue.code === expectedCode),
    `${label}: helper status must expose recoverable readiness facts`,
  );
  assert(
    statusErrorDetail?.issues?.some(issue =>
      issue.code === expectedCode
      && typeof issue.message === "string"
      && !("recovery" in issue)),
    `${label}: helper status error detail must preserve fact-only readiness issues`,
  );
  assert(
    statusResult.envelope.layers.mcp.status === "not_run"
      && JSON.stringify(statusResult.envelope.recovery?.argv)
        === JSON.stringify(["hy-workflow", "helper", "status", "--json"]),
    `${label}: helper status must stop before the MCP layer and provide exact retry argv`,
  );
  assertFactOnlyHelperValue(statusResult.envelope, `${label}.status`);

  const installResult = await runHelperCli(
    ["install", "--clients", "codex", "--mode", "copy", "--json"],
    readinessDependencies,
  );
  assert(
    installResult.exitCode === 1
      && installResult.envelope.status === "attention"
      && installResult.envelope.layers.skills.status === "unchanged"
      && installResult.envelope.layers.project.status === "attention"
      && installResult.envelope.layers.mcp.status === "not_run",
    `${label}: helper install must stop before legacy MCP retirement`,
  );
  assert(
    installResult.envelope.error?.code === expectedCode
      && JSON.stringify(installResult.envelope.recovery?.argv)
        === JSON.stringify(["hy-workflow", "helper", "install", "--clients", "codex", "--mode", "copy", "--json"]),
    `${label}: helper install must provide exact recoverable facts`,
  );
  assertFactOnlyHelperValue(installResult.envelope, `${label}.install`);
  assert(
    readinessAdapter.removeCalls.length === removeCallsBefore
      && readinessAdapter.definitions.has("hy-workflow")
      && readinessAdapter.definitions.has("docs-gardener"),
    `${label}: readiness attention must not retire or alter MCP entries`,
  );
  for (const file of preservedFiles) {
    assertSameBytes(file, preservedBytes.get(file) ?? null, `${label}: helper checks must preserve bytes: ${file}`);
  }
}

fs.unlinkSync(readinessPaths.config);
await assertProjectAttention("missing external config", false, "HELPER_PROJECT_CONFIG_INVALID");

fs.writeFileSync(readinessPaths.config, "{invalid-json\n");
await assertProjectAttention("corrupt external config", true, "HELPER_PROJECT_CONFIG_INVALID");

const notReadyConfig = JSON.parse(validReadinessConfig.toString("utf8"));
notReadyConfig.project.baseBranch = "definitely-missing-helper-base-branch";
fs.writeFileSync(readinessPaths.config, `${JSON.stringify(notReadyConfig, null, 2)}\n`);
await assertProjectAttention("init readiness failure", true, "BASE_BRANCH_NOT_FOUND");
assert(gitStatus(readinessRoot) === readinessGitBefore, "readiness checks must leave the project worktree unchanged");
const lockRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-operation-lock-runtime-"));
setRuntimeRoots(lockRuntime);
const lockRoot = makeGitProject("hy-helper-operation-lock-project-");
const lockSkillPaths = skillPathsFor(lockRuntime);
const lockDependencies = {
  cwd: lockRoot,
  bundleRoot,
  skillPaths: lockSkillPaths,
  detectedTargets: [target("codex", lockRuntime, true)],
  skillHooks: { createSymlink: () => { throw new Error("copy"); } },
};
const operationLock = helperOperationLockPath(lockSkillPaths);

fs.mkdirSync(operationLock, { recursive: true });
const freshOwnerless = await runHelperCli(["remove", "--json"], lockDependencies);
assert(
  freshOwnerless.envelope.error?.code === "HELPER_OPERATION_BUSY"
    && freshOwnerless.envelope.error.retryable === true,
  "a fresh ownerless operation lock must fail with retryable HELPER_OPERATION_BUSY",
);
assert(fs.existsSync(operationLock), "fresh ownerless operation lock must never be deleted");
const unlockedStatus = await runHelperCli(["status", "--json"], lockDependencies);
assert(
  unlockedStatus.envelope.error?.code !== "HELPER_OPERATION_BUSY" && fs.existsSync(operationLock),
  "helper status must remain unlocked and preserve an active operation lock",
);

const staleTime = new Date(Date.now() - 61_000);
fs.utimesSync(operationLock, staleTime, staleTime);
const staleRecovered = await runHelperCli(["remove", "--json"], lockDependencies);
assert(
  staleRecovered.exitCode === 0 && !fs.existsSync(operationLock),
  "a stale ownerless operation lock must be atomically reclaimed and released",
);
assert(
  !fs.readdirSync(lockSkillPaths.stateRoot).some(name => name.startsWith("helper-operation.lock.stale-")),
  "stale operation-lock reclamation must remove only its unique tombstone",
);

await withHelperOperationLock(lockSkillPaths, async () => {
  const busy = await runHelperCli(["remove", "--json"], lockDependencies);
  assert(
    busy.envelope.error?.code === "HELPER_OPERATION_BUSY"
      && busy.envelope.error.retryable === true
      && fs.existsSync(operationLock),
    "a live operation owner must block a concurrent helper mutation without deleting its lock",
  );
  const statusWhileBusy = await runHelperCli(["status", "--json"], lockDependencies);
  assert(
    statusWhileBusy.envelope.error?.code !== "HELPER_OPERATION_BUSY",
    "status must remain available while a helper mutation owns the operation lock",
  );
});
assert(!fs.existsSync(operationLock), "the exact operation owner must release its lock");

await withHelperOperationLock(lockSkillPaths, () => {
  fs.writeFileSync(path.join(operationLock, "owner.json"), `${JSON.stringify({
    pid: process.pid,
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: new Date().toISOString(),
  })}\n`);
});
assert(fs.existsSync(operationLock), "operation-lock release must not delete a replacement owner token");
fs.rmSync(operationLock, { recursive: true });

const lifecycleRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-operation-lifecycle-runtime-"));
setRuntimeRoots(lifecycleRuntime);
const lifecycleRoot = makeGitProject("hy-helper-operation-lifecycle-project-");
const lifecycleSkillPaths = skillPathsFor(lifecycleRuntime);
let signalProjectStage!: () => void;
let releaseProjectStage!: () => void;
const projectStageEntered = new Promise<void>(resolve => { signalProjectStage = resolve; });
const projectStageGate = new Promise<void>(resolve => { releaseProjectStage = resolve; });
const lifecycleDependencies = {
  cwd: lifecycleRoot,
  bundleRoot,
  skillPaths: lifecycleSkillPaths,
  detectedTargets: [target("codex", lifecycleRuntime, true)],
  skillHooks: { createSymlink: () => { throw new Error("copy"); } },
  registerProject: async (projectRoot: string, clients: ClientName[]) => {
    signalProjectStage();
    await projectStageGate;
    return registerHelperProject(projectRoot, clients);
  },
};
const pendingInstall = runHelperCli(
  ["install", "--clients", "codex", "--mode", "copy", "--json"],
  lifecycleDependencies,
);
await projectStageEntered;
assert(fs.existsSync(lifecycleSkillPaths.manifestPath), "fixture must reach the post-Skill project stage");
const concurrentRemove = await runHelperCli(["remove", "--json"], lifecycleDependencies);
assert(
  concurrentRemove.envelope.error?.code === "HELPER_OPERATION_BUSY"
    && concurrentRemove.envelope.layers.skills.status === "not_run"
    && fs.existsSync(lifecycleSkillPaths.manifestPath),
  "the lifecycle lock must stop remove between Skill installation and project registration",
);
const concurrentStatus = await runHelperCli(["status", "--json"], lifecycleDependencies);
assert(
  concurrentStatus.envelope.error?.code !== "HELPER_OPERATION_BUSY",
  "status must remain unlocked while install is paused in the project layer",
);
releaseProjectStage();
const lifecycleInstalled = await pendingInstall;
assert(lifecycleInstalled.exitCode === 0, "the original lifecycle operation must finish after release");
assert(!fs.existsSync(helperOperationLockPath(lifecycleSkillPaths)), "completed lifecycle must release its outer lock");
assert((await runHelperCli(["remove", "--json"], lifecycleDependencies)).exitCode === 0, "remove must run after lifecycle completion");

const driftRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-operation-drift-runtime-"));
setRuntimeRoots(driftRuntime);
const driftRoot = makeGitProject("hy-helper-operation-drift-project-");
const driftSkillPaths = skillPathsFor(driftRuntime);
const driftAdapter = new FakeAdapter();
driftAdapter.installed = true;
driftAdapter.definitions.set("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
driftAdapter.definitions.set("docs-gardener", MCP_DEFINITIONS["docs-gardener"]);
seedOwnership(driftRoot, driftAdapter);
const driftedInstall = await runHelperCli(
  ["install", "--clients", "codex", "--mode", "copy", "--json"],
  {
    cwd: driftRoot,
    bundleRoot,
    skillPaths: driftSkillPaths,
    detectedTargets: [target("codex", driftRuntime, true)],
    adapters: [driftAdapter],
    skillHooks: { createSymlink: () => { throw new Error("copy"); } },
    registerProject: async (projectRoot: string, clients: ClientName[]) => {
      const registration = await registerHelperProject(projectRoot, clients);
      const manifest = JSON.parse(fs.readFileSync(driftSkillPaths.manifestPath, "utf8"));
      fs.rmSync(manifest.skills[0].projections[0].path, { recursive: true, force: true });
      return registration;
    },
  },
);
assert(
  driftedInstall.exitCode === 1
    && driftedInstall.envelope.error?.code === "HELPER_SKILL_STATE_CHANGED"
    && driftedInstall.envelope.layers.mcp.status === "failed",
  "MCP retirement must stop when the exact installed Skill manifest is no longer healthy",
);
assert(
  driftAdapter.removeCalls.length === 0
    && driftAdapter.definitions.has("hy-workflow")
    && driftAdapter.definitions.has("docs-gardener"),
  "pre-retirement Skill drift must preserve every legacy MCP definition",
);

console.log("helper-cli: strict routing, lifecycle lock, stale recovery, exact Skill retirement precondition, migration safety, and read-only status pass");
