import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { buildSuggestedCommand, checkConfig, ensureConfigDefaults, readUnifiedConfig, runConfigCli, withRuntimeCompatConfigs } from "../../src/config.js";
import { projectPaths } from "../../src/runtime/user-paths.js";

const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(runtimeHome, "cache");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
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

function configuredRoot(codeExt: string | string[], files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-custom-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
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
  return root;
}

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
assert(exists(root, "hy-workflow.json"), "default config must write the shared project config");
assert(readJson(root, "hy-workflow.json").project.baseBranch === "main", "setup defaults must derive unified baseBranch from legacy config");
assert(readJson(root, "hy-workflow.json").project.docsDir === "docs", "setup defaults must write the detected docsDir");
assert(readJson(root, "hy-workflow.json").codelint.lintDirs[0] === "src", "setup defaults must write shared codelint settings");
assert(readJson(root, "hy-workflow.json").doclint.maxLines === 180, "setup defaults must preserve doclint maxLines");
assert(readJson(root, "hy-workflow.json").docsGardener.catalogs.cli[0] === "hy_init", "setup defaults must preserve catalogs");
assert(!fs.existsSync(projectPaths(root).config), "new setup must not create a user-local project config");
assert(readJson(root, "codelint.json").codeExt === ".py", "setup defaults must not overwrite existing legacy codelint");

const check = checkConfig(root);
assert(check.ok, `Python config should be consistent: ${check.issues.join(", ")}`);

fs.writeFileSync(path.join(root, "doclint.json"), JSON.stringify({
  ...readJson(root, "doclint.json"),
  docsDir: "wrong-docs",
}, null, 2) + "\n", "utf-8");
const drift = checkConfig(root);
assert(drift.ok, "legacy compatibility drift should not fail config check");
assert(drift.drift.some(item => item.file === "doclint.json" && item.field === "docsDir"), "drift should still be reported for diagnostics");
assert(!drift.display.body.includes("Config drift"), "drift should not be shown as blocking output when unified config is valid");

const mismatchRoot = tempRoot();
fs.writeFileSync(path.join(mismatchRoot, "codelint.json"), JSON.stringify({ codeExt: ".ts", codeDirs: ["src"] }, null, 2) + "\n", "utf-8");
const mismatch = checkConfig(mismatchRoot);
assert(!mismatch.ok, "missing unified config should need confirmation");
assert(mismatch.requires_user === true && mismatch.stop_here === true, "mismatch should stop with user confirmation");
assert(mismatch.suggestedCommand.includes("--code-ext .py"), "suggested command should include the detected Python extension in a platform-neutral form");
assert(mismatch.issues.some(issue => issue.startsWith("Missing project config:")), "missing project config should be reported");
const mismatchCli = runConfigCli(["--check", "--json"], mismatchRoot);
assert(mismatchCli.exitCode === 1, "config CLI should exit nonzero when --check emits ok false");
assert(JSON.parse(mismatchCli.stdout).ok === false, "config CLI should preserve the ok false envelope");

const unsafeRoot = tempRoot();
fs.writeFileSync(path.join(unsafeRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: "dev;touch${IFS}/tmp/x", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"] },
}, null, 2) + "\n", "utf-8");
const unsafe = checkConfig(unsafeRoot);
assert(!unsafe.ok, "unsafe baseBranch should fail config check");
assert(unsafe.issues.some(issue => issue.includes("project.baseBranch is not a safe Git branch name")), "unsafe baseBranch should be reported");
const portable = buildSuggestedCommand({ codeExt: ".py", codeDirs: ["src;touch${IFS}/tmp/x"], lintDirs: ["src"], docsDir: "docs", baseBranch: "dev;touch${IFS}/tmp/x", maxCodeLines: 500, maxDocLines: 200 }, true);
assert(portable.includes("--code-dirs INVALID_CODE_DIRS"), `unsafe code dirs must be replaced instead of shell-quoted: ${portable}`);
assert(portable.includes("--base-branch INVALID_BASE_BRANCH"), `unsafe base branch must be replaced instead of shell-quoted: ${portable}`);
assert(!portable.includes("touch${IFS}"), "suggested commands must not echo unsafe payloads on any platform");

