import { execFileSync, execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckItem, ImplementationManifest, PendingPlanAmendment, PlanDoc, WorkflowState } from "./state.js";
import { getBaseBranch } from "./state.js";
import { PYTHON_CODE_EXTS, normalizeCodeExt } from "./code_ext.js";
import { requireRuntimeConfig } from "./config.js";
import { isLegacyIgnoredArtifact, isRuntimeIgnoredArtifact, runtimeArtifactExclusionPathspecs } from "./policy/artifacts.js";

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

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
  timeoutMs: number;
  durationMs: number;
}

export const CHECK_COMMAND_TIMEOUT_MS = 90_000;
export const CHECK_TEST_TIMEOUT_MS = 1_200_000;
export const CHECK_PACK_TIMEOUT_MS = 300_000;
export const ACCEPTANCE_TOTAL_TIMEOUT_MS = 2_700_000;
export const ACCEPTANCE_CLEANUP_ALLOWANCE_MS = 120_000;
export const CHECK_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export type CheckCommand = string | { file: string; args: string[] };

export const CHECK_COMMAND_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
const payload = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const started = Date.now();
let child;
let stdout = "";
let stderr = "";
let spawnError = "";
let timedOut = false;
let settled = false;
let timeoutTimer;
let forceTimer;

function emit(status, signal) {
  if (settled) return;
  settled = true;
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);
  process.stdout.write(JSON.stringify({
    status: timedOut ? null : status,
    signal: signal || null,
    stdout,
    stderr,
    error: spawnError,
    timedOut,
    durationMs: Date.now() - started,
  }));
}

function terminateTree(signal) {
  if (!child || !child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); }
    catch {
      try { child.kill(signal); } catch {}
    }
    return;
  }
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.once("error", () => {
    try { child.kill("SIGKILL"); } catch {}
  });
}

