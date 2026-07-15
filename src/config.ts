import * as fs from "node:fs";
import * as path from "node:path";
import { codeExtOr, formatCodeExt, normalizeCodeExt, type CodeExt, validateCodeExt } from "./code_ext.js";
import { projectPaths } from "./runtime/user-paths.js";

export type ProjectKind = "python" | "typescript" | "unknown" | "mixed";

export type JsonObject = Record<string, any>;

export type ConfigSuggestion = {
  codeExt: CodeExt;
  codeDirs: string[];
  lintDirs: string[];
  docsDir: string;
  baseBranch: string;
  maxCodeLines: number;
  maxDocLines: number;
};

export type ConfigDrift = {
  file: string;
  field: string;
  expected: unknown;
  actual: unknown;
};

export type ConfigCheckResult = {
  ok: boolean;
  phase: "config";
  next: "config";
  display: { title: string; body: string };
  hint: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  recovery?: { tool?: string; instruction?: string };
  project: {
    kind: ProjectKind;
    evidence: string[];
  };
  issues: string[];
  drift: ConfigDrift[];
  suggestion: ConfigSuggestion;
  suggestedCommand: string;
  changed?: string[];
  preserved?: Record<string, string[]>;
  dryRun?: boolean;
  source?: string;
  candidate?: JsonObject;
};

type ConfigArgs = {
  mode: "check" | "apply" | "help";
  json: boolean;
  dryRun: boolean;
  applySuggested: boolean;
  shared: boolean;
  explicit: Partial<ConfigSuggestion>;
  errors: string[];
};

export const UNIFIED_CONFIG_FILE = "hy-workflow.json";
const COMPAT_CONFIG_FILES = ["codelint.json", "doclint.json", "docs-gardener.json"];

export class RuntimeConfigError extends Error {
  readonly type = "config" as const;
  readonly subtype = "config_invalid" as const;
  readonly code: "ROOT_CONFIG_REQUIRED" | "ROOT_CONFIG_INVALID";
  readonly hint = "Run hy-workflow setup in the project root, or repair hy-workflow.json with hy-workflow config --apply --json.";
  readonly retryable = false;
  readonly detail: { source: string; issues: string[] };

  constructor(root: string, issues: string[], missing: boolean) {
    const source = path.join(root, UNIFIED_CONFIG_FILE);
    super(missing
      ? `Runtime project config is required at ${source}.`
      : `Runtime project config is invalid at ${source}: ${issues.join("; ")}`);
    this.name = "RuntimeConfigError";
    Object.defineProperty(this, "message", { enumerable: true, configurable: true, writable: true, value: this.message });
    this.code = missing ? "ROOT_CONFIG_REQUIRED" : "ROOT_CONFIG_INVALID";
    this.detail = { source, issues };
  }
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

function directoryExists(root: string, rel: string): boolean {
  try { return Boolean(rel) && fs.statSync(path.join(root, rel)).isDirectory(); }
  catch { return false; }
}

type JsonRead = {
  value: JsonObject | null;
  issue: string | null;
};

function jsonIssue(rel: string, message: string): string {
  return `${rel} is not valid config JSON: ${message}`;
}

function readJsonFile(root: string, rel: string): JsonRead {
  const filePath = path.join(root, rel);
  if (!fs.existsSync(filePath)) return { value: null, issue: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, issue: jsonIssue(rel, "top-level value must be an object") };
    }
    return { value: parsed as JsonObject, issue: null };
  } catch (error: any) {
    return { value: null, issue: jsonIssue(rel, error?.message ?? String(error)) };
  }
}

function readJsonPath(filePath: string, label = filePath): JsonRead {
  if (!fs.existsSync(filePath)) return { value: null, issue: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, issue: jsonIssue(label, "top-level value must be an object") };
    }
    return { value: parsed as JsonObject, issue: null };
  } catch (error: any) {
    return { value: null, issue: jsonIssue(label, error?.message ?? String(error)) };
  }
}

export function effectiveConfigPath(root: string): string {
  return path.join(root, UNIFIED_CONFIG_FILE);
}

function readJson(root: string, rel: string): JsonObject | null {
  return readJsonFile(root, rel).value;
}

function writeJson(root: string, rel: string, value: JsonObject): boolean {
  const filePath = path.join(root, rel);
  const next = JSON.stringify(value, null, 2) + "\n";
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  if (prev === next) return false;
  fs.writeFileSync(filePath, next, "utf-8");
  return true;
}

function listFiles(root: string, dir: string, ext: string): string[] {
  const start = path.join(root, dir);
  if (!fs.existsSync(start)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) out.push(full);
    }
  };
  walk(start);
  return out;
}

function existingDirs(root: string, candidates: string[]): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return candidates.flatMap(candidate => {
    const matches = entries.filter(entry => entry.name === candidate || entry.name.toLowerCase() === candidate.toLowerCase());
    const isDirectory = (entry: fs.Dirent): boolean => directoryExists(root, entry.name);
    const match = matches.find(entry => entry.name === candidate && isDirectory(entry))
      ?? matches.find(isDirectory);
    return match ? [match.name] : [];
  });
}

