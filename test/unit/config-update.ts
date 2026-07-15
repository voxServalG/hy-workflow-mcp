import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSuggestedCommand, checkConfig, ensureConfigDefaults, runConfigCli, withRuntimeCompatConfigs } from "../../src/config.js";
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

function readLocalConfig(root: string): any {
  return JSON.parse(fs.readFileSync(projectPaths(root).config, "utf-8"));
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
assert(!exists(root, "hy-workflow.json"), "default config must not write the project root");
assert(readLocalConfig(root).project.baseBranch === "main", "setup defaults must derive unified baseBranch from legacy config");
assert(readLocalConfig(root).project.docsDir === "docs", "setup defaults must write local docsDir");
assert(readLocalConfig(root).codelint.lintDirs[0] === "src", "setup defaults must write local codelint settings");
assert(readLocalConfig(root).doclint.maxLines === 180, "setup defaults must preserve doclint maxLines");
assert(readLocalConfig(root).docsGardener.catalogs.cli[0] === "hy_init", "setup defaults must preserve catalogs");
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
assert(mismatch.suggestedCommand.includes("--code-ext '.py'"), "suggested command should include detected Python ext with shell quoting");
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
const quoted = buildSuggestedCommand({ codeExt: ".py", codeDirs: ["src;touch${IFS}/tmp/x"], lintDirs: ["src"], docsDir: "docs", baseBranch: "dev;touch${IFS}/tmp/x", maxCodeLines: 500, maxDocLines: 200 }, true);
assert(quoted.includes("--code-dirs 'src;touch${IFS}/tmp/x'"), "suggested command should quote unsafe-looking code dirs");
assert(quoted.includes("--base-branch 'dev;touch${IFS}/tmp/x'"), "suggested command should quote unsafe-looking base branch");

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
assert(!exists(cliRoot, "hy-workflow.json"), "default config CLI should not write the project root");
assert(readLocalConfig(cliRoot).project.codeExt === ".py", "config CLI should write the user-local project config");
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

const invalidCompatRoot = configuredRoot(".py", { "src/app.py": "print('ok')\n" });
fs.writeFileSync(path.join(invalidCompatRoot, "codelint.json"), "{ invalid compatibility json\n", "utf-8");
const invalidCompatBefore = fs.readFileSync(path.join(invalidCompatRoot, "codelint.json"), "utf-8");
withRuntimeCompatConfigs(invalidCompatRoot, () => {
  assert(readJson(invalidCompatRoot, "codelint.json").codeExt === ".py", "runtime compat should replace invalid existing codelint while running");
});
assert(fs.readFileSync(path.join(invalidCompatRoot, "codelint.json"), "utf-8") === invalidCompatBefore, "runtime compat should restore invalid existing codelint after run");

const help = runConfigCli(["--help"]);
assert(help.stdout.includes("hy-workflow config --check --json"), "help should explain config command");
assert(help.stdout.includes("OS user config directory"), "help should document user-local config");

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