function shutdown(signal) {
  timedOut = true;
  terminateTree("SIGKILL");
  setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 5_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

try {
  const structured = payload.kind === "file";
  child = spawn(structured ? payload.file : payload.command, structured ? payload.args : [], {
    cwd: payload.cwd || undefined,
    env: process.env,
    detached: process.platform !== "win32",
    shell: !structured,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", error => {
    spawnError = error && error.message ? error.message : String(error);
    if (!child.pid) emit(null, null);
  });
  child.once("close", (status, signal) => emit(status, signal));
  timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminateTree("SIGTERM");
    forceTimer = setTimeout(() => terminateTree("SIGKILL"), 2_000);
  }, payload.timeoutMs);
} catch (error) {
  spawnError = error && error.message ? error.message : String(error);
  emit(null, null);
}
`;

function positiveMilliseconds(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function checkCommandTimeoutMs(command: string): number {
  if (/\b(?:npm\s+run\s+test:acceptance|test\/acceptance\/runner)\b/.test(command)) {
    const configured = positiveMilliseconds(process.env.HY_ACCEPTANCE_TOTAL_TIMEOUT_MS) ?? ACCEPTANCE_TOTAL_TIMEOUT_MS;
    return Math.max(ACCEPTANCE_TOTAL_TIMEOUT_MS, configured) + ACCEPTANCE_CLEANUP_ALLOWANCE_MS;
  }
  if (/\bnpm\s+(?:run\s+)?(?:test(?::(?:unit|e2e|contract|windows))?|verify)\b/.test(command)) {
    return CHECK_TEST_TIMEOUT_MS;
  }
  if (/\bnpm\s+pack\b/.test(command)) return CHECK_PACK_TIMEOUT_MS;
  return CHECK_COMMAND_TIMEOUT_MS;
}

export function runCheckCommand(command: CheckCommand, cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv): ExecResult {
  const effectiveTimeoutMs = timeoutMs ?? (typeof command === "string" ? checkCommandTimeoutMs(command) : CHECK_COMMAND_TIMEOUT_MS);
  const payload = typeof command === "string"
    ? { kind: "shell", command, cwd, timeoutMs: effectiveTimeoutMs }
    : { kind: "file", file: command.file, args: command.args, cwd, timeoutMs: effectiveTimeoutMs };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const started = Date.now();
  const supervisor = spawnSync(process.execPath, ["-e", CHECK_COMMAND_SUPERVISOR, encoded], {
    encoding: "utf8",
    env: env ?? process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: CHECK_OUTPUT_LIMIT_BYTES,
  });
  const durationMs = Date.now() - started;
  if (supervisor.error || supervisor.status !== 0) {
    return {
      ok: false,
      stdout: supervisor.stdout?.trim() ?? "",
      stderr: (supervisor.stderr?.trim() || supervisor.error?.message || `check command supervisor exited ${supervisor.status}`),
      status: null,
      timedOut: false,
      timeoutMs: effectiveTimeoutMs,
      durationMs,
    };
  }
  try {
    const result = JSON.parse(supervisor.stdout || "{}");
    const timedOut = result.timedOut === true;
    const status = timedOut ? null : (typeof result.status === "number" ? result.status : null);
    const timeoutDetail = timedOut ? `timed out after ${effectiveTimeoutMs}ms` : "";
    const stderr = [result.stderr, result.error, timeoutDetail].filter(Boolean).join("; ").trim();
    return {
      ok: !timedOut && !result.error && status === 0,
      stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
      stderr,
      status,
      timedOut,
      timeoutMs: effectiveTimeoutMs,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : durationMs,
    };
  } catch (error: any) {
    return {
      ok: false,
      stdout: "",
      stderr: `Could not parse check command supervisor result: ${error?.message ?? String(error)}; ${supervisor.stdout?.slice(-2_000) ?? ""}`,
      status: null,
      timedOut: false,
      timeoutMs: effectiveTimeoutMs,
      durationMs,
    };
  }
}

function execOr(cmd: string, cwd?: string): ExecResult {
  return runCheckCommand(cmd, cwd);
}

export function ok(title: string, layer: string, detail = "", hard = true): CheckResult {
  return { layer, name: title, passed: true, detail: detail || "OK", hard };
}
export function fail(title: string, layer: string, detail = "", hard = true): CheckResult {
  return { layer, name: title, passed: false, detail: detail || "FAILED", hard };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function formatExit(r: ExecResult): string {
  if (r.timedOut) return `timeout after ${r.timeoutMs}ms`;
  return r.status === null ? "unknown exit" : `exit ${r.status}`;
}

export function findPython(): string {
  const candidates = ["python3", "python", "py"];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: "ignore", timeout: 5_000 });
      return cmd;
    } catch {}
  }
  return "python3";
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
  const unified = requireRuntimeConfig(root);
  const project = unified.project as Record<string, unknown>;
  return {
    exts: normalizeCodeExt(project.codeExt),
    codeDirs: unique(stringArray(project.codeDirs)).filter(dir => !isRuntimeIgnoredArtifact(root, dir)),
  };
}

function hasTsCompileConfig(root: string): boolean {
  return fs.existsSync(path.join(root, "tsconfig.json"));
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
  const r = runCheckCommand({ file: findPython(), args: ["-m", "py_compile", ...files] }, root);
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
  const exclusions = [":(exclude)dist/**", ":(exclude)node_modules/**", ...runtimeArtifactExclusionPathspecs(root)];
  const diff = runCheckCommand({ file: "git", args: ["diff", `origin/${base}`, "--name-status", "--", ".", ...exclusions] }, root);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr}`);

  const parsed = parseNameStatus(diff.stdout);
  const untrackedResult = runCheckCommand({ file: "git", args: ["ls-files", "--others", "--exclude-standard", "--", ".", ...exclusions] }, root);
  if (!untrackedResult.ok) throw new Error(`git ls-files failed: ${untrackedResult.stderr}`);

  const keep = (file: string): boolean => !isRuntimeIgnoredArtifact(root, file);
  const filtered = {
    modified: parsed.modified.filter(keep),
    added: parsed.added.filter(keep),
    deleted: parsed.deleted.filter(keep),
  };
  const untracked = unique(untrackedResult.stdout.split("\n").filter(Boolean).map(s => s.trim()).filter(keep));
  return {
    ...filtered,
    untracked,
    changed: unique([...filtered.modified, ...filtered.added, ...filtered.deleted, ...untracked]),
  };
}