function listFileExts(root: string, dir: string): string[] {
  const start = path.join(root, dir);
  if (!fs.existsSync(start)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const ext = path.extname(entry.name);
        if (ext) out.push(ext);
      }
    }
  };
  walk(start);
  return out;
}

export function detectProject(root: string): { kind: ProjectKind; evidence: string[] } {
  const evidence: string[] = [];
  const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"].filter(item => exists(root, item));
  const tsMarkers = ["tsconfig.json", "package.json"].filter(item => exists(root, item));
  const dirs = existingDirs(root, ["src", "test", "tests", "scripts", "lib", "packages"]);
  const pyCount = dirs.reduce((sum, dir) => sum + listFiles(root, dir, ".py").length, 0);
  const tsCount = dirs.reduce((sum, dir) => sum + listFiles(root, dir, ".ts").length, 0);
  if (pyMarkers.length) evidence.push(`python markers: ${pyMarkers.join(", ")}`);
  if (tsMarkers.length) evidence.push(`typescript markers: ${tsMarkers.join(", ")}`);
  if (pyCount) evidence.push(`python files: ${pyCount}`);
  if (tsCount) evidence.push(`typescript files: ${tsCount}`);

  const pyScore = pyMarkers.length * 3 + pyCount;
  const tsScore = tsMarkers.length * 3 + tsCount;
  if (pyScore > 0 && tsScore > 0) {
    if (pyScore >= tsScore * 2) return { kind: "python", evidence };
    if (tsScore >= pyScore * 2) return { kind: "typescript", evidence };
    return { kind: "mixed", evidence };
  }
  if (pyScore > 0) return { kind: "python", evidence };
  if (tsScore > 0) return { kind: "typescript", evidence };
  return { kind: "unknown", evidence };
}

function inferDirs(root: string, ext: string): string[] {
  const dirs = existingDirs(root, ["src", "test", "tests", "scripts", "lib", "packages"]);
  const withFiles = dirs.filter(dir => listFiles(root, dir, ext).length > 0);
  if (withFiles.length) return withFiles;
  const [srcDir] = existingDirs(root, ["src"]);
  if (srcDir) return [srcDir];
  return ["src"];
}

function inferLintDirs(root: string, codeDirs: string[]): string[] {
  const [srcDir] = existingDirs(root, ["src"]);
  if (srcDir) return [srcDir];
  return codeDirs;
}

