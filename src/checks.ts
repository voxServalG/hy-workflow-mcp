import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckItem, ImplementationManifest, PendingPlanAmendment, PlanDoc, WorkflowState } from "./state.js";
import { getBaseBranch } from "./state.js";
import { PYTHON_CODE_EXTS, normalizeCodeExt } from "./code_ext.js";
import { readUnifiedConfig, withRuntimeCompatConfigs } from "./config.js";
import { runContractLint } from "./contralint/run.js";

// ── Result ───────────────────────────────────────────────────

export interface CheckResult {
  layer: string;
  name: string;
  passed: boolean;
  detail: string;
  hard: boolean;
  classification?: "hard_fail" | "amend_required" | "warning";
}

// ── Helpers ──────────────────────────────────────────────────

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function execOr(cmd: string, cwd?: string): ExecResult {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 120_000 });
    return { ok: true, stdout: stdout.trim(), stderr: "", status: 0 };
  } catch (e: any) {
    const status = typeof e.status === "number" ? e.status : null;
    return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "", status };
  }
}

function ok(title: string, layer: string, detail = "", hard = true): CheckResult {
  return { layer, name: title, passed: true, detail: detail || "OK", hard };
}
function fail(title: string, layer: string, detail = "", hard = true): CheckResult {
  return { layer, name: title, passed: false, detail: detail || "FAILED", hard };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function formatExit(r: ExecResult): string {
  return r.status === null ? "unknown exit" : `exit ${r.status}`;
}

function findPython(): string {
  const candidates = ["python3", "python", "py"];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: "ignore", timeout: 5_000 });
      return cmd;
    } catch {}
  }
  return "python3";
}

// ── CI lint helpers (not run by hy_verify) ───────────────────

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function nestedNumber(report: any, key: string): number | null {
  return numberFrom(
    report?.data?.counts?.[key],
    report?.counts?.[key],
    report?.data?.summary?.[key],
    report?.summary?.[key],
    report?.data?.[key],
    report?.[key]
  );
}

function countDetail(errors: number, warnings: number, files: number, failed: number): string {
  return `${errors} errors, ${warnings} warnings (${files} files, ${failed} failed)`;
}

export function parseDocLintReport(report: any): CheckResult {
  const failed = nestedNumber(report, "failed");
  const errors = nestedNumber(report, "errors");
  const warnings = nestedNumber(report, "warnings") ?? 0;
  const files = nestedNumber(report, "files") ?? nestedNumber(report, "total") ?? 0;

  if (failed === null && errors === null && typeof report?.ok !== "boolean") {
    return fail("doclint", "lint", "Could not understand doclint JSON report", true);
  }

  const effectiveErrors = errors ?? failed ?? 0;
  const effectiveFailed = failed ?? effectiveErrors;
  const passed = report?.ok === false ? false : effectiveErrors === 0 && effectiveFailed === 0;
  const detail = countDetail(effectiveErrors, warnings, files, effectiveFailed);
  return passed
    ? ok("doclint", "lint", detail)
    : fail("doclint", "lint", detail, true);
}

export function parseCodeLintReport(report: any): CheckResult {
  const failed = nestedNumber(report, "failed");
  const errors = nestedNumber(report, "errors");
  const warnings = nestedNumber(report, "warnings") ?? 0;
  const files = nestedNumber(report, "files") ?? nestedNumber(report, "total") ?? 0;

  if (failed === null && errors === null && typeof report?.ok !== "boolean") {
    return fail("codelint", "lint", "Could not understand codelint JSON report", true);
  }

  const effectiveErrors = errors ?? failed ?? 0;
  const effectiveFailed = failed ?? effectiveErrors;
  const passed = report?.ok === false ? false : effectiveErrors === 0 && effectiveFailed === 0;
  const detail = countDetail(effectiveErrors, warnings, files, effectiveFailed);
  return passed
    ? ok("codelint", "lint", detail)
    : fail("codelint", "lint", detail, true);
}

export function runDocLint(root: string): CheckResult[] {
  const r = withRuntimeCompatConfigs(root, () => execOr("npx --yes github:voxServalG/doclint lint --json", root));
  try {
    const report = JSON.parse(r.stdout || "{}");
    return [parseDocLintReport(report)];
  } catch {
    return [fail("doclint", "lint", "Could not parse doclint report", true)];
  }
}