function declaredScopeFiles(plan: PlanDoc, root?: string): string[] {
  return [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete]
    .filter(file => !isLegacyIgnoredArtifact(file))
    .filter(file => !root || !isRuntimeIgnoredArtifact(root, file));
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

function declaredDirectories(plan: PlanDoc, root?: string): Set<string> {
  return new Set(declaredScopeFiles(plan, root).map(file => path.posix.dirname(file.replace(/\\/g, "/"))));
}

function isWithinDeclaredDirectory(file: string, plan: PlanDoc, root?: string): boolean {
  return declaredDirectories(plan, root).has(path.posix.dirname(file.replace(/\\/g, "/")));
}

function isAmendableScopeFile(file: string, plan: PlanDoc, root?: string): boolean {
  return isTestSupportFile(file) || isWithinDeclaredDirectory(file, plan, root);
}

function emptyScopeAmendment(): PendingPlanAmendment["scope"] {
  return {
    changes: { add: [], remove: [] },
    new_files: { add: [], remove: [] },
    delete: { add: [], remove: [] },
  };
}

export function suggestPlanAmendment(plan: PlanDoc, manifest: ImplementationManifest, root?: string): PendingPlanAmendment | null {
  const declared = declaredScopeFiles(plan, root);
  const actual = manifest.changed;
  const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
  const amendableExtra = extra.filter(f => isAmendableScopeFile(f, plan, root));
  const notAmendableExtra = extra.filter(f => !isAmendableScopeFile(f, plan, root));
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

function isAmendOnlyFailure(root: string, plan: PlanDoc, manifest: ImplementationManifest): boolean {
  const declared = declaredScopeFiles(plan, root);
  const extra = manifest.changed.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
  return extra.length > 0 && extra.every(f => isAmendableScopeFile(f, plan, root));
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
  const declared = declaredScopeFiles(plan, root);
  const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));

  if (extra.length) {
    const amendable = isAmendOnlyFailure(root, plan, actualManifest);
    res.push({
      ...fail("scope", "scope", `Unexpected changes: ${extra.join(", ")}`),
      classification: amendable ? "amend_required" : "hard_fail",
    });
  } else {
    res.push(ok("scope", "scope", `${actual.length} files, all in plan.scope`));
  }

  const missing = declared.filter(f => !actual.includes(f));
  if (missing.length) {
    const amendedScopeWouldRemain = declared.length > missing.length || extra.some(file => isAmendableScopeFile(file, plan, root));
    res.push({
      ...fail("scope", "scope", `Declared but not changed: ${missing.join(", ")}`, true),
      classification: amendedScopeWouldRemain ? "amend_required" : "hard_fail",
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

const NPM_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, canonicalJson(nested)]));
}

function npmDependencyFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(NPM_DEPENDENCY_FIELDS
    .filter(field => record[field] !== undefined)
    .map(field => [field, canonicalJson(record[field])]));
}

function parseJsonFile(content: string | null, label: string): unknown {
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch (caught: any) {
    throw new Error(`${label} is not valid JSON: ${caught?.message ?? String(caught)}`);
  }
}

function readBaseFile(root: string, baseRef: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${baseRef}:${file}`], { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
  } catch {
    return null;
  }
}

function npmDependencyProjection(packageJson: unknown, packageLock: unknown): unknown {
  const lockRecord = packageLock && typeof packageLock === "object" && !Array.isArray(packageLock)
    ? packageLock as Record<string, unknown>
    : {};
  const packages = lockRecord.packages && typeof lockRecord.packages === "object" && !Array.isArray(lockRecord.packages)
    ? lockRecord.packages as Record<string, unknown>
    : null;
  const lockRoot = packages?.[""] ?? (packages ? null : lockRecord.dependencies ?? null);
  return canonicalJson({ package: npmDependencyFields(packageJson), lockRoot: npmDependencyFields(lockRoot) });
}

function npmDependencyDeclarationsChanged(root: string): boolean {
  const baseRef = `origin/${getBaseBranch(root)}`;
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
  const currentPackage = parseJsonFile(fs.existsSync(path.join(root, "package.json")) ? fs.readFileSync(path.join(root, "package.json"), "utf-8") : null, "package.json");
  const currentLock = parseJsonFile(fs.existsSync(path.join(root, "package-lock.json")) ? fs.readFileSync(path.join(root, "package-lock.json"), "utf-8") : null, "package-lock.json");
  const basePackage = parseJsonFile(readBaseFile(root, baseRef, "package.json"), `${baseRef}:package.json`);
  const baseLock = parseJsonFile(readBaseFile(root, baseRef, "package-lock.json"), `${baseRef}:package-lock.json`);
  return JSON.stringify(npmDependencyProjection(currentPackage, currentLock)) !== JSON.stringify(npmDependencyProjection(basePackage, baseLock));
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
      const nonNpmChanges = changedDeps.filter(file => file !== "package.json" && file !== "package-lock.json");
      try {
        const npmDeclarationsChanged = changedDeps.some(file => file === "package.json" || file === "package-lock.json")
          && npmDependencyDeclarationsChanged(root);
        const dependencyChanges = [...nonNpmChanges, ...(npmDeclarationsChanged ? ["package.json"] : [])];
        res.push(dependencyChanges.length
          ? fail("no_new_external", "boundary", `Dependency declarations changed: ${dependencyChanges.join(", ")}`)
          : ok("no_new_external", "boundary", "No external dependency declaration changes"));
      } catch (caught: any) {
        res.push(fail("no_new_external", "boundary", `Cannot verify dependency manifests: ${caught?.message ?? String(caught)}`));
      }
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
  const suggestedAmendment = manifestError ? null : suggestPlanAmendment(p, implementationManifest, root);
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