function inferCodeExt(root: string, detected: { kind: ProjectKind }): string {
  if (detected.kind === "python") return ".py";
  if (detected.kind === "typescript") return ".ts";

  const dirs = existingDirs(root, ["src", "test", "tests", "scripts", "lib", "packages"]);
  const counts = new Map<string, number>();
  for (const dir of dirs) {
    for (const ext of listFileExts(root, dir)) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const [first] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return first?.[0] ?? ".ts";
}

export function defaultSuggestion(root: string): ConfigSuggestion {
  const detected = detectProject(root);
  const codeExt = inferCodeExt(root, detected);
  const codeDirs = inferDirs(root, codeExt);
  return {
    codeExt,
    codeDirs,
    lintDirs: inferLintDirs(root, codeDirs),
    docsDir: existingDirs(root, ["docs", "documentation", "doc"])[0] ?? "",
    baseBranch: "dev",
    maxCodeLines: 500,
    maxDocLines: 200,
  };
}

function mergeSuggestion(root: string, explicit: Partial<ConfigSuggestion>): ConfigSuggestion {
  return { ...defaultSuggestion(root), ...explicit };
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : fallback;
}

function stringOr<T extends string>(value: unknown, fallback: T): T {
  return typeof value === "string" ? value as T : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function unifiedFromInputs(
  existing: JsonObject | null,
  legacy: Record<string, JsonObject | null>,
  suggestion: ConfigSuggestion,
  preserveExisting: boolean,
): JsonObject {
  const project = asObject(existing?.project);
  const codelint = asObject(existing?.codelint);
  const doclint = asObject(existing?.doclint);
  const docsGardener = asObject(existing?.docsGardener);
  const legacyCode = legacy["codelint.json"];
  const legacyDocs = legacy["doclint.json"];
  const legacyGardener = legacy["docs-gardener.json"];

  const use = (current: unknown, legacyValue: unknown, suggested: unknown) =>
    preserveExisting ? current ?? legacyValue ?? suggested : suggested ?? current ?? legacyValue;

  return {
    ...(existing ?? {}),
    project: {
      ...project,
      baseBranch: use(project.baseBranch, legacyCode?.baseBranch ?? legacyDocs?.baseBranch ?? legacyGardener?.baseBranch, suggestion.baseBranch),
      codeExt: use(project.codeExt, legacyCode?.codeExt ?? legacyDocs?.codeExt ?? legacyGardener?.codeExt, suggestion.codeExt),
      codeDirs: use(project.codeDirs, legacyDocs?.codeDirs ?? legacyGardener?.codeDirs ?? legacyCode?.codeDirs, suggestion.codeDirs),
      docsDir: use(project.docsDir, legacyDocs?.docsDir ?? legacyGardener?.docsDir, suggestion.docsDir),
    },
    codelint: {
      ...codelint,
      lintDirs: use(codelint.lintDirs, legacyCode?.lintDirs, suggestion.lintDirs),
      maxLines: use(codelint.maxLines, legacyCode?.maxLines, suggestion.maxCodeLines),
    },
    doclint: {
      ...doclint,
      maxLines: use(doclint.maxLines, legacyDocs?.maxLines, suggestion.maxDocLines),
    },
    docsGardener: {
      ...docsGardener,
      catalogs: preserveExisting
        ? docsGardener.catalogs ?? legacyGardener?.catalogs ?? {}
        : docsGardener.catalogs ?? legacyGardener?.catalogs ?? {},
    },
  };
}

function withExplicitOverrides(config: JsonObject, explicit: Partial<ConfigSuggestion>): JsonObject {
  const project = { ...asObject(config.project) };
  const codelint = { ...asObject(config.codelint) };
  const doclint = { ...asObject(config.doclint) };
  if (explicit.baseBranch !== undefined) project.baseBranch = explicit.baseBranch;
  if (explicit.codeExt !== undefined) project.codeExt = explicit.codeExt;
  if (explicit.codeDirs !== undefined) project.codeDirs = explicit.codeDirs;
  if (explicit.docsDir !== undefined) project.docsDir = explicit.docsDir;
  if (explicit.lintDirs !== undefined) codelint.lintDirs = explicit.lintDirs;
  if (explicit.maxCodeLines !== undefined) codelint.maxLines = explicit.maxCodeLines;
  if (explicit.maxDocLines !== undefined) doclint.maxLines = explicit.maxDocLines;
  return { ...config, project, codelint, doclint };
}

function normalizedUnified(config: JsonObject, suggestion: ConfigSuggestion): JsonObject {
  const project = asObject(config.project);
  const codelint = asObject(config.codelint);
  const doclint = asObject(config.doclint);
  const docsGardener = asObject(config.docsGardener);
  return {
    ...config,
    project: {
      ...project,
      baseBranch: stringOr(project.baseBranch, suggestion.baseBranch),
      codeExt: codeExtOr(project.codeExt, suggestion.codeExt),
      codeDirs: arrayOr(project.codeDirs, suggestion.codeDirs),
      docsDir: stringOr(project.docsDir, suggestion.docsDir),
    },
    codelint: {
      ...codelint,
      lintDirs: arrayOr(codelint.lintDirs, suggestion.lintDirs),
      maxLines: numberOr(codelint.maxLines, suggestion.maxCodeLines),
    },
    doclint: {
      ...doclint,
      maxLines: numberOr(doclint.maxLines, suggestion.maxDocLines),
    },
    docsGardener: {
      ...docsGardener,
      catalogs: docsGardener.catalogs ?? {},
    },
  };
}

export function compatConfigs(existing: Record<string, JsonObject | null>, unified: JsonObject): Record<string, JsonObject> {
  const project = asObject(unified.project);
  const codelint = asObject(unified.codelint);
  const doclint = asObject(unified.doclint);
  const docsGardener = asObject(unified.docsGardener);
  return {
    "codelint.json": {
      ...(existing["codelint.json"] ?? {}),
      lintDirs: codelint.lintDirs,
      codeDirs: project.codeDirs,
      codeExt: project.codeExt,
      baseBranch: project.baseBranch,
      maxLines: codelint.maxLines,
    },
    "doclint.json": {
      ...(existing["doclint.json"] ?? {}),
      docsDir: project.docsDir,
      codeDirs: project.codeDirs,
      codeExt: project.codeExt,
      baseBranch: project.baseBranch,
      maxLines: doclint.maxLines,
    },
    "docs-gardener.json": {
      ...(existing["docs-gardener.json"] ?? {}),
      docsDir: project.docsDir,
      codeDirs: project.codeDirs,
      codeExt: project.codeExt,
      baseBranch: project.baseBranch,
      catalogs: docsGardener.catalogs ?? {},
    },
  };
}

export function ensureConfigDefaults(root: string, options: { dryRun?: boolean } = {}): ConfigCheckResult {
  const suggestion = defaultSuggestion(root);
  return applyConfig(root, suggestion, { preserveExisting: true, dryRun: options.dryRun ?? false, mode: "shared" });
}

function runtimeRequiredFieldIssues(raw: JsonObject): string[] {
  const issues: string[] = [];
  const project = asObject(raw.project);
  const codelint = asObject(raw.codelint);
  const requiredProjectFields = ["baseBranch", "codeExt", "codeDirs", "docsDir"];

  for (const field of requiredProjectFields) {
    if (!hasOwn(project, field)) issues.push(`${UNIFIED_CONFIG_FILE} project.${field} is required at runtime`);
  }
  if (!hasOwn(codelint, "lintDirs")) issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs is required at runtime`);

  if (Array.isArray(project.codeDirs) && project.codeDirs.length === 0) {
    issues.push(`${UNIFIED_CONFIG_FILE} project.codeDirs must not be empty at runtime`);
  }
  if (Array.isArray(codelint.lintDirs) && codelint.lintDirs.length === 0) {
    issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs must not be empty at runtime`);
  }
  return issues;
}