const malformedRoot = tempRoot();
fs.writeFileSync(path.join(malformedRoot, "hy-workflow.json"), "{ bad json\n", "utf-8");
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
const invalidTypes = checkConfig(invalidTypesRoot);
assert(!invalidTypes.ok, "invalid unified config field types should fail config check");
assert(invalidTypes.issues.some(issue => issue.includes("project.baseBranch must be a string")), "numeric baseBranch should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("project.codeDirs must be an array of strings")), "string codeDirs should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("project.docsDir must be a string")), "array docsDir should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("codelint.maxLines must be a finite number")), "string codelint maxLines should be reported");
assert(invalidTypes.issues.some(issue => issue.includes("doclint.maxLines must be a finite number")), "string doclint maxLines should be reported");

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
assert(!legacyLocalCheck.ok, "legacy local config must not be accepted as the active project source before migration");
assert(legacyLocalCheck.suggestedCommand === "hy-workflow config --apply --json", "legacy local recovery must suggest a preserve-first migration instead of replacing values with detected defaults");
assert(readUnifiedConfig(legacyLocalRoot) === null, "runtime config reads must not fall back to a legacy user config before migration");
const legacyMigration = runConfigCli(["--apply", "--json"], legacyLocalRoot);
assert(legacyMigration.exitCode === 0 && exists(legacyLocalRoot, "hy-workflow.json"), "the suggested migration command should migrate a valid legacy local config to the project root");
const migrated = checkConfig(legacyLocalRoot);
assert(migrated.ok, "the migrated root config should pass validation");
assert(readUnifiedConfig(legacyLocalRoot)?.keep.owner === "user", "runtime config reads should use the migrated root config");
assert(readJson(legacyLocalRoot, "hy-workflow.json").keep.owner === "user", "local migration should preserve unknown fields");
assert(readJson(legacyLocalRoot, "hy-workflow.json").codelint.maxLines === 321, "local migration should preserve known user choices");
assert(fs.readFileSync(legacyLocalPath, "utf-8") === legacyLocalBefore, "migration should not rewrite or delete the legacy local config");

const missingRuntimeRoot = tempRoot();
fs.writeFileSync(path.join(missingRuntimeRoot, "codelint.json"), JSON.stringify({
  baseBranch: "legacy-main", codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"],
}, null, 2) + "\n", "utf-8");
const missingRuntimeCompat = fs.readFileSync(path.join(missingRuntimeRoot, "codelint.json"), "utf-8");
let missingRuntimeCalled = false;
let missingRuntimeError: any = null;
try {
  withRuntimeCompatConfigs(missingRuntimeRoot, () => { missingRuntimeCalled = true; });
} catch (error) {
  missingRuntimeError = error;
}
assert(!missingRuntimeCalled, "runtime compat callback must not execute when root config is missing");
assert(missingRuntimeError?.type === "config" && missingRuntimeError?.subtype === "config_invalid" && missingRuntimeError?.code === "ROOT_CONFIG_REQUIRED", `missing root config should throw a structured error: ${JSON.stringify(missingRuntimeError)}`);
assert(fs.readFileSync(path.join(missingRuntimeRoot, "codelint.json"), "utf-8") === missingRuntimeCompat, "missing root config must not mutate legacy compatibility files");

