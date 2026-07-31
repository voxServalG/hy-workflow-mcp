import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROJECT_CONFIG_SCHEMA_URL,
  RUNTIME_CONFIG_SOURCE_ENV,
  RUNTIME_CONFIG_SOURCE_SCHEMA,
  applyConfig,
  buildSuggestedCommand,
  checkConfig,
  ensureConfigDefaults,
  projectRuntimeConfigSource,
  readUnifiedConfig,
  requireRuntimeBaseBranch,
  requireRuntimeConfig,
  resolveRuntimeConfig,
  runConfigCli,
} from "../../src/config.js";
import { projectPaths } from "../../src/runtime/user-paths.js";

const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(runtimeHome, "cache");
delete process.env[RUNTIME_CONFIG_SOURCE_ENV];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Project facts\n", "utf-8");
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname='demo'\n", "utf-8");
  fs.writeFileSync(path.join(root, "src", "app.py"), "print('ok')\n", "utf-8");
  return root;
}

function readJson(root: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));
}

function exists(root: string, file: string): boolean {
  return fs.existsSync(path.join(root, file));
}

function markProjectAuthority(root: string): void {
  const source = projectPaths(root).config;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify(projectRuntimeConfigSource(), null, 2) + "\n", "utf-8");
}

function schemaAllowsRuleValue(schema: any, rule: string, value: Record<string, unknown>): boolean {
  const ruleSchema = schema.$defs.ruleMap.properties[rule];
  if (!ruleSchema?.$ref?.startsWith("#/$defs/")) return false;
  const definition = schema.$defs[ruleSchema.$ref.slice("#/$defs/".length)];
  const allowed = new Set(Object.keys(definition?.properties ?? {}));
  return definition?.type === "object"
    && (definition.additionalProperties !== false || Object.keys(value).every(key => allowed.has(key)));
}

function configuredRoot(codeExt: string | string[], files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-custom-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Project facts\n", "utf-8");
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  const unified = {
    project: { baseBranch: "main", codeExt, codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLines: 300 },
    doclint: { maxLines: 180 },
    docsGardener: { catalogs: {} },
  };
  fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify(unified, null, 2) + "\n", "utf-8");
  const source = projectPaths(root).config;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify(projectRuntimeConfigSource(), null, 2) + "\n", "utf-8");
  return root;
}

const atomicConfigRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const atomicConfigPath = path.join(atomicConfigRoot, "hy-workflow.json");
if (process.platform !== "win32") fs.chmodSync(atomicConfigPath, 0o640);
const atomicSuggestion = { codeExt: ".py" as const, codeDirs: ["src"], lintDirs: ["src"], docsDir: "docs", baseBranch: "main", maxCodeLines: 301, maxDocLines: 180, ciCommands: ["python -m pytest"] };
applyConfig(atomicConfigRoot, atomicSuggestion, { preserveExisting: true, dryRun: false, overrides: { maxCodeLines: 301 } });
if (process.platform !== "win32") assert((fs.statSync(atomicConfigPath).mode & 0o777) === 0o640, "atomic config replacement must preserve the existing mode");
const atomicBeforeFailure = fs.readFileSync(atomicConfigPath, "utf-8");
const originalAtomicWriteFileSync = fsDefault.writeFileSync;
const atomicFailure = new Error("injected atomic config temp-write failure");
let atomicFailureCaught: unknown;
try {
  (fsDefault as any).writeFileSync = (...args: any[]) => {
    if (path.resolve(String(args[0])).startsWith(path.resolve(atomicConfigPath) + ".")) throw atomicFailure;
    return (originalAtomicWriteFileSync as any)(...args);
  };
  syncBuiltinESMExports();
  applyConfig(atomicConfigRoot, { ...atomicSuggestion, maxCodeLines: 302 }, { preserveExisting: true, dryRun: false, overrides: { maxCodeLines: 302 } });
} catch (error) { atomicFailureCaught = error; }
finally {
  (fsDefault as any).writeFileSync = originalAtomicWriteFileSync;
  syncBuiltinESMExports();
}
assert(atomicFailureCaught === atomicFailure, "atomic config temp-write failure must remain visible");
assert(fs.readFileSync(atomicConfigPath, "utf-8") === atomicBeforeFailure, "failed config replacement must preserve the previous root config byte-for-byte");

const markerFailureRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const markerFailureConfig = path.join(markerFailureRoot, "hy-workflow.json");
const markerFailureSource = projectPaths(markerFailureRoot).config;
fs.writeFileSync(markerFailureSource, JSON.stringify({
  mode: "shared",
  project: { baseBranch: "legacy-main", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"] },
}, null, 2) + "\n", { mode: 0o640 });
const markerRootBefore = fs.readFileSync(markerFailureConfig, "utf-8");
const markerSourceBefore = fs.readFileSync(markerFailureSource, "utf-8");
const markerRootModeBefore = fs.statSync(markerFailureConfig).mode & 0o777;
const markerSourceModeBefore = fs.statSync(markerFailureSource).mode & 0o777;
const markerFailure = new Error("injected external marker temp-write failure");
let markerFailureCaught: unknown;
try {
  (fsDefault as any).writeFileSync = (...args: any[]) => {
    if (path.resolve(String(args[0])).startsWith(path.resolve(markerFailureSource) + ".")) throw markerFailure;
    return (originalAtomicWriteFileSync as any)(...args);
  };
  syncBuiltinESMExports();
  runConfigCli(["--apply", "--json", "--base-branch", "release/next"], markerFailureRoot);
} catch (error) { markerFailureCaught = error; }
finally {
  (fsDefault as any).writeFileSync = originalAtomicWriteFileSync;
  syncBuiltinESMExports();
}
assert(markerFailureCaught === markerFailure, "external marker write failure must remain visible after successful rollback");
assert(fs.readFileSync(markerFailureConfig, "utf-8") === markerRootBefore, "marker failure must roll root config back byte-for-byte");
assert(fs.readFileSync(markerFailureSource, "utf-8") === markerSourceBefore, "marker failure must preserve the previous external config byte-for-byte");
assert((fs.statSync(markerFailureConfig).mode & 0o777) === markerRootModeBefore, "marker failure must restore the root config mode");
assert((fs.statSync(markerFailureSource).mode & 0o777) === markerSourceModeBefore, "marker failure must preserve the external config mode");

const nonDirectoryRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n", "not-a-directory": "file\n" });
const nonDirectoryConfig = readJson(nonDirectoryRoot, "hy-workflow.json");
nonDirectoryConfig.project.codeDirs = ["not-a-directory"];
nonDirectoryConfig.codelint.lintDirs = ["not-a-directory"];
fs.writeFileSync(path.join(nonDirectoryRoot, "hy-workflow.json"), JSON.stringify(nonDirectoryConfig, null, 2) + "\n");
const nonDirectoryCheck = checkConfig(nonDirectoryRoot);
assert(nonDirectoryCheck.issues.some(issue => issue.includes("project.codeDirs entry is not an existing directory")), "codeDirs must reject a regular file");
assert(nonDirectoryCheck.issues.some(issue => issue.includes("codelint.lintDirs entry is not an existing directory")), "lintDirs must reject a regular file");

const root = tempRoot();
fs.writeFileSync(path.join(root, "codelint.json"), JSON.stringify({
  lintDirs: ["src"],
  codeDirs: ["src"],
  codeExt: ".py",
  baseBranch: "main",
  maxLines: 300,
}, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(root, "doclint.json"), JSON.stringify({
  docsDir: "docs",
  codeDirs: ["src"],
  codeExt: ".py",
  baseBranch: "main",
  maxLines: 180,
}, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(root, "docs-gardener.json"), JSON.stringify({
  docsDir: "docs",
  codeDirs: ["src"],
  codeExt: ".py",
  baseBranch: "main",
  catalogs: { cli: ["hy_init"] },
}, null, 2) + "\n", "utf-8");

const before = JSON.stringify({
  unified: exists(root, "hy-workflow.json") ? readJson(root, "hy-workflow.json") : null,
  codelint: readJson(root, "codelint.json"),
  doclint: readJson(root, "doclint.json"),
  gardener: readJson(root, "docs-gardener.json"),
});
const dry = ensureConfigDefaults(root, { dryRun: true });
assert(dry.dryRun === true, "dry-run should be marked");
assert(JSON.stringify({
  unified: exists(root, "hy-workflow.json") ? readJson(root, "hy-workflow.json") : null,
  codelint: readJson(root, "codelint.json"),
  doclint: readJson(root, "doclint.json"),
  gardener: readJson(root, "docs-gardener.json"),
}) === before, "dry-run must not write files");

ensureConfigDefaults(root);
assert(!exists(root, "hy-workflow.json"), "authority-free config defaults must not create a project file");
const externalDefaults = JSON.parse(fs.readFileSync(projectPaths(root).config, "utf-8"));
assert(externalDefaults.project.baseBranch === dry.suggestion.baseBranch, "config defaults must use read-only project detection rather than legacy injected config");
assert(externalDefaults.project.docsDir === "docs", "config defaults must write the detected docsDir externally");
assert(externalDefaults.codelint.lintDirs[0] === "src", "config defaults must write shared codelint settings externally");
assert(externalDefaults.doclint.maxLinesError === 500, "config defaults must use the canonical document hard threshold");
assert(Object.keys(externalDefaults.docsGardener.catalogs).length === 0, "config defaults must not import historical injected catalogs");
assert(readJson(root, "codelint.json").codeExt === ".py", "setup defaults must not overwrite existing legacy codelint");
assert(externalDefaults.$schema === PROJECT_CONFIG_SCHEMA_URL && externalDefaults.version === 1, "new external config must declare its schema and version");

const check = checkConfig(root);
assert(check.ok, `Python config should be consistent: ${check.issues.join(", ")}`);

const ciRoot = configuredRoot(".ts", { "src/app.ts": "export {};\n" });
const ciConfig = readJson(ciRoot, "hy-workflow.json");
ciConfig.ci = { commands: ["npm ci", "npm test"], owner: "team" };
fs.writeFileSync(path.join(ciRoot, "hy-workflow.json"), JSON.stringify(ciConfig, null, 2) + "\n", "utf-8");
const ciApplied = ensureConfigDefaults(ciRoot);
assert(ciApplied.ok, `confirmed ci.commands should validate: ${ciApplied.issues.join(", ")}`);
assert(JSON.stringify(readJson(ciRoot, "hy-workflow.json").ci.commands) === JSON.stringify(["npm ci", "npm test"]), "config apply must preserve confirmed ci.commands");
assert(readJson(ciRoot, "hy-workflow.json").ci.owner === "team", "config apply must preserve unknown ci fields");
for (const commands of [[], "npm test", ["npm test\nrm -rf output"]]) {
  const invalidCiRoot = configuredRoot(".ts", { "src/app.ts": "export {};\n" });
  const invalidCi = readJson(invalidCiRoot, "hy-workflow.json");
  invalidCi.ci = { commands };
  fs.writeFileSync(path.join(invalidCiRoot, "hy-workflow.json"), JSON.stringify(invalidCi, null, 2) + "\n", "utf-8");
  const invalidCiCheck = checkConfig(invalidCiRoot);
  assert(!invalidCiCheck.ok && invalidCiCheck.issues.some(issue => issue.includes("ci.commands")), `invalid ci.commands must fail closed: ${JSON.stringify(commands)}`);
}

fs.writeFileSync(path.join(root, "doclint.json"), JSON.stringify({
  ...readJson(root, "doclint.json"),
  docsDir: "wrong-docs",
}, null, 2) + "\n", "utf-8");
const drift = checkConfig(root);
assert(drift.ok, "legacy compatibility drift should not fail config check");
assert(drift.drift.length === 0, "historical injected files must not be read even for drift diagnostics");
assert(!drift.display.body.includes("Config drift"), "ignored historical injections must not appear in config output");

const mismatchRoot = tempRoot();
fs.writeFileSync(path.join(mismatchRoot, "codelint.json"), JSON.stringify({ codeExt: ".ts", codeDirs: ["src"] }, null, 2) + "\n", "utf-8");
const mismatch = checkConfig(mismatchRoot);
assert(mismatch.ok, "authority-free config check should use detected defaults without consulting legacy files");
assert(mismatch.requires_user === false && mismatch.stop_here === false, "authority-free detection should not add a user gate");
assert(mismatch.suggestedCommand.includes("--code-ext .py"), "suggested command should include the detected Python extension in a platform-neutral form");
assert(mismatch.issues.length === 0, "missing unselected project config should not be reported");
const mismatchCli = runConfigCli(["--check", "--json"], mismatchRoot);
assert(mismatchCli.exitCode === 0, "config CLI should pass using detected authority");
assert(JSON.parse(mismatchCli.stdout).ok === true, "config CLI should preserve the detected ok envelope");
assert(!fs.existsSync(projectPaths(mismatchRoot).config), "config check failure must not establish an external authority marker");

const unsafeRoot = tempRoot();
fs.writeFileSync(path.join(unsafeRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: "dev;touch${IFS}/tmp/x", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"] },
}, null, 2) + "\n", "utf-8");
markProjectAuthority(unsafeRoot);
const unsafe = checkConfig(unsafeRoot);
assert(!unsafe.ok, "unsafe baseBranch should fail config check");
assert(unsafe.issues.some(issue => issue.includes("project.baseBranch is not a safe Git branch name")), "unsafe baseBranch should be reported");
const portable = buildSuggestedCommand({ codeExt: ".py", codeDirs: ["src;touch${IFS}/tmp/x"], lintDirs: ["src"], docsDir: "docs", baseBranch: "dev;touch${IFS}/tmp/x", maxCodeLines: 500, maxDocLines: 200 }, true);
assert(portable.includes("--code-dirs INVALID_CODE_DIRS"), `unsafe code dirs must be replaced instead of shell-quoted: ${portable}`);
assert(portable.includes("--base-branch INVALID_BASE_BRANCH"), `unsafe base branch must be replaced instead of shell-quoted: ${portable}`);
assert(!portable.includes("touch${IFS}"), "suggested commands must not echo unsafe payloads on any platform");

const malformedRoot = tempRoot();
fs.writeFileSync(path.join(malformedRoot, "hy-workflow.json"), "{ bad json\n", "utf-8");
markProjectAuthority(malformedRoot);
const malformed = checkConfig(malformedRoot);
assert(!malformed.ok, "malformed unified config should fail config check");
assert(malformed.issues.some(issue => issue.includes("hy-workflow.json is not valid config JSON")), "malformed unified config should be a structured issue");
const malformedCli = runConfigCli(["--check", "--json"], malformedRoot);
assert(malformedCli.exitCode === 1, "malformed config CLI check should exit nonzero");

const invalidTypesRoot = tempRoot();
fs.writeFileSync(path.join(invalidTypesRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: 123, codeExt: ".py", codeDirs: "src", docsDir: ["docs"] },
  codelint: { lintDirs: "src", maxLines: "500" },
  doclint: { maxLines: "200" },
}, null, 2) + "\n", "utf-8");
markProjectAuthority(invalidTypesRoot);
const invalidTypes = checkConfig(invalidTypesRoot);
assert(!invalidTypes.ok, "invalid unified config field types should fail config check");
assert(invalidTypes.issues.some(issue => issue.includes("project.baseBranch must be a string")), "numeric baseBranch should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("project.codeDirs must be an array of strings")), "string codeDirs should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("project.docsDir must be a string")), "array docsDir should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("codelint.maxLines must be a finite number")), "string codelint maxLines should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("doclint.maxLines must be a finite number")), "string doclint maxLines should be reported");

const thresholdRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const thresholdConfig = readJson(thresholdRoot, "hy-workflow.json");
delete thresholdConfig.codelint.maxLines;
delete thresholdConfig.doclint.maxLines;
thresholdConfig.codelint.maxLinesWarning = 500;
thresholdConfig.codelint.maxLinesError = 1200;
thresholdConfig.doclint.maxLinesWarning = 200;
thresholdConfig.doclint.maxLinesError = 500;
fs.writeFileSync(path.join(thresholdRoot, "hy-workflow.json"), JSON.stringify(thresholdConfig, null, 2) + "\n", "utf-8");
assert(checkConfig(thresholdRoot).ok, "project-specific warning and error threshold overrides should validate independently of the 300/500 defaults");

const invalidThresholdConfig = readJson(thresholdRoot, "hy-workflow.json");
invalidThresholdConfig.doclint.maxLinesWarning = 501;
fs.writeFileSync(path.join(thresholdRoot, "hy-workflow.json"), JSON.stringify(invalidThresholdConfig, null, 2) + "\n", "utf-8");
assert(checkConfig(thresholdRoot).issues.some(issue => issue.includes("doclint.maxLinesWarning must not exceed doclint.maxLinesError")), "warning thresholds above errors must fail closed");

const conflictingLegacyRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const conflictingLegacyConfig = readJson(conflictingLegacyRoot, "hy-workflow.json");
conflictingLegacyConfig.codelint.maxLinesError = conflictingLegacyConfig.codelint.maxLines + 1;
fs.writeFileSync(path.join(conflictingLegacyRoot, "hy-workflow.json"), JSON.stringify(conflictingLegacyConfig, null, 2) + "\n", "utf-8");
assert(checkConfig(conflictingLegacyRoot).issues.some(issue => issue.includes("must equal legacy codelint.maxLines")), "conflicting legacy and explicit hard thresholds must not be silently reinterpreted");

const tierRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n", "src/api/index.py": "value = 1\n", "src/core/index.py": "value = 1\n" });
const tierConfig = readJson(tierRoot, "hy-workflow.json");
tierConfig.codelint.tiers = [
  { name: "api", paths: ["src/api"] },
  { name: "core", paths: ["src/core"] },
];
fs.writeFileSync(path.join(tierRoot, "hy-workflow.json"), JSON.stringify(tierConfig, null, 2) + "\n", "utf-8");
assert(checkConfig(tierRoot).ok, "unique non-overlapping high-to-low tiers should validate");

const overlappingTiers = readJson(tierRoot, "hy-workflow.json");
overlappingTiers.codelint.tiers = [
  { name: "api", paths: ["src"] },
  { name: "api", paths: ["src/core"] },
];
fs.writeFileSync(path.join(tierRoot, "hy-workflow.json"), JSON.stringify(overlappingTiers, null, 2) + "\n", "utf-8");
const tierIssues = checkConfig(tierRoot).issues;
assert(tierIssues.some(issue => issue.includes("names must be unique")), "tier names must be globally unique");
assert(tierIssues.some(issue => issue.includes("paths must not duplicate or overlap")), "tier paths must be globally non-overlapping");

const invalidApplyRoot = tempRoot();
const invalidApply = runConfigCli(["--apply-suggested", "--json", "--base-branch", "dev;touch"], invalidApplyRoot);
assert(invalidApply.exitCode === 1, "invalid apply should exit nonzero");
assert(!exists(invalidApplyRoot, "hy-workflow.json"), "invalid apply should not write hy-workflow.json");
assert(!fs.existsSync(projectPaths(invalidApplyRoot).config), "invalid apply should not write local config");