function inspectRuntimeConfig(root: string, suggestion: ConfigSuggestion): { config: JsonObject | null; issues: string[]; missing: boolean } {
  const source = path.join(root, UNIFIED_CONFIG_FILE);
  const unifiedRead = readJsonPath(source, UNIFIED_CONFIG_FILE);
  if (!unifiedRead.value) {
    const missing = !fs.existsSync(source);
    return {
      config: null,
      issues: [unifiedRead.issue ?? `Missing project config: ${source}`],
      missing,
    };
  }
  const unified = normalizedUnified(unifiedRead.value, suggestion);
  const issues = [
    ...validateUnifiedConfig(root, unifiedRead.value, unified, { checkExists: false }),
    ...runtimeRequiredFieldIssues(unifiedRead.value),
  ];
  return { config: issues.length ? null : unified, issues: [...new Set(issues)], missing: false };
}

export function readUnifiedConfig(root: string, suggestion = defaultSuggestion(root)): JsonObject | null {
  return inspectRuntimeConfig(root, suggestion).config;
}

export function requireRuntimeBaseBranch(root: string): string {
  const source = path.join(root, UNIFIED_CONFIG_FILE);
  const unifiedRead = readJsonPath(source, UNIFIED_CONFIG_FILE);
  if (!unifiedRead.value) {
    throw new RuntimeConfigError(root, [unifiedRead.issue ?? `Missing project config: ${source}`], !fs.existsSync(source));
  }
  const projectValue = unifiedRead.value.project;
  const project = projectValue && typeof projectValue === "object" && !Array.isArray(projectValue) ? projectValue as JsonObject : null;
  const issues: string[] = [];
  if (!project) issues.push(`${UNIFIED_CONFIG_FILE} project must be an object; got ${typeName(projectValue)}`);
  else if (!hasOwn(project, "baseBranch")) issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch is required at runtime`);
  else if (typeof project.baseBranch !== "string") issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch must be a string; got ${typeName(project.baseBranch)}`);
  else if (!isSafeConfigRefName(project.baseBranch)) issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch is not a safe Git branch name: ${project.baseBranch}`);
  if (issues.length) throw new RuntimeConfigError(root, issues, false);
  return project!.baseBranch as string;
}

export function requireRuntimeConfig(root: string, suggestion = defaultSuggestion(root)): JsonObject {
  const inspected = inspectRuntimeConfig(root, suggestion);
  if (!inspected.config) throw new RuntimeConfigError(root, inspected.issues, inspected.missing);
  return inspected.config;
}

type CompatSnapshot = {
  filePath: string;
  existed: boolean;
  text: string | null;
  value: JsonObject | null;
};

export function withRuntimeCompatConfigs<T>(root: string, run: () => T): T {
  const suggestion = defaultSuggestion(root);
  const unified = requireRuntimeConfig(root, suggestion);
  const snapshots: CompatSnapshot[] = [];
  for (const file of COMPAT_CONFIG_FILES) {
    const filePath = path.join(root, file);
    const existed = fs.existsSync(filePath);
    snapshots.push({
      filePath,
      existed,
      text: existed ? fs.readFileSync(filePath, "utf-8") : null,
      value: readJsonFile(root, file).value,
    });
  }
  const existing = Object.fromEntries(COMPAT_CONFIG_FILES.map((file, index) => [file, snapshots[index].value]));
  const configs = compatConfigs(existing, unified);
  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  try {
    for (const [file, value] of Object.entries(configs)) {
      fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n", "utf-8");
    }
    result = run();
  } catch (caught) {
    operationFailed = true;
    operationError = caught;
  }

  const restoreErrors: unknown[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.existed && snapshot.text !== null) fs.writeFileSync(snapshot.filePath, snapshot.text, "utf-8");
      else fs.rmSync(snapshot.filePath, { force: true });
    } catch (caught) {
      restoreErrors.push(caught);
    }
  }
  if (restoreErrors.length) {
    if (operationFailed) {
      throw new AggregateError([operationError, ...restoreErrors], "Runtime compatibility config operation and restoration failed.");
    }
    if (restoreErrors.length === 1) throw restoreErrors[0];
    throw new AggregateError(restoreErrors, "Runtime compatibility config restoration failed.");
  }
  if (operationFailed) throw operationError;
  return result;
}

function preservedKeys(before: JsonObject | null, after: JsonObject): string[] {
  if (!before) return Object.keys(after);
  return Object.keys(before).filter(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

export function applyConfig(root: string, suggestion: ConfigSuggestion, options: { preserveExisting: boolean; dryRun: boolean; mode?: string; overrides?: Partial<ConfigSuggestion> }): ConfigCheckResult {
  const targetPath = path.join(root, UNIFIED_CONFIG_FILE);
  const targetRead = readJsonPath(targetPath, UNIFIED_CONFIG_FILE);
  const localPath = projectPaths(root).config;
  const localRead = targetRead.value || targetRead.issue
    ? { value: null, issue: null }
    : readJsonPath(localPath, "local project config");
  const effectiveRead = targetRead.value || targetRead.issue ? targetRead : localRead;
  const compatReads = {
    "codelint.json": readJsonFile(root, "codelint.json"),
    "doclint.json": readJsonFile(root, "doclint.json"),
    "docs-gardener.json": readJsonFile(root, "docs-gardener.json"),
  };
  const useCompatMigration = !effectiveRead.value && !effectiveRead.issue;
  const ignoredCompat = { value: null, issue: null };
  const reads = {
    [UNIFIED_CONFIG_FILE]: effectiveRead,
    "codelint.json": useCompatMigration ? compatReads["codelint.json"] : ignoredCompat,
    "doclint.json": useCompatMigration ? compatReads["doclint.json"] : ignoredCompat,
    "docs-gardener.json": useCompatMigration ? compatReads["docs-gardener.json"] : ignoredCompat,
  };
  const readIssues = [reads[UNIFIED_CONFIG_FILE].issue];
  if (useCompatMigration) {
    readIssues.push(compatReads["codelint.json"].issue, compatReads["doclint.json"].issue, compatReads["docs-gardener.json"].issue);
  }
  const blockingReadIssues = readIssues.filter((issue): issue is string => Boolean(issue));
  if (blockingReadIssues.length) return configResult(root, suggestion, blockingReadIssues, [], false);

  const before = {
    [UNIFIED_CONFIG_FILE]: reads[UNIFIED_CONFIG_FILE].value,
    "codelint.json": reads["codelint.json"].value,
    "doclint.json": reads["doclint.json"].value,
    "docs-gardener.json": reads["docs-gardener.json"].value,
  };
  const merged = unifiedFromInputs(before[UNIFIED_CONFIG_FILE], before, suggestion, options.preserveExisting);
  const unified = normalizedUnified(withExplicitOverrides(merged, options.overrides ?? {}), suggestion);
  const validationIssues = validateUnifiedConfig(root, unified, unified);
  if (validationIssues.length) return configResult(root, suggestion, validationIssues, [], false);

  const after = { [UNIFIED_CONFIG_FILE]: unified };
  const changed: string[] = [];
  const preserved: Record<string, string[]> = {};
  for (const file of [UNIFIED_CONFIG_FILE]) {
    const prev = before[file as keyof typeof before];
    const next = after[file as keyof typeof after];
    if (!fs.existsSync(targetPath) || JSON.stringify(prev) !== JSON.stringify(next)) changed.push(file);
    preserved[file] = preservedKeys(prev, next);
    if (!options.dryRun) {
      writeJson(root, file, next);
    }
  }
  const result = options.dryRun ? configResult(root, suggestion, [], [], false) : checkConfig(root, suggestion);
  return {
    ...result,
    changed,
    preserved,
    dryRun: options.dryRun,
    source: targetPath,
    candidate: unified,
    display: {
      title: options.dryRun ? "Config dry run complete" : result.ok ? "Config updated" : "Config update needs attention",
      body: (options.dryRun ? "Would update " : "Updated ") + (changed.length ? targetPath : "no config files") + " while preserving unknown fields.",
    },
    hint: result.ok ? "Rerun hy_init after applying config changes so setup artifacts and workflow state can be validated." : result.hint,
  };
}

function valueArray(value: any): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function valueCodeExtArray(value: any): string[] {
  return normalizeCodeExt(value);
}

function addDrift(drift: ConfigDrift[], file: string, field: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    drift.push({ file, field, expected, actual });
  }
}

const UNSAFE_CONFIG_CHARS = /[\x00-\x20~^:?*\[\\;$`"'|&<>]/;