const incompleteRuntimeRoot = tempRoot();
fs.writeFileSync(path.join(incompleteRuntimeRoot, "hy-workflow.json"), JSON.stringify({
  project: { baseBranch: "main", docsDir: "docs" },
}, null, 2) + "\n", "utf-8");
fs.writeFileSync(path.join(incompleteRuntimeRoot, "codelint.json"), JSON.stringify({
  codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"],
}, null, 2) + "\n", "utf-8");
let incompleteRuntimeCalled = false;
let incompleteRuntimeError: any = null;
try {
  withRuntimeCompatConfigs(incompleteRuntimeRoot, () => { incompleteRuntimeCalled = true; });
} catch (error) {
  incompleteRuntimeError = error;
}
assert(!incompleteRuntimeCalled, "runtime compat callback must not execute when required root fields are missing");
assert(readUnifiedConfig(incompleteRuntimeRoot) === null, "runtime config reads must reject root config with missing required fields");
assert(incompleteRuntimeError?.code === "ROOT_CONFIG_INVALID", `incomplete root config should throw ROOT_CONFIG_INVALID: ${JSON.stringify(incompleteRuntimeError)}`);
assert(incompleteRuntimeError?.detail?.issues?.some((issue: string) => issue.includes("project.codeExt is required at runtime")), "runtime config error should identify missing project.codeExt");
assert(incompleteRuntimeError?.detail?.issues?.some((issue: string) => issue.includes("codelint.lintDirs is required at runtime")), "runtime config error should identify missing codelint.lintDirs");
const incompleteRuntimeCheck = checkConfig(incompleteRuntimeRoot);
assert(!incompleteRuntimeCheck.ok, "config check must reject root config with runtime-required fields missing");
assert(incompleteRuntimeCheck.issues.some(issue => issue.includes("project.codeExt is required at runtime")), "config check should expose missing project.codeExt");
assert(incompleteRuntimeCheck.issues.some(issue => issue.includes("codelint.lintDirs is required at runtime")), "config check should expose missing codelint.lintDirs");
assert(incompleteRuntimeCheck.suggestedCommand === "hy-workflow config --apply --json", "incomplete root config recovery must preserve existing choices instead of applying detected defaults wholesale");
const incompleteRuntimeApply = runConfigCli(["--apply", "--json"], incompleteRuntimeRoot);
assert(incompleteRuntimeApply.exitCode === 0, `preserve-first recovery should complete: ${incompleteRuntimeApply.stdout}`);
const recoveredIncompleteRuntime = readJson(incompleteRuntimeRoot, "hy-workflow.json");
assert(recoveredIncompleteRuntime.project.baseBranch === "main", "preserve-first recovery must retain the existing baseBranch");
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
const primaryCandidate = ensureConfigDefaults(primaryPrecedenceRoot, { dryRun: true });
assert(primaryCandidate.ok, `valid root config should ignore stale compatibility values: ${primaryCandidate.issues.join(", ")}`);
assert(primaryCandidate.candidate?.project.baseBranch === "dev" && primaryCandidate.candidate?.codelint.lintDirs.join(",") === "src", "root config defaults must not be backfilled from stale compatibility fields");
assert(primaryCandidate.candidate?.codelint.maxLines === 500 && primaryCandidate.candidate?.doclint.maxLines === 200, "root config line limits must use canonical defaults rather than stale compatibility values");
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
const malformedCompatSetup = ensureConfigDefaults(malformedCompatRoot);
assert(malformedCompatSetup.ok, `valid primary config should not be blocked by malformed compatibility JSON: ${malformedCompatSetup.issues.join(", ")}`);
assert(fs.readFileSync(path.join(malformedCompatRoot, "codelint.json"), "utf-8") === malformedCompatText, "setup config must not rewrite malformed compatibility artifacts when root config is valid");

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
assert(exists(cliRoot, "hy-workflow.json"), "default config CLI should write the shared project config");
assert(readJson(cliRoot, "hy-workflow.json").project.codeExt === ".py", "config CLI should write project settings to hy-workflow.json");
assert(!fs.existsSync(projectPaths(cliRoot).config), "config CLI should not create a new user-local project config");
assert(!exists(cliRoot, "codelint.json"), "config CLI should not write root codelint compatibility file");
assert(!exists(cliRoot, "doclint.json"), "config CLI should not write root doclint compatibility file");

withRuntimeCompatConfigs(cliRoot, () => {
  assert(readJson(cliRoot, "codelint.json").codeExt === ".py", "runtime compat should materialize codelint from unified config");
  assert(readJson(cliRoot, "doclint.json").codeDirs[0] === "src", "runtime compat should materialize doclint from unified config");
});
assert(!exists(cliRoot, "codelint.json"), "runtime compat should clean up generated codelint file");
assert(!exists(cliRoot, "doclint.json"), "runtime compat should clean up generated doclint file");

const staleCompatRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
fs.writeFileSync(path.join(staleCompatRoot, "codelint.json"), JSON.stringify({ codeExt: ".ts", codeDirs: ["old-src"], keep: true }, null, 2) + "\n", "utf-8");
const staleCompatBefore = fs.readFileSync(path.join(staleCompatRoot, "codelint.json"), "utf-8");
withRuntimeCompatConfigs(staleCompatRoot, () => {
  const runtime = readJson(staleCompatRoot, "codelint.json");
  assert(runtime.codeExt === ".py", "runtime compat should overwrite stale codeExt from unified config while running");
  assert(runtime.codeDirs[0] === "src", "runtime compat should overwrite stale codeDirs from unified config while running");
  assert(runtime.keep === true, "runtime compat should preserve unrelated existing compatibility fields while running");
});
assert(fs.readFileSync(path.join(staleCompatRoot, "codelint.json"), "utf-8") === staleCompatBefore, "runtime compat should restore stale existing codelint after run");

const callbackFailureRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const callbackCodelintText = "{\n  \"owner\": \"existing\"\n}\n";
fs.writeFileSync(path.join(callbackFailureRoot, "codelint.json"), callbackCodelintText, "utf-8");
const callbackFailure = new Error("runtime callback failed");
let callbackFailureCaught: unknown;
try {
  withRuntimeCompatConfigs(callbackFailureRoot, () => { throw callbackFailure; });
} catch (error) {
  callbackFailureCaught = error;
}
assert(callbackFailureCaught === callbackFailure, "runtime callback error should be rethrown after restoration");
assert(fs.readFileSync(path.join(callbackFailureRoot, "codelint.json"), "utf-8") === callbackCodelintText, "callback failure must restore an existing compat file byte-for-byte");
assert(!exists(callbackFailureRoot, "doclint.json") && !exists(callbackFailureRoot, "docs-gardener.json"), "callback failure must remove generated compat files that did not exist before the run");

const materializeFailureRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
const originalWriteFileSync = fsDefault.writeFileSync;
const materializeFailure = new Error("doclint materialization failed");
const failingPath = path.join(materializeFailureRoot, "doclint.json");
let materializeCallbackCalled = false;
let materializeFailureCaught: unknown;
let injectedFailure = false;
try {
  (fsDefault as any).writeFileSync = (...args: any[]) => {
    if (!injectedFailure && path.resolve(String(args[0])) === path.resolve(failingPath)) {
      injectedFailure = true;
      throw materializeFailure;
    }
    return (originalWriteFileSync as any)(...args);
  };
  syncBuiltinESMExports();
  withRuntimeCompatConfigs(materializeFailureRoot, () => { materializeCallbackCalled = true; });
} catch (error) {
  materializeFailureCaught = error;
} finally {
  (fsDefault as any).writeFileSync = originalWriteFileSync;
  syncBuiltinESMExports();
}
assert(materializeFailureCaught === materializeFailure, "materialization error should remain visible after earlier compat files are restored");
assert(!materializeCallbackCalled, "runtime callback must not run after partial compat materialization fails");
assert(!exists(materializeFailureRoot, "codelint.json") && !exists(materializeFailureRoot, "doclint.json") && !exists(materializeFailureRoot, "docs-gardener.json"), "partial materialization failure must restore all compat paths to their original absent state");

const restoreFailureRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
fs.writeFileSync(path.join(restoreFailureRoot, "codelint.json"), "{\n  \"owner\": \"original\"\n}\n", "utf-8");
const restoreFailure = new Error("codelint restoration failed");
let restoreWrites = 0;
let restoreFailureCaught: unknown;
try {
  (fsDefault as any).writeFileSync = (...args: any[]) => {
    if (path.resolve(String(args[0])) === path.resolve(path.join(restoreFailureRoot, "codelint.json")) && ++restoreWrites === 2) throw restoreFailure;
    return (originalWriteFileSync as any)(...args);
  };
  syncBuiltinESMExports();
  withRuntimeCompatConfigs(restoreFailureRoot, () => "ok");
} catch (error) {
  restoreFailureCaught = error;
} finally {
  (fsDefault as any).writeFileSync = originalWriteFileSync;
  syncBuiltinESMExports();
}
assert(restoreFailureCaught === restoreFailure, "a standalone restoration failure must be surfaced unchanged");
assert(!exists(restoreFailureRoot, "doclint.json") && !exists(restoreFailureRoot, "docs-gardener.json"), "one restoration failure must not prevent the other snapshots from being restored");

const combinedFailureRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
fs.writeFileSync(path.join(combinedFailureRoot, "codelint.json"), "{\n  \"owner\": \"original\"\n}\n", "utf-8");
const operationFailure = new Error("runtime operation failed");
const combinedRestoreFailure = new Error("combined restoration failed");
let combinedWrites = 0;
let combinedFailureCaught: unknown;
try {
  (fsDefault as any).writeFileSync = (...args: any[]) => {
    if (path.resolve(String(args[0])) === path.resolve(path.join(combinedFailureRoot, "codelint.json")) && ++combinedWrites === 2) throw combinedRestoreFailure;
    return (originalWriteFileSync as any)(...args);
  };
  syncBuiltinESMExports();
  withRuntimeCompatConfigs(combinedFailureRoot, () => { throw operationFailure; });
} catch (error) {
  combinedFailureCaught = error;
} finally {
  (fsDefault as any).writeFileSync = originalWriteFileSync;
  syncBuiltinESMExports();
}
assert(combinedFailureCaught instanceof AggregateError, "operation plus restoration failure must use AggregateError");
assert((combinedFailureCaught as AggregateError).errors[0] === operationFailure && (combinedFailureCaught as AggregateError).errors.includes(combinedRestoreFailure), "AggregateError must retain both the operation and restoration errors");
assert(!exists(combinedFailureRoot, "doclint.json") && !exists(combinedFailureRoot, "docs-gardener.json"), "combined failure must still restore every unaffected snapshot");

const invalidCompatRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
fs.writeFileSync(path.join(invalidCompatRoot, "codelint.json"), "{ invalid compatibility json\n", "utf-8");
const invalidCompatBefore = fs.readFileSync(path.join(invalidCompatRoot, "codelint.json"), "utf-8");
withRuntimeCompatConfigs(invalidCompatRoot, () => {
  assert(readJson(invalidCompatRoot, "codelint.json").codeExt === ".py", "runtime compat should replace invalid existing codelint while running");
});
assert(fs.readFileSync(path.join(invalidCompatRoot, "codelint.json"), "utf-8") === invalidCompatBefore, "runtime compat should restore invalid existing codelint after run");

const help = runConfigCli(["--help"]);
assert(help.stdout.includes("hy-workflow config --check --json"), "help should explain config command");
assert(help.stdout.includes("Project config is stored in hy-workflow.json"), "help should document the single shared config location");

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
const explicitDocs = runConfigCli(["--apply", "--json", "--docs-dir", "guide"], noDocsRoot);
assert(explicitDocs.exitCode === 0 && readJson(noDocsRoot, "hy-workflow.json").project.docsDir === "guide", "an explicit existing docsDir should recover setup");

const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-real-case-"));
fs.mkdirSync(path.join(caseRoot, "Src"), { recursive: true });
fs.mkdirSync(path.join(caseRoot, "Docs"), { recursive: true });
fs.writeFileSync(path.join(caseRoot, "package.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(caseRoot, "tsconfig.json"), "{}\n", "utf-8");
fs.writeFileSync(path.join(caseRoot, "Src", "index.ts"), "export {};\n", "utf-8");
const realCase = runConfigCli(["--dry-run", "--json"], caseRoot);
const realCasePayload = JSON.parse(realCase.stdout);
assert(realCase.exitCode === 0, `real-casing config detection should succeed: ${realCasePayload.issues?.join(", ") ?? ""}`);
assert(realCasePayload.suggestion.codeDirs.join(",") === "Src" && realCasePayload.suggestion.lintDirs.join(",") === "Src", "code and lint suggestions must preserve the on-disk Src casing");
assert(realCasePayload.suggestion.docsDir === "Docs", "docs suggestion must preserve the on-disk Docs casing");

if (process.platform !== "win32") {
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-symlink-dirs-"));
  fs.mkdirSync(path.join(symlinkRoot, "real-src"));
  fs.mkdirSync(path.join(symlinkRoot, "real-docs"));
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
const customDocsCheck = checkConfig(customDocsRoot);
assert(!customDocsCheck.ok, "a missing custom docsDir should require recovery");
assert(customDocsCheck.suggestedCommand === "hy-workflow config --apply --json --docs-dir existing-docs-dir", "existing config recovery should only request docsDir and preserve every other field");
fs.mkdirSync(path.join(customDocsRoot, "handbook"));
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
withRuntimeCompatConfigs(tkspRoot, () => {
  assert(readJson(tkspRoot, "codelint.json").codeExt === ".tksp", "runtime compat should preserve .tksp codeExt");
});
assert(!exists(tkspRoot, "codelint.json"), "runtime compat should clean up tksp codelint file");

const tkspTsRoot = configuredRoot([".tksp", ".ts"], { "src/main.tksp": "module demo\n", "src/index.ts": "export {};\n" });
const tkspTsCheck = checkConfig(tkspTsRoot);
assert(tkspTsCheck.ok, `.tksp + .ts array config should be accepted: ${tkspTsCheck.issues.join(", ")}`);
assert(Array.isArray(readJson(tkspTsRoot, "hy-workflow.json").project.codeExt), "unified config should preserve array codeExt");
withRuntimeCompatConfigs(tkspTsRoot, () => {
  assert(Array.isArray(readJson(tkspTsRoot, "doclint.json").codeExt), "doclint compatibility artifact should preserve array codeExt when configured that way");
});

const commaRoot = configuredRoot(".tksp,.ts", { "src/main.tksp": "module demo\n", "src/index.ts": "export {};\n" });
const commaCheck = checkConfig(commaRoot);
assert(commaCheck.ok, `.tksp,.ts comma config should be accepted: ${commaCheck.issues.join(", ")}`);

const inferredTkspRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-config-infer-tksp-"));
fs.mkdirSync(path.join(inferredTkspRoot, "src"), { recursive: true });
fs.mkdirSync(path.join(inferredTkspRoot, "docs"), { recursive: true });
fs.writeFileSync(path.join(inferredTkspRoot, "src", "main.tksp"), "module demo\n", "utf-8");
const inferredTksp = runConfigCli(["--dry-run", "--json"], inferredTkspRoot);
assert(JSON.parse(inferredTksp.stdout).suggestion.codeExt === ".tksp", "dry-run should suggest .tksp for tksp-only projects");