const legacyLocalRoot = tempRoot();
const legacyLocalPath = projectPaths(legacyLocalRoot).config;
fs.mkdirSync(path.dirname(legacyLocalPath), { recursive: true });
fs.writeFileSync(legacyLocalPath, JSON.stringify({
  keep: { owner: "user" },
  project: { baseBranch: "main", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"], maxLines: 321 },
  doclint: { maxLines: 123 },
  docsGardener: { catalogs: { migrated: ["hy_init"] } },
}, null, 2) + "\n", "utf-8");
const legacyLocalBefore = fs.readFileSync(legacyLocalPath, "utf-8");
const legacyLocalCheck = checkConfig(legacyLocalRoot);
assert(legacyLocalCheck.ok, "config check must validate the selected complete external authority");
assert(readUnifiedConfig(legacyLocalRoot) === null, "project config reader must not reinterpret external runtime state as a project file");
const legacyResolution = resolveRuntimeConfig(legacyLocalRoot);
assert(legacyResolution.authority.kind === "external" && legacyResolution.issues.length === 0, "raw external config must remain the authority for an installed legacy deployment");
assert(legacyResolution.config.keep.owner === "user", "external runtime authority must preserve unknown values");
assert(legacyResolution.config.codelint.maxLinesError === 321 && legacyResolution.config.doclint.maxLinesError === 123, "legacy maxLines must remain the effective hard threshold");
assert(requireRuntimeConfig(legacyLocalRoot).project.baseBranch === "main", "runtime must use valid external config without migration");
assert(!exists(legacyLocalRoot, "hy-workflow.json"), "legacy runtime resolution must not create a project config");
assert(fs.readFileSync(legacyLocalPath, "utf-8") === legacyLocalBefore, "legacy runtime resolution must not rewrite external config");
const explicitLegacyReplacement = runConfigCli(["--apply", "--json", "--base-branch", "release/new"], legacyLocalRoot);
assert(explicitLegacyReplacement.exitCode === 0, `explicit config apply should update the complete external authority: ${explicitLegacyReplacement.stdout}`);
const updatedLegacyExternal = JSON.parse(fs.readFileSync(legacyLocalPath, "utf-8"));
assert(updatedLegacyExternal.project.baseBranch === "release/new" && updatedLegacyExternal.keep.owner === "user", "successful explicit apply must update the full external config while preserving unknown fields");
assert(!exists(legacyLocalRoot, "hy-workflow.json"), "external config apply must not create a project authority file");
assert(requireRuntimeConfig(legacyLocalRoot).project.baseBranch === "release/new", "updated external authority must become effective immediately");

const missingRuntimeRoot = tempRoot();
fs.writeFileSync(path.join(missingRuntimeRoot, "codelint.json"), JSON.stringify({
  baseBranch: "legacy-main", codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"],
}, null, 2) + "\n", "utf-8");
const missingRuntimeCompat = fs.readFileSync(path.join(missingRuntimeRoot, "codelint.json"), "utf-8");
const missingRuntimeResolution = resolveRuntimeConfig(missingRuntimeRoot);
assert(missingRuntimeResolution.authority.kind === "legacy-detected" && missingRuntimeResolution.issues.length === 0, "installed project without external config must use read-only detection");
assert(missingRuntimeResolution.config.policy.profile === "legacy-compatible", "detection fallback must use frozen historical policy defaults");
assert(missingRuntimeResolution.config.codelint.maxLinesWarning === 300 && missingRuntimeResolution.config.codelint.maxLinesError === 500, "legacy detection must retain historical code thresholds");
assert(missingRuntimeResolution.config.doclint.maxLinesWarning === 200 && missingRuntimeResolution.config.doclint.maxLinesError === 500, "legacy detection must retain historical document thresholds");
assert(requireRuntimeConfig(missingRuntimeRoot).project.codeExt === ".py", "detection fallback must provide runtime project parameters without setup");
assert(fs.readFileSync(path.join(missingRuntimeRoot, "codelint.json"), "utf-8") === missingRuntimeCompat, "runtime config reads must not mutate legacy compatibility files");
assert(!exists(missingRuntimeRoot, "doclint.json") && !exists(missingRuntimeRoot, "docs-gardener.json"), "runtime config reads must not materialize compatibility files");

const incompleteRuntimeRoot = tempRoot();
fs.writeFileSync(path.join(incompleteRuntimeRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: "main", docsDir: "docs" },
}, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(incompleteRuntimeRoot, "codelint.json"), JSON.stringify({
  codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"],
}, null, 2) + "\n", "utf-8");
assert(readUnifiedConfig(incompleteRuntimeRoot) === null, "runtime config reads must reject root config with missing required fields");
const incompleteRuntimeResolution = resolveRuntimeConfig(incompleteRuntimeRoot);
assert(incompleteRuntimeResolution.authority.kind === "legacy-detected" && incompleteRuntimeResolution.issues.length === 0, "unmarked historical root config must be ignored rather than block runtime");
assert(requireRuntimeConfig(incompleteRuntimeRoot).project.codeExt === ".py", "ignored historical root must be replaced by detected runtime parameters");
const incompleteRuntimeCheck = checkConfig(incompleteRuntimeRoot);
assert(incompleteRuntimeCheck.ok && incompleteRuntimeCheck.issues.length === 0, "config check must ignore an unselected incomplete root injection");
const incompleteRootBefore = fs.readFileSync(path.join(incompleteRuntimeRoot, "hy-workflow.json"), "utf-8");
const incompleteRuntimeApply = runConfigCli(["--apply", "--json"], incompleteRuntimeRoot);
assert(incompleteRuntimeApply.exitCode === 0, `external config apply should complete: ${incompleteRuntimeApply.stdout}`);
assert(fs.readFileSync(path.join(incompleteRuntimeRoot, "hy-workflow.json"), "utf-8") === incompleteRootBefore, "config apply must preserve the unselected incomplete root injection byte-for-byte");
const recoveredIncompleteRuntime = JSON.parse(fs.readFileSync(projectPaths(incompleteRuntimeRoot).config, "utf-8"));
assert(recoveredIncompleteRuntime.project.baseBranch === "dev", "external config apply must use detected project facts instead of the orphan root injection");
assert(recoveredIncompleteRuntime.project.codeExt && recoveredIncompleteRuntime.project.codeDirs.length > 0 && recoveredIncompleteRuntime.codelint.lintDirs.length > 0, "preserve-first recovery must fill every runtime-required field");

const missingBaseBranchRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const missingBaseBranchConfig = readJson(missingBaseBranchRoot, "hy-workflow.json");
delete missingBaseBranchConfig.project.baseBranch;
fs.writeFileSync(path.join(missingBaseBranchRoot, "hy-workflow.json"), JSON.stringify(missingBaseBranchConfig, null, 2) + "\n", "utf-8");
const missingBaseBranchCheck = checkConfig(missingBaseBranchRoot);
assert(!missingBaseBranchCheck.ok && missingBaseBranchCheck.issues.some(issue => issue.includes("project.baseBranch is required at runtime")), "config check must not default a missing runtime baseBranch");