function isSafeConfigRefName(value: string): boolean {
  if (!value || value.length > 200 || value.trim() !== value) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (UNSAFE_CONFIG_CHARS.test(value)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  return value.split("/").every(part => Boolean(part) && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 200 || value.trim() !== value) return false;
  if (path.isAbsolute(value) || value.startsWith("-") || value.startsWith("../") || value === "..") return false;
  if (value.includes("..") || value.includes("//") || UNSAFE_CONFIG_CHARS.test(value)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function compareCompat(file: string, actual: JsonObject | null, expected: JsonObject, fields: string[]): ConfigDrift[] {
  const drift: ConfigDrift[] = [];
  if (!actual) return drift;
  for (const field of fields) addDrift(drift, file, field, expected[field], actual[field]);
  return drift;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function objectField(raw: JsonObject, key: string, issues: string[]): JsonObject {
  if (!hasOwn(raw, key)) return {};
  const value = raw[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  issues.push(`${UNIFIED_CONFIG_FILE} ${key} must be an object; got ${typeName(value)}`);
  return {};
}

function validateStringField(raw: JsonObject, key: string, field: string, issues: string[]): void {
  if (hasOwn(raw, key) && typeof raw[key] !== "string") {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field} must be a string; got ${typeName(raw[key])}`);
  }
}

function validateStringArrayField(raw: JsonObject, key: string, field: string, issues: string[]): void {
  if (!hasOwn(raw, key)) return;
  const value = raw[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field} must be an array of strings; got ${typeName(value)}`);
  }
}

function validateCodeExtField(raw: JsonObject, issues: string[]): void {
  if (!hasOwn(raw, "codeExt")) return;
  const value = raw.codeExt;
  if (typeof value === "string") return;
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return;
  issues.push(`${UNIFIED_CONFIG_FILE} project.codeExt must be a string or an array of strings; got ${typeName(value)}`);
}

function validateNumberField(raw: JsonObject, key: string, field: string, issues: string[]): void {
  if (!hasOwn(raw, key)) return;
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field} must be a finite number; got ${typeName(value)}`);
  }
}

function validateObjectField(raw: JsonObject, key: string, field: string, issues: string[]): void {
  if (!hasOwn(raw, key)) return;
  const value = raw[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field} must be an object; got ${typeName(value)}`);
  }
}