export function runCodeLint(root: string): CheckResult[] {
  const r = withRuntimeCompatConfigs(root, () => execOr("npx --yes github:voxServalG/codelint check --json", root));
  try {
    const report = JSON.parse(r.stdout || "{}");
    return [parseCodeLintReport(report)];
  } catch {
    return [fail("codelint", "lint", "Could not parse codelint report", true)];
  }
}

export function runWorkflowContractLint(root: string): CheckResult[] {
  const report = runContractLint(root);
  const detail = report.ok
    ? "contract lint passed"
    : report.findings.map(finding => finding.severity + ":" + finding.rule + ":" + finding.message).join("; ");
  return [report.ok
    ? ok("workflow-contract", "lint", detail)
    : fail("workflow-contract", "lint", detail, true)];
}

// ── 2. Compile (hard) ───────────────────────────────────────

interface CompileConfig {
  exts: string[];
  codeDirs: string[];
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim());
  if (typeof value === "string" && value.trim()) return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function readCompileConfig(root: string): CompileConfig {
  const configPath = path.join(root, "codelint.json");
  const legacy = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : null;
  const unified = readUnifiedConfig(root);
  const project = unified && typeof unified.project === "object" ? unified.project as Record<string, unknown> : {};
  const codelint = unified && typeof unified.codelint === "object" ? unified.codelint as Record<string, unknown> : {};
  const exts = normalizeCodeExt(project.codeExt ?? legacy?.codeExt);
  const codeDirs = unique([
    ...stringArray(project.codeDirs),
    ...stringArray(codelint.lintDirs),
    ...stringArray(legacy?.codeDirs),
    ...stringArray(legacy?.lintDirs),
  ]);
  return { exts, codeDirs: codeDirs.length ? codeDirs : ["src"] };
}

function hasTsCompileConfig(root: string): boolean {
  return fs.existsSync(path.join(root, "tsconfig.json"));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function walkFiles(root: string, dir: string, allowedExts: Set<string>): string[] {
  const base = path.resolve(root, dir);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (allowedExts.has(path.extname(entry.name).toLowerCase())) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(base);
  return files.sort();
}

function pythonFiles(root: string, codeDirs: string[], exts: string[]): string[] {
  const pyExts = new Set(exts.filter(ext => PYTHON_CODE_EXTS.has(ext)));
  if (!pyExts.size) return [];
  return unique(codeDirs.flatMap(dir => walkFiles(root, dir, pyExts)));
}

function runPythonCompile(root: string, files: string[]): CheckResult {
  if (!files.length) return ok("compile: python", "compile", "No Python files found in configured codeDirs", false);
  const command = `${findPython()} -m py_compile ${files.map(shellQuote).join(" ")}`;
  const r = execOr(command, root);
  return r.ok
    ? ok("compile: python", "compile", `${files.length} Python file(s) compiled`)
    : fail("compile: python", "compile", `${formatExit(r)}: ${r.stderr || r.stdout || "Python compile failed"}`, true);
}

function runTypeScriptCompile(root: string): CheckResult {
  const r = execOr("npx tsc --noEmit", root);
  return r.ok
    ? ok("compile: typescript", "compile", "TypeScript build OK")
    : fail("compile: typescript", "compile", `${formatExit(r)}: ${r.stderr || r.stdout || "TypeScript build failed"}`, true);
}

export function runCompile(root: string): CheckResult[] {
  let config: CompileConfig;
  try {
    config = readCompileConfig(root);
  } catch (e: any) {
    return [fail("compile", "compile", e.message ?? String(e), true)];
  }

  const results: CheckResult[] = [];
  const hasTsExt = config.exts.some(ext => ext === ".ts" || ext === ".tsx");
  const hasJsExt = config.exts.some(ext => [".js", ".jsx", ".mjs", ".cjs"].includes(ext));
  const hasPythonExt = config.exts.some(ext => PYTHON_CODE_EXTS.has(ext));

  if (hasTsExt || (hasJsExt && hasTsCompileConfig(root))) {
    results.push(runTypeScriptCompile(root));
  } else if (hasJsExt) {
    results.push(ok("compile: javascript", "compile", "JS-only project has no TypeScript compile config", false));
  }

  if (hasPythonExt) {
    results.push(runPythonCompile(root, pythonFiles(root, config.codeDirs, config.exts)));
  }

  if (!results.length) return [ok("compile", "compile", "No compile command configured", false)];
  return results;
}

// ── 3. Scope (hard) ─────────────────────────────────────────

function parseNameStatus(output: string): Pick<ImplementationManifest, "modified" | "added" | "deleted"> {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const line of output.split("\n").filter(Boolean)) {
    const parts = line.trim().split(/\t+/);
    const status = parts[0] ?? "";
    const first = parts[1] ?? "";
    const second = parts[2] ?? "";

    if (status.startsWith("R") || status.startsWith("C")) {
      if (first) deleted.push(first);
      if (second) added.push(second);
      continue;
    }
    if (status.includes("D")) {
      if (first) deleted.push(first);
      continue;
    }
    if (status.includes("A")) {
      if (first) added.push(first);
      continue;
    }
    if (first) modified.push(first);
  }

  return {
    modified: unique(modified),
    added: unique(added),
    deleted: unique(deleted),
  };
}