const primaryPrecedenceRoot = tempRoot();
fs.writeFileSync(path.join(primaryPrecedenceRoot, "hy-workflow.json"), JSON.stringify({
  project: { codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
  codelint: {},
  doclint: {},
  docsGardener: { catalogs: { root: ["hy_init"] } },
}, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(primaryPrecedenceRoot, "codelint.json"), JSON.stringify({
  baseBranch: "stale-branch", lintDirs: ["stale-src"], maxLines: 17,
}, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(primaryPrecedenceRoot, "doclint.json"), JSON.stringify({ maxLines: 19 }, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(primaryPrecedenceRoot, "docs-gardener.json"), JSON.stringify({ catalogs: { stale: ["wrong"] } }, null, 2) + "\n", "utf-8");
markProjectAuthority(primaryPrecedenceRoot);
const primaryCandidate = ensureConfigDefaults(primaryPrecedenceRoot, { dryRun: true });
assert(primaryCandidate.ok, `valid root config should ignore stale compatibility values: ${primaryCandidate.issues.join(", ")}`);
assert(primaryCandidate.candidate?.project.baseBranch === "dev" && primaryCandidate.candidate?.codelint.lintDirs.join(",") === "src", "root config defaults must not be backfilled from stale compatibility fields");
assert(primaryCandidate.candidate?.codelint.maxLinesWarning === 300 && primaryCandidate.candidate?.codelint.maxLinesError === 500, "code line limits must use canonical defaults rather than stale compatibility values");
assert(primaryCandidate.candidate?.doclint.maxLinesWarning === 200 && primaryCandidate.candidate?.doclint.maxLinesError === 500, "doc line limits must use canonical defaults rather than stale compatibility values");
assert(primaryCandidate.candidate?.docsGardener.catalogs.root[0] === "hy_init" && !primaryCandidate.candidate?.docsGardener.catalogs.stale, "root catalogs must not be influenced by stale compatibility catalogs");

const malformedCompatRoot = tempRoot();
fs.writeFileSync(path.join(malformedCompatRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: "main", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"], maxLines: 321 },
  doclint: { maxLines: 123 },
  docsGardener: { catalogs: {} },
}, null, 2) + "\n", "utf-8");
const malformedCompatText = "{ invalid compatibility json\n";
fs.writeFileSync(path.join(malformedCompatRoot, "codelint.json"), malformedCompatText, "utf-8");
markProjectAuthority(malformedCompatRoot);
const malformedCompatSetup = ensureConfigDefaults(malformedCompatRoot);
assert(malformedCompatSetup.ok, `valid primary config should not be blocked by malformed compatibility JSON: ${malformedCompatSetup.issues.join(", ")}`);
assert(fs.readFileSync(path.join(malformedCompatRoot, "codelint.json"), "utf-8") === malformedCompatText, "setup config must not rewrite malformed compatibility artifacts when root config is valid");

const poisonedLegacyRoot = tempRoot();
fs.writeFileSync(path.join(poisonedLegacyRoot, "hy-workflow.json"), "{ poisoned historical injection\n", "utf-8");
const poisonedResolution = resolveRuntimeConfig(poisonedLegacyRoot);
assert(poisonedResolution.authority.kind === "legacy-detected" && poisonedResolution.issues.length === 0, "absent authority signal must not parse a poisoned historical root injection");
assert(poisonedResolution.config.policy.profile === "legacy-compatible", "poisoned legacy project must retain frozen compatibility policy");

const markedProjectRoot = configuredRoot(".py", { "src/app.py": "print('marked')\n" });
const markedConfig = readJson(markedProjectRoot, "hy-workflow.json");
markedConfig.project.baseBranch = "marked-main";
fs.writeFileSync(path.join(markedProjectRoot, "hy-workflow.json"), JSON.stringify(markedConfig, null, 2) + "\n");
const markedResolution = resolveRuntimeConfig(markedProjectRoot);
assert(markedResolution.authority.kind === "project" && markedResolution.config.project.baseBranch === "marked-main", "exact external marker must select the new project-owned config");

const ciSignalRoot = configuredRoot(".py", { "src/app.py": "print('ci')\n" });
fs.rmSync(projectPaths(ciSignalRoot).config);
const previousSignal = process.env[RUNTIME_CONFIG_SOURCE_ENV];
process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;
const signaledResolution = resolveRuntimeConfig(ciSignalRoot);
assert(signaledResolution.authority.kind === "project" && signaledResolution.issues.length === 0, "exact new-workflow CI signal must select root config on a clean runner");
process.env[RUNTIME_CONFIG_SOURCE_ENV] = "wrong-version";
const wrongSignalResolution = resolveRuntimeConfig(ciSignalRoot);
assert(wrongSignalResolution.authority.kind === "legacy-detected", "unknown CI signal must not select or inspect root config");
if (previousSignal === undefined) delete process.env[RUNTIME_CONFIG_SOURCE_ENV];
else process.env[RUNTIME_CONFIG_SOURCE_ENV] = previousSignal;

const projectedBaseRoot = tempRoot();
fs.writeFileSync(path.join(projectedBaseRoot, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "release/base" } }, null, 2) + "\n");
process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;
assert(requireRuntimeBaseBranch(projectedBaseRoot) === "release/base", "baseBranch projection must not be blocked by unrelated full-config fields");
let projectedFullError: any = null;
try { requireRuntimeConfig(projectedBaseRoot); } catch (error) { projectedFullError = error; }
assert(projectedFullError?.code === "ROOT_CONFIG_INVALID", "full runtime config must remain strict when the baseBranch projection succeeds");
assert(projectedFullError?.detail?.issues?.some((issue: string) => issue.includes("project.codeExt is required at runtime")), "full runtime config must still report unrelated required fields");

const unsafeProjectedBase = readJson(projectedBaseRoot, "hy-workflow.json");
unsafeProjectedBase.project.baseBranch = "../unsafe";
fs.writeFileSync(path.join(projectedBaseRoot, "hy-workflow.json"), JSON.stringify(unsafeProjectedBase, null, 2) + "\n");
let unsafeProjectedError: any = null;
try { requireRuntimeBaseBranch(projectedBaseRoot); } catch (error) { unsafeProjectedError = error; }
assert(unsafeProjectedError?.code === "ROOT_CONFIG_INVALID" && unsafeProjectedError?.detail?.issues?.length === 1, "baseBranch projection must reject an unsafe ref without unrelated config issues");
assert(unsafeProjectedError.detail.issues[0].includes("not a safe Git branch name"), "baseBranch projection must identify the unsafe ref");
if (previousSignal === undefined) delete process.env[RUNTIME_CONFIG_SOURCE_ENV];
else process.env[RUNTIME_CONFIG_SOURCE_ENV] = previousSignal;

const missingSignaledRoot = tempRoot();
process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;
let missingSignaledError: any = null;
try { requireRuntimeConfig(missingSignaledRoot); } catch (error) { missingSignaledError = error; }
assert(missingSignaledError?.code === "ROOT_CONFIG_REQUIRED" && missingSignaledError?.message.includes("required"), "selected new-project authority with no root config must report a required config rather than an invalid config");
let missingSignaledBaseError: any = null;
try { requireRuntimeBaseBranch(missingSignaledRoot); } catch (error) { missingSignaledBaseError = error; }
assert(missingSignaledBaseError?.code === "ROOT_CONFIG_REQUIRED", "baseBranch projection must preserve missing selected-source classification");
if (previousSignal === undefined) delete process.env[RUNTIME_CONFIG_SOURCE_ENV];
else process.env[RUNTIME_CONFIG_SOURCE_ENV] = previousSignal;

const invalidExternalRoot = tempRoot();
const invalidExternalPath = projectPaths(invalidExternalRoot).config;
fs.mkdirSync(path.dirname(invalidExternalPath), { recursive: true });
fs.writeFileSync(invalidExternalPath, JSON.stringify({ project: {} }) + "\n");
const invalidExternalResolution = resolveRuntimeConfig(invalidExternalRoot);
assert(invalidExternalResolution.authority.kind === "external" && invalidExternalResolution.issues.length > 0, "selected invalid external config must block explicitly");
let invalidExternalError: any = null;
try { requireRuntimeConfig(invalidExternalRoot); } catch (error) { invalidExternalError = error; }
assert(invalidExternalError?.code === "ROOT_CONFIG_INVALID" && invalidExternalError?.detail?.source === invalidExternalPath, "invalid external authority must throw a structured error naming its source");

const policyRoot = configuredRoot(".ts", { "src/app.ts": "export {};\n" });
const validPolicy = readJson(policyRoot, "hy-workflow.json");
validPolicy.$schema = PROJECT_CONFIG_SCHEMA_URL;
validPolicy.version = 1;
validPolicy.policy = {
  profile: "standard",
  rules: { "code.max-lines": { warning: 600, error: 1200 } },
  overrides: [{ files: ["test/**"], rules: { "code.max-lines": { severity: "warning", warning: 1000, error: 2000 } } }],
  exceptions: [{ rule: "code.max-lines", files: ["src/legacy.ts"], reason: "Tracked debt", owner: "platform", issue: "#421", expires: "2026-01-01" }],
};
fs.writeFileSync(path.join(policyRoot, "hy-workflow.json"), JSON.stringify(validPolicy, null, 2) + "\n");
assert(checkConfig(policyRoot).ok, "expired but well-formed policy exception remains valid config and is ignored only during effective resolution");
const explainedPolicy = runConfigCli(["--explain-policy", "code.max-lines", "--file", "test/example.ts", "--json"], policyRoot);
const explainedPayload = JSON.parse(explainedPolicy.stdout);
assert(explainedPolicy.exitCode === 0 && explainedPayload.authority.kind === "project", "policy explanation must use the explicitly selected runtime authority");
assert(explainedPayload.explanation.effective.warning === 1000 && explainedPayload.explanation.effective.error === 2000, "policy explanation must return the effective path-specific values");
assert(explainedPayload.explanation.sources.map((item: any) => item.layer).join(",") === "profile,legacy,project,override", "policy explanation must distinguish every ordered precedence source");
for (const unsafeFile of ["../outside.ts", path.resolve(policyRoot, "outside.ts")]) {
  const unsafeExplanation = runConfigCli(["--explain-policy", "code.max-lines", "--file", unsafeFile, "--json"], policyRoot);
  const unsafePayload = JSON.parse(unsafeExplanation.stdout);
  assert(unsafeExplanation.exitCode === 1 && unsafePayload.issues.some((issue: string) => issue.includes("safe project-relative path")), `policy explanation must reject unsafe file path ${unsafeFile}`);
}
validPolicy.policy.rules["workflow.project-identity"] = { severity: "off" };
fs.writeFileSync(path.join(policyRoot, "hy-workflow.json"), JSON.stringify(validPolicy, null, 2) + "\n");
assert(checkConfig(policyRoot).issues.some(issue => issue.includes("immutable safety invariant")), "project config must not disable immutable safety invariants");
delete validPolicy.policy.rules["workflow.project-identity"];
validPolicy.policy.profile = "legacy-compatible";
fs.writeFileSync(path.join(policyRoot, "hy-workflow.json"), JSON.stringify(validPolicy, null, 2) + "\n");
assert(checkConfig(policyRoot).issues.some(issue => issue.includes("policy.profile")), "internal legacy-compatible profile must not be project-selectable");

const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/hy-workflow.schema.json"), "utf-8"));
const schemaPath = new RegExp(schema.$defs.path.pattern);
const schemaGlob = new RegExp(schema.$defs.glob.pattern);
for (const unsafe of ["../outside", "src/../outside", "/absolute", "-command", "src\\escape"]) {
  assert(!schemaPath.test(unsafe), `schema path must reject unsafe value ${unsafe}`);
  assert(!schemaGlob.test(unsafe), `schema glob must reject unsafe value ${unsafe}`);
}
assert(schemaPath.test("docs/guide") && schemaGlob.test("docs/**"), "schema safety patterns must retain ordinary project-relative paths and globs");
assert(!schemaAllowsRuleValue(schema, "docs.links", { warning: 10 }), "schema must reject line thresholds on non-line quality rules");
assert(schemaAllowsRuleValue(schema, "docs.links", { severity: "warning" }), "schema must allow severity on non-line quality rules");

const unsafePolicyRoot = configuredRoot(".ts", { "src/app.ts": "export {};\n" });
const unsafePolicyConfig = readJson(unsafePolicyRoot, "hy-workflow.json");
unsafePolicyConfig.project.docsDir = "../outside";
unsafePolicyConfig.policy = {
  profile: "standard",
  rules: { "docs.links": { warning: 10 } },
  overrides: [{ files: ["src/../outside"], rules: { "docs.links": { severity: "warning" } } }],
};
fs.writeFileSync(path.join(unsafePolicyRoot, "hy-workflow.json"), JSON.stringify(unsafePolicyConfig, null, 2) + "\n");
const unsafePolicyIssues = checkConfig(unsafePolicyRoot).issues;
assert(unsafePolicyIssues.some(issue => issue.includes("project.docsDir is not a safe relative path")), "runtime validation must reject the same unsafe project path as the schema");
assert(unsafePolicyIssues.some(issue => issue.includes("unsafe project-relative glob")), "runtime validation must reject the same unsafe policy glob as the schema");
assert(unsafePolicyIssues.some(issue => issue.includes("warning is only valid for max-lines rules")), "runtime validation must reject thresholds on non-line rules like the schema");

const unknownArg = runConfigCli(["--json", "--unknown"], tempRoot());
assert(unknownArg.exitCode === 1, "unknown config flags should exit nonzero");
assert(JSON.parse(unknownArg.stdout).issues.some((issue: string) => issue.includes("Unknown config option: --unknown")), "unknown config flag should be reported");
const missingValue = runConfigCli(["--json", "--code-ext"], tempRoot());
assert(missingValue.exitCode === 1, "missing config flag value should exit nonzero");
assert(JSON.parse(missingValue.stdout).issues.some((issue: string) => issue.includes("Missing value for --code-ext")), "missing config flag value should be reported");

const cliRoot = tempRoot();
const cli = runConfigCli(["--apply-suggested", "--json", "--code-ext", ".py", "--code-dirs", "src", "--docs-dir", "docs", "--base-branch", "dev"], cliRoot);
const parsed = JSON.parse(cli.stdout);
assert(cli.exitCode === 0, "config CLI should exit 0");
assert(parsed.ok === true, "config CLI should emit ok envelope");
assert(parsed.display?.title, "config CLI should emit display title");
assert(!exists(cliRoot, "hy-workflow.json"), "authority-free config CLI must not create a project config");
const cliExternal = JSON.parse(fs.readFileSync(projectPaths(cliRoot).config, "utf-8"));
assert(cliExternal.project.codeExt === ".py", "config CLI should write project settings to external state");
if (process.platform !== "win32") assert((fs.statSync(projectPaths(cliRoot).config).mode & 0o777) === 0o600, "new external config must use a private 0600 mode");
assert(!exists(cliRoot, "codelint.json"), "config CLI should not write root codelint compatibility file");
assert(!exists(cliRoot, "doclint.json"), "config CLI should not write root doclint compatibility file");
assert(cliExternal.codelint.maxLinesWarning === 300 && cliExternal.codelint.maxLinesError === 500, "new config must write explicit code warning and error thresholds");
assert(cliExternal.doclint.maxLinesWarning === 200 && cliExternal.doclint.maxLinesError === 500, "new config must write explicit docs warning and error thresholds");
requireRuntimeConfig(cliRoot);
assert(!exists(cliRoot, "codelint.json") && !exists(cliRoot, "doclint.json") && !exists(cliRoot, "docs-gardener.json"), "runtime config reads must not materialize compatibility files");

const help = runConfigCli(["--help"]);
assert(help.stdout.includes("hy-workflow config --check --json"), "help should explain config command");
assert(help.stdout.includes("stored externally unless an exact new marker or CI signal selects hy-workflow.json"), "help should document explicit configuration authority");
assert(!help.stdout.includes("--print-managed-rules"), "normal help must not advertise the historical AGENTS rule injection command");
const retiredRules = runConfigCli(["--print-managed-rules", "--json"], tempRoot());
const retiredRulesPayload = JSON.parse(retiredRules.stdout);
assert(retiredRules.exitCode === 1 && retiredRulesPayload.issues.some((issue: string) => issue.includes("Unknown config option: --print-managed-rules")), "historical AGENTS rule export must return the normal typed deprecated-option failure");
assert(!retiredRules.stdout.includes("hy-workflow-rules-version"), "retired rules export must never read or return AGENTS content");

const noDocsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-no-docs-"));
fs.mkdirSync(path.join(noDocsRoot, "src"), { recursive: true });
fs.writeFileSync(path.join(noDocsRoot, "package.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(noDocsRoot, "tsconfig.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(noDocsRoot, "src", "index.ts"), "export {};\n", "utf-8");
const noDocs = checkConfig(noDocsRoot);
assert(noDocs.suggestion.docsDir === "", "config detection must not invent a missing docs directory or fall back to project root");
assert(noDocs.suggestedCommand.includes("--docs-dir existing-docs-dir") && !noDocs.suggestedCommand.includes("--docs-dir docs"), "recovery must require an explicit existing docs directory instead of emitting a failing loop");
assert(!noDocs.suggestedCommand.includes("--apply-suggested"), "missing-docs recovery must use preserving apply semantics");
const noDocsApply = runConfigCli(["--apply-suggested", "--json"], noDocsRoot);
assert(noDocsApply.exitCode === 1 && JSON.parse(noDocsApply.stdout).issues.some((issue: string) => issue.includes("no documentation directory was detected")), "apply-suggested must stop when docsDir cannot be inferred");
assert(!exists(noDocsRoot, "hy-workflow.json"), "failed no-docs apply must not write an invalid shared config");
fs.writeFileSync(path.join(noDocsRoot, "docs"), "not a directory\n", "utf-8");
const invalidExplicitDocs = runConfigCli(["--apply-suggested", "--json", "--docs-dir", "docs"], noDocsRoot);
const invalidExplicitPayload = JSON.parse(invalidExplicitDocs.stdout);
assert(invalidExplicitDocs.exitCode === 1 && invalidExplicitPayload.suggestedCommand.includes("--docs-dir existing-docs-dir"), "an explicit nonexistent docsDir must not be echoed into another guaranteed-failing recovery command");
assert(!invalidExplicitPayload.suggestedCommand.includes("--docs-dir docs"), "recovery must not repeat the nonexistent explicit docsDir");
fs.mkdirSync(path.join(noDocsRoot, "guide"));
fs.writeFileSync(path.join(noDocsRoot, "guide", "index.md"), "# Guide\n", "utf-8");
const explicitDocs = runConfigCli(["--apply", "--json", "--docs-dir", "guide"], noDocsRoot);
assert(explicitDocs.exitCode === 0 && JSON.parse(fs.readFileSync(projectPaths(noDocsRoot).config, "utf-8")).project.docsDir === "guide", "an explicit existing docsDir should recover external config");
assert(!exists(noDocsRoot, "hy-workflow.json"), "docs recovery must not create project authority without an exact marker");

const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-real-case-"));
fs.mkdirSync(path.join(caseRoot, "Src"), { recursive: true });
fs.mkdirSync(path.join(caseRoot, "Docs"), { recursive: true });
fs.writeFileSync(path.join(caseRoot, "Docs", "index.md"), "# Docs\n", "utf-8");
fs.writeFileSync(path.join(caseRoot, "package.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(caseRoot, "tsconfig.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(caseRoot, "Src", "index.ts"), "export {};\n", "utf-8");
const realCase = runConfigCli(["--dry-run", "--json"], caseRoot);
const realCasePayload = JSON.parse(realCase.stdout);
assert(realCase.exitCode === 0, `real-casing config detection should succeed: ${realCasePayload.issues?.join(", ") ?? ""}`);
assert(realCasePayload.suggestion.codeDirs.join(",") === "Src" && realCasePayload.suggestion.lintDirs.join(",") === "Src", "code and lint suggestions must preserve the on-disk Src casing");
assert(realCasePayload.suggestion.docsDir === "Docs", "docs suggestion must preserve the on-disk Docs casing");
assert(!fs.existsSync(projectPaths(caseRoot).config), "config dry-run must not establish an external authority marker");

if (process.platform !== "win32") {
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-symlink-dirs-"));
  fs.mkdirSync(path.join(symlinkRoot, "real-src"));
  fs.mkdirSync(path.join(symlinkRoot, "real-docs"));
  fs.writeFileSync(path.join(symlinkRoot, "real-docs", "index.md"), "# Docs\n", "utf-8");
  fs.symlinkSync("real-src", path.join(symlinkRoot, "Src"), "dir");
  fs.symlinkSync("real-docs", path.join(symlinkRoot, "Docs"), "dir");
  fs.writeFileSync(path.join(symlinkRoot, "package.json"), "{}\n", "utf-8");
  fs.writeFileSync(path.join(symlinkRoot, "tsconfig.json"), "{}\n", "utf-8");
  fs.writeFileSync(path.join(symlinkRoot, "Src", "index.ts"), "export {};\n", "utf-8");
  const symlinkDirs = runConfigCli(["--dry-run", "--json"], symlinkRoot);
  const symlinkDirsPayload = JSON.parse(symlinkDirs.stdout);
  assert(symlinkDirs.exitCode === 0, `symlinked directory detection should succeed: ${symlinkDirsPayload.issues?.join(", ") ?? ""}`);
  assert(symlinkDirsPayload.suggestion.codeDirs.join(",") === "Src" && symlinkDirsPayload.suggestion.lintDirs.join(",") === "Src", "symlinked code directories must keep their entry casing");
  assert(symlinkDirsPayload.suggestion.docsDir === "Docs", "symlinked docs directories must remain valid and keep their entry casing");

  const escapeRoot = tempRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-outside-"));
  fs.rmSync(path.join(escapeRoot, "docs"), { recursive: true });
  fs.symlinkSync(outside, path.join(escapeRoot, "docs"), "dir");
  fs.writeFileSync(path.join(escapeRoot, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"] },
  }, null, 2) + "\n");
  markProjectAuthority(escapeRoot);
  const escapedDocs = checkConfig(escapeRoot);
  assert(!escapedDocs.ok && escapedDocs.issues.some(issue => issue.includes("project.docsDir")), "docsDir symlink escaping the project must fail closed");

  const linkedConfigRoot = tempRoot();
  const outsideConfig = path.join(outside, "hy-workflow.json");
  const outsideContent = JSON.stringify({ owner: "outside" }) + "\n";
  fs.writeFileSync(outsideConfig, outsideContent);
  fs.symlinkSync(outsideConfig, path.join(linkedConfigRoot, "hy-workflow.json"));
  const linkedConfigCheck = checkConfig(linkedConfigRoot);
  assert(linkedConfigCheck.ok && linkedConfigCheck.issues.length === 0, "unselected root config symlink must be ignored without being opened");
  const linkedConfigApply = runConfigCli(["--apply-suggested", "--json"], linkedConfigRoot);
  assert(linkedConfigApply.exitCode === 0, "config apply must use external state instead of following an orphan root symlink");
  assert(fs.readFileSync(outsideConfig, "utf-8") === outsideContent, "config apply must not read or modify the orphan symlink target");

}

const customDocsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-custom-docs-"));
for (const dir of ["custom-src", "custom-lint"]) fs.mkdirSync(path.join(customDocsRoot, dir), { recursive: true });
fs.writeFileSync(path.join(customDocsRoot, "package.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(customDocsRoot, "custom-src", "main.tksp"), "module demo\n", "utf-8");
fs.writeFileSync(path.join(customDocsRoot, "hy-workflow.json"), JSON.stringify({
  keep: { owner: "team" },
  project: { baseBranch: "release/team", codeExt: ".tksp", codeDirs: ["custom-src"], docsDir: "missing-docs" },
  codelint: { lintDirs: ["custom-lint"], maxLines: 731 },
  doclint: { maxLines: 149 },
  docsGardener: { catalogs: { custom: ["hy_init"] } },
}, null, 2) + "\n", "utf-8");
markProjectAuthority(customDocsRoot);
const customDocsCheck = checkConfig(customDocsRoot);
assert(!customDocsCheck.ok, "a missing custom docsDir should require recovery");
assert(customDocsCheck.suggestedCommand === "hy-workflow config --apply --json --docs-dir existing-docs-dir", "existing config recovery should only request docsDir and preserve every other field");
fs.mkdirSync(path.join(customDocsRoot, "handbook"));
fs.writeFileSync(path.join(customDocsRoot, "handbook", "index.md"), "# Handbook\n", "utf-8");
const customDocsApply = runConfigCli(["--apply", "--json", "--docs-dir", "handbook"], customDocsRoot);
assert(customDocsApply.exitCode === 0, "preserving docsDir recovery should succeed");
const customDocsAfter = readJson(customDocsRoot, "hy-workflow.json");
assert(customDocsAfter.project.docsDir === "handbook", "preserving recovery should update docsDir");
assert(customDocsAfter.project.baseBranch === "release/team" && customDocsAfter.project.codeExt === ".tksp" && customDocsAfter.project.codeDirs.join(",") === "custom-src", "preserving recovery must keep custom project fields");
assert(customDocsAfter.codelint.lintDirs.join(",") === "custom-lint" && customDocsAfter.codelint.maxLines === 731 && customDocsAfter.doclint.maxLines === 149, "preserving recovery must keep lint and line-limit fields");
assert(customDocsAfter.keep.owner === "team" && customDocsAfter.docsGardener.catalogs.custom[0] === "hy_init", "preserving recovery must keep unknown fields and catalogs");

const tkspRoot = configuredRoot(".tksp", { "src/main.tksp": "module demo\n" });
const tkspCheck = checkConfig(tkspRoot);
assert(tkspCheck.ok, `.tksp config should be accepted: ${tkspCheck.issues.join(", ")}`);

const tkspTsRoot = configuredRoot([".tksp", ".ts"], { "src/main.tksp": "module demo\n", "src/index.ts": "export {};\n" });
const tkspTsCheck = checkConfig(tkspTsRoot);
assert(tkspTsCheck.ok, `.tksp + .ts array config should be accepted: ${tkspTsCheck.issues.join(", ")}`);
assert(Array.isArray(readJson(tkspTsRoot, "hy-workflow.json").project.codeExt), "unified config should preserve array codeExt");

const commaRoot = configuredRoot(".tksp,.ts", { "src/main.tksp": "module demo\n", "src/index.ts": "export {};\n" });
const commaCheck = checkConfig(commaRoot);
assert(commaCheck.ok, `.tksp,.ts comma config should be accepted: ${commaCheck.issues.join(", ")}`);

const inferredTkspRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-infer-tksp-"));
fs.mkdirSync(path.join(inferredTkspRoot, "src"), { recursive: true });
fs.mkdirSync(path.join(inferredTkspRoot, "docs"), { recursive: true });
fs.writeFileSync(path.join(inferredTkspRoot, "docs", "index.md"), "# Docs\n", "utf-8");
fs.writeFileSync(path.join(inferredTkspRoot, "src", "main.tksp"), "module demo\n", "utf-8");
const inferredTksp = runConfigCli(["--dry-run", "--json"], inferredTkspRoot);
assert(JSON.parse(inferredTksp.stdout).suggestion.codeExt === ".tksp", "dry-run should suggest .tksp for tksp-only projects");