function validateUnifiedConfig(root: string, raw: JsonObject, unified: JsonObject, options: { checkExists?: boolean } = {}): string[] {
  const issues: string[] = [];
  const projectRaw = objectField(raw, "project", issues);
  const codelintRaw = objectField(raw, "codelint", issues);
  const doclintRaw = objectField(raw, "doclint", issues);
  const docsGardenerRaw = objectField(raw, "docsGardener", issues);
  const projectConfig = asObject(unified.project);
  const codelintConfig = asObject(unified.codelint);
  const checkExists = options.checkExists ?? true;

  validateStringField(projectRaw, "baseBranch", "project.baseBranch", issues);
  validateCodeExtField(projectRaw, issues);
  validateStringArrayField(projectRaw, "codeDirs", "project.codeDirs", issues);
  validateStringField(projectRaw, "docsDir", "project.docsDir", issues);
  validateStringArrayField(codelintRaw, "lintDirs", "codelint.lintDirs", issues);
  validateNumberField(codelintRaw, "maxLines", "codelint.maxLines", issues);
  validateNumberField(doclintRaw, "maxLines", "doclint.maxLines", issues);
  validateObjectField(docsGardenerRaw, "catalogs", "docsGardener.catalogs", issues);

  issues.push(...validateCodeExt(projectConfig.codeExt).map(issue => `${UNIFIED_CONFIG_FILE} ${issue}`));
  if (typeof projectConfig.baseBranch !== "string") issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch must be a string; got ${typeName(projectConfig.baseBranch)}`);
  else if (!isSafeConfigRefName(projectConfig.baseBranch)) issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch is not a safe Git branch name: ${projectConfig.baseBranch}`);
  if (typeof projectConfig.docsDir !== "string") issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir must be a string; got ${typeName(projectConfig.docsDir)}`);
  else if (!projectConfig.docsDir) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir is required; no documentation directory was detected. Pass --docs-dir with an existing project-relative directory.`);
  else if (!isSafeRelativePath(projectConfig.docsDir)) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir is not a safe relative path: ${projectConfig.docsDir}`);
  else if (checkExists && !directoryExists(root, projectConfig.docsDir)) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir is not an existing directory: ${projectConfig.docsDir}`);

  if (!valueCodeExtArray(projectConfig.codeExt).length) issues.push(`${UNIFIED_CONFIG_FILE} project.codeExt is empty`);
  for (const dir of valueArray(projectConfig.codeDirs)) {
    if (!isSafeRelativePath(dir)) issues.push(`${UNIFIED_CONFIG_FILE} project.codeDirs entry is not a safe relative path: ${dir}`);
    else if (checkExists && !exists(root, dir)) issues.push(`${UNIFIED_CONFIG_FILE} project.codeDirs entry does not exist: ${dir}`);
  }
  for (const dir of valueArray(codelintConfig.lintDirs)) {
    if (!isSafeRelativePath(dir)) issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs entry is not a safe relative path: ${dir}`);
    else if (checkExists && !exists(root, dir)) issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs entry does not exist: ${dir}`);
  }

  return [...new Set(issues)];
}

function migrationInput(root: string): JsonObject | null {
  const rootRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
  if (rootRead.value) return rootRead.value;
  if (rootRead.issue || fs.existsSync(path.join(root, UNIFIED_CONFIG_FILE))) return null;
  return readJsonPath(projectPaths(root).config, "local project config").value;
}