export function buildImplementationManifest(root: string): ImplementationManifest {
  const base = getBaseBranch(root);
  const diff = execOr(`git diff origin/${base} --name-status -- . ":(exclude)dist/*" ":(exclude)node_modules/*"`, root);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr}`);

  const parsed = parseNameStatus(diff.stdout);
  const untrackedResult = execOr(`git ls-files --others --exclude-standard -- . ":(exclude)dist/*" ":(exclude)node_modules/*"`, root);
  if (!untrackedResult.ok) throw new Error(`git ls-files failed: ${untrackedResult.stderr}`);

  const untracked = unique(untrackedResult.stdout.split("\n").filter(Boolean).map(s => s.trim()));
  return {
    ...parsed,
    untracked,
    changed: unique([...parsed.modified, ...parsed.added, ...parsed.deleted, ...untracked]),
  };
}

function isTestSupportFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const base = path.basename(normalized);
  return (
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    base === "conftest.py" ||
    (base === "__init__.py" && (normalized.includes("/test/") || normalized.includes("/tests/"))) ||
    /^test[_-]/.test(base) ||
    /\.test\.[jt]sx?$/.test(base) ||
    /\.spec\.[jt]sx?$/.test(base)
  );
}

function declaredDirectories(plan: PlanDoc): Set<string> {
  return new Set([...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete].map(file => path.posix.dirname(file.replace(/\\/g, "/"))));
}

function isWithinDeclaredDirectory(file: string, plan: PlanDoc): boolean {
  return declaredDirectories(plan).has(path.posix.dirname(file.replace(/\\/g, "/")));
}

function isAmendableScopeFile(file: string, plan: PlanDoc): boolean {
  return isTestSupportFile(file) || isWithinDeclaredDirectory(file, plan);
}

function emptyScopeAmendment(): PendingPlanAmendment["scope"] {
  return {
    changes: { add: [], remove: [] },
    new_files: { add: [], remove: [] },
    delete: { add: [], remove: [] },
  };
}

export function suggestPlanAmendment(plan: PlanDoc, manifest: ImplementationManifest): PendingPlanAmendment | null {
  const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
  const actual = manifest.changed;
  const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
  const amendableExtra = extra.filter(f => isAmendableScopeFile(f, plan));
  const notAmendableExtra = extra.filter(f => !isAmendableScopeFile(f, plan));
  const missing = declared.filter(f => !actual.includes(f));
  const scope = emptyScopeAmendment();

  for (const file of amendableExtra) {
    if (manifest.deleted.includes(file)) scope.delete.add.push(file);
    else if (manifest.added.includes(file) || manifest.untracked.includes(file)) scope.new_files.add.push(file);
    else scope.changes.add.push(file);
  }

  for (const file of missing) {
    if (plan.scope.changes.includes(file)) scope.changes.remove.push(file);
    if (plan.scope.new_files.includes(file)) scope.new_files.remove.push(file);
    if (plan.scope.delete.includes(file)) scope.delete.remove.push(file);
  }

  const hasScopeChanges = [
    ...scope.changes.add,
    ...scope.changes.remove,
    ...scope.new_files.add,
    ...scope.new_files.remove,
    ...scope.delete.add,
    ...scope.delete.remove,
  ].length > 0;

  if (!hasScopeChanges) return null;

  scope.changes.add = unique(scope.changes.add);
  scope.changes.remove = unique(scope.changes.remove);
  scope.new_files.add = unique(scope.new_files.add);
  scope.new_files.remove = unique(scope.new_files.remove);
  scope.delete.add = unique(scope.delete.add);
  scope.delete.remove = unique(scope.delete.remove);

  return {
    reason: notAmendableExtra.length
      ? "Some scope drift is outside the amendable boundary; only safe amendments are suggested."
      : "Scope drift is limited to test support files or the already approved directory boundary.",
    scope,
    warnings: [
      ...missing.map(file => `Declared but not changed: ${file}`),
      ...notAmendableExtra.map(file => `Not amendable automatically: ${file}`),
    ],
  };
}

function isAmendOnlyFailure(plan: PlanDoc, manifest: ImplementationManifest): boolean {
  const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
  const extra = manifest.changed.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
  return extra.length > 0 && extra.every(f => isAmendableScopeFile(f, plan));
}

export function runScopeCheck(root: string, plan: PlanDoc, manifest?: ImplementationManifest): CheckResult[] {
  const res: CheckResult[] = [];
  let actualManifest: ImplementationManifest;
  try {
    actualManifest = manifest ?? buildImplementationManifest(root);
  } catch (e: any) {
    return [fail("scope", "scope", e.message ?? String(e))];
  }

  const actual = actualManifest.changed;
  const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
  const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));

  if (extra.length) {
    const amendable = isAmendOnlyFailure(plan, actualManifest);
    res.push({
      ...fail("scope", "scope", `Unexpected changes: ${extra.join(", ")}`),
      classification: amendable ? "amend_required" : "hard_fail",
    });
  } else {
    res.push(ok("scope", "scope", `${actual.length} files, all in plan.scope`));
  }

  const missing = declared.filter(f => !actual.includes(f));
  if (missing.length) {
    res.push({
      ...fail("scope", "scope", `Declared but not changed: ${missing.join(", ")}`, true),
      classification: "hard_fail",
    });
  }
  return res;
}

// ── 4. Boundary ──────────────────────────────────────────────

const DEPENDENCY_MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "Gemfile.lock",
  "policy.md",
]);

function isDependencyManifest(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return DEPENDENCY_MANIFEST_FILES.has(normalized) || (normalized.startsWith("requirements/") && normalized.endsWith(".txt"));
}

export function runBoundaryCheck(root: string, plan: PlanDoc, manifest?: ImplementationManifest, manifestError?: string): CheckResult[] {
  const res: CheckResult[] = [];

  for (const ep of plan.boundary.entry_points) {
    const r = execOr(ep, root);
    res.push(r.ok
      ? ok(`entry: ${ep.slice(0, 55)}...`, "boundary", "OK")
      : fail(`entry: ${ep.slice(0, 55)}...`, "boundary", `${formatExit(r)}: ${r.stderr || r.stdout || "command failed"}`));
  }

  if (plan.boundary.no_new_external) {
    let boundaryManifest = manifest ?? null;
    let boundaryManifestError = manifestError ?? null;
    if (!boundaryManifest && !boundaryManifestError) {
      try {
        boundaryManifest = buildImplementationManifest(root);
      } catch (e: any) {
        boundaryManifestError = e.message ?? String(e);
      }
    }

    if (boundaryManifestError) {
      res.push(fail("no_new_external", "boundary", `Cannot verify dependency manifests: ${boundaryManifestError}`));
    } else {
      const changedDeps = (boundaryManifest?.changed ?? []).filter(isDependencyManifest);
      res.push(changedDeps.length
        ? fail("no_new_external", "boundary", `Dependency manifest changed: ${changedDeps.join(", ")}`)
        : ok("no_new_external", "boundary", "No dependency manifest changes"));
    }
  }

  return res;
}

// ── 5. Platform ──────────────────────────────────────────────

type VersionTuple = [number, number, number];

function parsePythonVersionRequirement(value: string): VersionTuple | null {
  const trimmed = value.trim();
  if (!trimmed || /^(n\/?a|none|no|false|not required|not-required)$/i.test(trimmed)) return null;
  const match = /^(?:>=\s*)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(actual: VersionTuple, required: VersionTuple): number {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > required[i]) return 1;
    if (actual[i] < required[i]) return -1;
  }
  return 0;
}

function formatVersion(version: VersionTuple): string {
  return version.join(".").replace(/(?:\.0)+$/, "");
}

function runPythonVersionCheck(root: string, required: VersionTuple): CheckResult {
  const python = findPython();
  const r = execOr(`${python} --version`, root);
  const output = r.stdout || r.stderr;
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!r.ok || !match) {
    return fail("python_version", "platform", `${formatExit(r)}: ${output || "could not read Python version"}`);
  }
  const actual: VersionTuple = [Number(match[1]), Number(match[2]), Number(match[3])];
  return compareVersions(actual, required) >= 0
    ? ok("python_version", "platform", `Python ${formatVersion(actual)} satisfies >=${formatVersion(required)}`)
    : fail("python_version", "platform", `Python ${formatVersion(actual)} is below required >=${formatVersion(required)}`);
}

export function runPlatform(plan: PlanDoc, root: string): CheckResult[] {
  const res: CheckResult[] = [];
  const requiredPython = parsePythonVersionRequirement(plan.verify.platform.python_version);
  if (requiredPython) res.push(runPythonVersionCheck(root, requiredPython));

  for (const cmd of plan.verify.platform.setup) {
    const r = execOr(cmd, root);
    res.push(r.ok
      ? ok(`setup: ${cmd.slice(0, 50)}`, "platform", r.stdout || "OK")
      : fail(`setup: ${cmd.slice(0, 50)}`, "platform", `${formatExit(r)}: ${r.stderr || r.stdout || "setup command failed"}`));
  }
  return res;
}

// ── 6. Smoke & 7. Tests ──────────────────────────────────────

export function runSmoke(plan: PlanDoc, root: string): CheckResult[] {
  return runItems(plan.verify.smoke, "smoke", root);
}
export function runTests(plan: PlanDoc, root: string): CheckResult[] {
  return runItems(plan.verify.tests, "tests", root);
}

function runItems(items: CheckItem[], layer: string, root: string): CheckResult[] {
  return items.map(item => {
    const r = execOr(item.command, root);
    const exitOk = r.status === item.expected_exit;
    const output = r.stdout || r.stderr;
    return exitOk
      ? ok(item.description, layer, output || `${formatExit(r)} as expected`)
      : fail(item.description, layer, `expected exit ${item.expected_exit}, got ${formatExit(r)}${output ? `: ${output}` : ""}`);
  });
}

// ── Master ───────────────────────────────────────────────────

export interface VerifyReport {
  allPassed: boolean;
  hardFailed: number;
  total: number;
  checks: CheckResult[];
  status: "passed" | "amend_required" | "hard_fail";
  implementationManifest: ImplementationManifest;
  suggestedAmendment: PendingPlanAmendment | null;
}

export function runAllChecks(root: string, state: WorkflowState): VerifyReport {
  const p = state.plan;
  const emptyManifest: ImplementationManifest = { modified: [], added: [], deleted: [], untracked: [], changed: [] };
  if (!p) return {
    allPassed: false,
    hardFailed: 1,
    total: 1,
    checks: [fail("plan", "lint", "No plan")],
    status: "hard_fail",
    implementationManifest: emptyManifest,
    suggestedAmendment: null,
  };

  let implementationManifest = emptyManifest;
  let manifestError: CheckResult | null = null;
  try {
    implementationManifest = buildImplementationManifest(root);
  } catch (e: any) {
    manifestError = fail("scope", "scope", e.message ?? String(e));
  }

  const all: CheckResult[] = [
    ...runCompile(root),
    ...(manifestError ? [manifestError] : runScopeCheck(root, p, implementationManifest)),
    ...runBoundaryCheck(root, p, manifestError ? undefined : implementationManifest, manifestError?.detail),
    ...runPlatform(p, root),
    ...runSmoke(p, root),
    ...runTests(p, root),
  ];
  const hardFailures = all.filter(c => c.hard && !c.passed);
  const suggestedAmendment = manifestError ? null : suggestPlanAmendment(p, implementationManifest);
  const status = hardFailures.length === 0
    ? "passed"
    : hardFailures.every(c => c.classification === "amend_required") && suggestedAmendment
      ? "amend_required"
      : "hard_fail";

  return {
    allPassed: all.every(c => c.passed || !c.hard),
    hardFailed: hardFailures.length,
    total: all.length,
    checks: all,
    status,
    implementationManifest,
    suggestedAmendment,
  };
}