function buildDocsRecoveryCommand(): string {
  return ["hy-workflow config", "--apply", "--json", "--docs-dir", "existing-docs-dir"].join(" ");
}

function buildMigrationCommand(): string {
  return "hy-workflow config --apply --json";
}

function configResult(root: string, suggestion: ConfigSuggestion, issues: string[], drift: ConfigDrift[], ambiguous: boolean): ConfigCheckResult {
  const project = detectProject(root);
  const existing = migrationInput(root);
  const existingDocsDir = asObject(existing?.project).docsDir;
  const recoveryDocsDir = directoryExists(root, suggestion.docsDir)
    ? suggestion.docsDir
    : typeof existingDocsDir === "string" && directoryExists(root, existingDocsDir) ? existingDocsDir : "";
  const recoverySuggestion = { ...suggestion, docsDir: recoveryDocsDir };
  const docsIssue = issues.some(issue => issue.includes("project.docsDir"));
  const missingRuntimeField = issues.some(issue => issue.endsWith(" is required at runtime"));
  const suggestedCommand = docsIssue && existing
    ? buildDocsRecoveryCommand()
    : existing && (!fs.existsSync(path.join(root, UNIFIED_CONFIG_FILE)) || missingRuntimeField)
      ? buildMigrationCommand()
    : buildSuggestedCommand(recoverySuggestion, ambiguous);
  const ok = issues.length === 0 && !ambiguous;
  const driftBody = !ok && drift.length
    ? ["", "Config drift:", ...drift.map(item => `- ${item.file}.${item.field}: expected ${JSON.stringify(item.expected)}, actual ${JSON.stringify(item.actual)}`)].join("\n")
    : "";
  return {
    ok,
    phase: "config",
    next: "config",
    display: {
      title: ok ? "Config looks consistent" : "Project config needs confirmation",
      body: ok
        ? `${UNIFIED_CONFIG_FILE} is the source of truth; compatibility JSON is materialized only at runtime when legacy CLIs need it.`
        : `${issues.length ? issues.join("\n") : `Project type is ${project.kind}; explicit confirmation is required.`}${driftBody}

Suggested command:
${suggestedCommand}`,
    },
    hint: ok ? "Continue with hy_init or the requested workflow task." : "Show display.body and run the suggested config command only after user approval.",
    requires_user: ok ? false : true,
    stop_here: ok ? false : true,
    allowedTools: ok ? ["hy_init", "hy_status"] : ["terminal", "hy_init", "hy_status"],
    recovery: ok ? undefined : { tool: "terminal", instruction: suggestedCommand },
    project,
    issues,
    drift,
    suggestion,
    suggestedCommand,
  };
}

export function checkConfig(root: string, suggestion = defaultSuggestion(root)): ConfigCheckResult {
  const project = detectProject(root);
  const issues: string[] = [];
  const drift: ConfigDrift[] = [];
  const source = path.join(root, UNIFIED_CONFIG_FILE);
  const unifiedRead = readJsonPath(source, UNIFIED_CONFIG_FILE);
  const codelintRead = readJsonFile(root, "codelint.json");
  const doclintRead = readJsonFile(root, "doclint.json");
  const gardenerRead = readJsonFile(root, "docs-gardener.json");
  const unifiedRaw = unifiedRead.value;
  const codelint = codelintRead.value;
  const doclint = doclintRead.value;
  const gardener = gardenerRead.value;

  if (unifiedRead.issue) issues.push(unifiedRead.issue);
  if (!unifiedRaw && !unifiedRead.issue) issues.push("Missing project config: " + source);
  if (!unifiedRaw) {
    for (const issue of [codelintRead.issue, doclintRead.issue, gardenerRead.issue]) {
      if (issue) issues.push(issue);
    }
  }

  const unified = normalizedUnified(
    unifiedRaw ?? unifiedFromInputs(null, { "codelint.json": codelint, "doclint.json": doclint, "docs-gardener.json": gardener }, suggestion, true),
    suggestion,
  );
  const projectConfig = asObject(unified.project);
  const expectedCompat = compatConfigs({ "codelint.json": codelint, "doclint.json": doclint, "docs-gardener.json": gardener }, unified);

  if (unifiedRaw) {
    issues.push(...validateUnifiedConfig(root, unifiedRaw, unified));
    issues.push(...runtimeRequiredFieldIssues(unifiedRaw));
  }

  drift.push(...compareCompat("codelint.json", codelint, expectedCompat["codelint.json"], ["lintDirs", "codeDirs", "codeExt", "baseBranch", "maxLines"]));
  drift.push(...compareCompat("doclint.json", doclint, expectedCompat["doclint.json"], ["docsDir", "codeDirs", "codeExt", "baseBranch", "maxLines"]));
  drift.push(...compareCompat("docs-gardener.json", gardener, expectedCompat["docs-gardener.json"], ["docsDir", "codeDirs", "codeExt", "baseBranch", "catalogs"]));
  const explicitConfigReady = Boolean(
    unifiedRaw &&
    valueCodeExtArray(projectConfig.codeExt).length &&
    valueArray(projectConfig.codeDirs).length &&
    valueArray(asObject(unified.codelint).lintDirs).length &&
    projectConfig.docsDir,
  );
  const ambiguous = (project.kind === "mixed" || project.kind === "unknown") && !explicitConfigReady;
  return { ...configResult(root, suggestion, [...new Set(issues)], drift, ambiguous), source, candidate: unified };
}

function portableCommandArg(value: string, label: string): string {
  if (value && !value.startsWith("-") && /^[A-Za-z0-9._/,-]+$/.test(value)) return value;
  return `INVALID_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function buildSuggestedCommand(suggestion: ConfigSuggestion, needsExplicit = false): string {
  const mode = !suggestion.docsDir ? "--apply" : needsExplicit ? "--dry-run" : "--apply-suggested";
  const docsDir = suggestion.docsDir || "existing-docs-dir";
  return [
    "hy-workflow config",
    mode,
    "--json",
    "--code-ext", portableCommandArg(formatCodeExt(suggestion.codeExt), "code_ext"),
    "--code-dirs", portableCommandArg(suggestion.codeDirs.join(","), "code_dirs"),
    "--lint-dirs", portableCommandArg(suggestion.lintDirs.join(","), "lint_dirs"),
    "--docs-dir", portableCommandArg(docsDir, "docs_dir"),
    "--base-branch", portableCommandArg(suggestion.baseBranch, "base_branch"),
  ].join(" ");
}

function parseList(value: string | undefined): string[] | undefined {
  return value ? value.split(",").map(item => item.trim()).filter(Boolean) : undefined;
}

function parseArgs(argv: string[]): ConfigArgs {
  const args: ConfigArgs = { mode: "check", json: false, dryRun: false, applySuggested: false, shared: false, explicit: {}, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (flag: string): string | undefined => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        args.errors.push(`Missing value for ${flag}`);
        return undefined;
      }
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") args.mode = "help";
    else if (arg === "--json") args.json = true;
    else if (arg === "--check") args.mode = "check";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--shared") args.shared = true;
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "--apply-suggested") { args.mode = "apply"; args.applySuggested = true; }
    else if (arg === "--python") args.explicit.codeExt = ".py";
    else if (arg === "--typescript") args.explicit.codeExt = ".ts";
    else if (arg === "--code-ext") {
      const value = next(arg);
      if (value !== undefined) args.explicit.codeExt = value;
    }
    else if (arg === "--code-dirs") {
      const value = next(arg);
      if (value !== undefined) args.explicit.codeDirs = parseList(value);
    }
    else if (arg === "--lint-dirs") {
      const value = next(arg);
      if (value !== undefined) args.explicit.lintDirs = parseList(value);
    }
    else if (arg === "--docs-dir") {
      const value = next(arg);
      if (value !== undefined) args.explicit.docsDir = value;
    }
    else if (arg === "--base-branch") {
      const value = next(arg);
      if (value !== undefined) args.explicit.baseBranch = value;
    }
    else if (arg.startsWith("-")) args.errors.push(`Unknown config option: ${arg}`);
    else args.errors.push(`Unexpected config argument: ${arg}`);
  }
  if (args.dryRun) args.mode = "apply";
  return args;
}

export function configHelp(): string {
  return [
    "hy-workflow",
    "",
    "Usage:",
    "  hy-workflow                 Start MCP stdio server",
    "  hy-workflow setup           Configure MCP clients and shared project checks",
    "  hy-workflow unset           Remove the local project deployment",
    "  hy-workflow --version       Show the installed package version",
    "  hy-workflow --help          Show this help",
    "  hy-workflow config --check --json",
    "  hy-workflow config --apply --json --docs-dir docs",
    "  hy-workflow config --apply-suggested --json",
    "  hy-workflow config --python --code-dirs src,test --docs-dir docs --base-branch dev --json",
    "",
    "Project config is stored in hy-workflow.json.",
    "Config commands emit a single JSON envelope when --json is passed.",
  ].join("\n");
}

export function runConfigCli(argv: string[], root = process.cwd()): { exitCode: number; stdout: string } {
  const args = parseArgs(argv);
  if (args.mode === "help") return { exitCode: 0, stdout: configHelp() + "\n" };
  const suggestion = mergeSuggestion(root, args.explicit);
  if (!args.explicit.lintDirs && args.explicit.codeDirs) suggestion.lintDirs = args.explicit.codeDirs;
  const result = args.errors.length
    ? configResult(root, suggestion, args.errors, [], false)
    : args.mode === "apply"
      ? applyConfig(root, suggestion, {
          preserveExisting: !args.applySuggested,
          dryRun: args.dryRun,
          mode: "shared",
          overrides: args.applySuggested ? undefined : args.explicit,
        })
      : checkConfig(root, suggestion);
  return { exitCode: result.ok ? 0 : 1, stdout: args.json ? JSON.stringify(result, null, 2) + "\n" : `${result.display.title}
${result.display.body}
` };
}
