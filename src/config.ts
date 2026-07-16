import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { codeExtOr, formatCodeExt, normalizeCodeExt, type CodeExt, validateCodeExt } from "./code_ext.js";
import { inspectProject, type ProfileConfidence, type ProjectKind as ProfileProjectKind } from "./project-profile.js";
import { MANAGED_RULES_VERSION } from "./policy/docs.js";
import { atomicWriteJson, atomicWriteText, projectPaths, userRoots } from "./runtime/user-paths.js";
import { internalSetupTestHooks } from "./setup/test-hooks.js";

export type ProjectKind = ProfileProjectKind;

export type JsonObject = Record<string, any>;

export type ConfigSuggestion = {
  codeExt: CodeExt;
  codeDirs: string[];
  lintDirs: string[];
  docsDir: string;
  baseBranch: string;
  maxCodeLines: number;
  maxDocLines: number;
  ciCommands: string[];
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
    confidence?: ProfileConfidence;
    ecosystems?: string[];
    ambiguous?: boolean;
    issues?: string[];
    ciCandidates?: string[];
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

function pathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvesInsideProject(root: string, rel: string): boolean {
  try {
    const project = path.resolve(root);
    const candidate = path.resolve(project, rel);
    if (!pathInside(project, candidate)) return false;
    const canonicalRoot = fs.realpathSync(project);
    let existing = candidate;
    while (!fs.existsSync(existing) && existing !== project) existing = path.dirname(existing);
    return pathInside(canonicalRoot, fs.realpathSync(existing));
  } catch {
    return false;
  }
}

function symlinkComponent(root: string, rel: string): string | null {
  const project = path.resolve(root);
  const target = path.resolve(project, rel);
  if (!pathInside(project, target)) return target;
  let current = project;
  for (const segment of path.relative(project, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) return current; }
    catch (error: any) { if (error?.code === "ENOENT") break; else throw error; }
  }
  return null;
}

function exists(root: string, rel: string): boolean {
  return resolvesInsideProject(root, rel) && fs.existsSync(path.join(root, rel));
}

function directoryExists(root: string, rel: string): boolean {
  try { return Boolean(rel) && resolvesInsideProject(root, rel) && fs.statSync(path.join(root, rel)).isDirectory(); }
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
  const unsafeLink = symlinkComponent(root, rel);
  if (unsafeLink || !resolvesInsideProject(root, rel)) {
    return { value: null, issue: `${rel} must be a normal file inside the project; unsafe path component: ${unsafeLink ?? filePath}` };
  }
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
  const unsafeLink = symlinkComponent(root, rel);
  if (unsafeLink || !resolvesInsideProject(root, rel)) throw new Error(`${rel} must be a normal file inside the project; unsafe path component: ${unsafeLink ?? filePath}`);
  const next = JSON.stringify(value, null, 2) + "\n";
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  if (prev === next) return false;
  atomicWriteText(filePath, next, 0o644);
  return true;
}

function listFiles(root: string, dir: string, ext: string): string[] {
  const start = path.join(root, dir);
  if (!resolvesInsideProject(root, dir) || !fs.existsSync(start)) return [];
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
  if (!resolvesInsideProject(root, dir) || !fs.existsSync(start)) return [];
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

function directoryHasMarkdown(root: string, dir: string): boolean {
  return listFileExts(root, dir).some(ext => ext === ".md");
}

export function detectProject(root: string): ConfigCheckResult["project"] {
  const profile = inspectProject(root);
  return {
    kind: profile.kind,
    evidence: profile.evidence,
    confidence: profile.confidence,
    ecosystems: profile.ecosystems,
    ambiguous: profile.ambiguous,
    issues: profile.issues,
    ciCandidates: profile.ciCandidates,
  };
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
  const profile = inspectProject(root);
  return {
    codeExt: profile.codeExt,
    codeDirs: profile.codeDirs,
    lintDirs: profile.lintDirs,
    docsDir: profile.docsDir,
    baseBranch: profile.baseBranch,
    maxCodeLines: 500,
    maxDocLines: 200,
    ciCommands: profile.ciCandidates,
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
  const ci = asObject(existing?.ci);
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
    ...(existing && hasOwn(existing, "ci") ? {
      ci: { ...ci, commands: Array.isArray(ci.commands) ? ci.commands : [] },
    } : {}),
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
  const ci = asObject(config.ci);
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
    ...(hasOwn(config, "ci") ? { ci: { ...ci, commands: arrayOr(ci.commands, []) } } : {}),
  };
}

export function validateCiCommands(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    return [`${UNIFIED_CONFIG_FILE} ci.commands must be an array of strings; got ${typeName(value)}`];
  }
  if (value.length === 0) return [`${UNIFIED_CONFIG_FILE} ci.commands must not be empty when configured`];
  const issues: string[] = [];
  for (const command of value) {
    if (!command.trim()) issues.push(`${UNIFIED_CONFIG_FILE} ci.commands entries must not be blank`);
    else if (command !== command.trim()) issues.push(`${UNIFIED_CONFIG_FILE} ci.commands entries must not have surrounding whitespace`);
    else if (command.length > 500 || /[\0\r\n]/.test(command)) issues.push(`${UNIFIED_CONFIG_FILE} ci.commands entry is not a bounded single-line command`);
  }
  return [...new Set(issues)];
}

export function withConfirmedCiCommands(config: JsonObject, commands: string[]): JsonObject {
  const issues = validateCiCommands(commands);
  if (issues.length) throw new Error(issues.join("; "));
  return { ...config, ci: { ...asObject(config.ci), commands: [...commands] } };
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
  const unifiedRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
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
  const unifiedRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
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
  beforeHash: string | null;
  mode: number | null;
  value: JsonObject | null;
  generatedText: string;
  generatedHash: string;
};

type CompatJournal = {
  schemaVersion: "1";
  id: string;
  projectRoot: string;
  pid: number;
  host: string;
  startedAt: string;
  resources: CompatSnapshot[];
};

class RuntimeCompatError extends Error {
  readonly type = "config" as const;
  readonly subtype = "config_invalid" as const;
  readonly retryable: boolean;

  constructor(readonly code: string, message: string, readonly hint: string, readonly detail?: unknown, retryable = false) {
    super(message);
    this.name = "RuntimeCompatError";
    this.retryable = retryable;
    Object.defineProperty(this, "message", { enumerable: true, configurable: true, writable: true, value: this.message });
  }
}

function compatHash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compatCurrentHash(file: string): string | null {
  return fs.existsSync(file) ? compatHash(fs.readFileSync(file)) : null;
}

function compatJournalPath(root: string): string {
  return path.join(projectPaths(root).stateDir, "compat-journal.json");
}

function compatLockPath(root: string): string {
  const identity = projectPaths(root).identity;
  // The lock must live outside the project state directory: unset stages that
  // whole directory, but must keep excluding new compatibility operations until
  // its transaction has committed or rolled back.
  return path.join(userRoots().state, "compat-locks", `${identity.id}.lock`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function acquireCompatLock(root: string): () => void {
  const lock = compatLockPath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      atomicWriteJson(path.join(lock, "owner.json"), { pid: process.pid, host: os.hostname(), token, startedAt: new Date().toISOString() });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf-8"));
          if (owner?.token === token) fs.rmSync(lock, { recursive: true, force: true });
        } catch { fs.rmSync(lock, { recursive: true, force: true }); }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let owner: any = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf-8")); } catch {}
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      const stale = owner?.host === os.hostname() && Number.isInteger(owner?.pid)
        ? !processAlive(owner.pid)
        : !owner && age > 5_000;
      if (stale && attempt === 0) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw new RuntimeCompatError(
        "RUNTIME_COMPAT_LOCK_BUSY",
        "Another compatibility-artifact operation is active.",
        "Wait for the active lint command to finish, then retry. If it crashed, retry after its process exits so recovery can acquire the lock.",
        { lock, owner },
        true,
      );
    }
  }
  throw new RuntimeCompatError("RUNTIME_COMPAT_LOCK_BUSY", "Could not acquire compatibility-artifact lock.", "Retry after the previous process exits.", { lock }, true);
}

function readCompatJournal(root: string): CompatJournal | null {
  const journalFile = compatJournalPath(root);
  if (!fs.existsSync(journalFile)) return null;
  let journal: CompatJournal;
  try { journal = JSON.parse(fs.readFileSync(journalFile, "utf-8")); }
  catch (error: any) {
    throw new RuntimeCompatError("RUNTIME_COMPAT_RECOVERY_REQUIRED", "Compatibility-artifact recovery journal is unreadable.", "Preserve the external journal and repair it before running lint again.", { journalFile, cause: error?.message ?? String(error) });
  }
  const expectedFiles = new Set(COMPAT_CONFIG_FILES.map(file => path.resolve(root, file)));
  if (journal.schemaVersion !== "1" || path.resolve(journal.projectRoot) !== path.resolve(root) || !Array.isArray(journal.resources) || journal.resources.length !== expectedFiles.size || journal.resources.some(item => !expectedFiles.has(path.resolve(item.filePath)))) {
    throw new RuntimeCompatError("RUNTIME_COMPAT_RECOVERY_REQUIRED", "Compatibility-artifact recovery journal does not match this project.", "Preserve the journal and reconcile it manually; no project file was modified.", { journalFile });
  }
  return journal;
}

function recoverCompatLocked(root: string): { recovered: boolean; restored: string[] } {
  const journalFile = compatJournalPath(root);
  const journal = readCompatJournal(root);
  if (!journal) return { recovered: false, restored: [] };
  const conflicts: string[] = [];
  const restored: string[] = [];
  for (const item of [...journal.resources].reverse()) {
    const current = compatCurrentHash(item.filePath);
    if (current === item.beforeHash) continue;
    if (current !== item.generatedHash) {
      conflicts.push(item.filePath);
      continue;
    }
    try {
      if (item.existed && item.text !== null) {
        atomicWriteText(item.filePath, item.text, item.mode ?? 0o600);
        if (item.mode !== null) fs.chmodSync(item.filePath, item.mode);
      } else fs.rmSync(item.filePath, { force: true });
      if (compatCurrentHash(item.filePath) !== item.beforeHash) throw new Error("restored content hash mismatch");
      restored.push(item.filePath);
    } catch (error: any) {
      conflicts.push(`${item.filePath}: ${error?.message ?? String(error)}`);
    }
  }
  if (conflicts.length) {
    throw new RuntimeCompatError(
      "RUNTIME_COMPAT_RECOVERY_REQUIRED",
      "Compatibility artifacts changed while lint was running; automatic recovery refused to overwrite them.",
      "Review the reported files and external journal, restore the intended content, then retry hy_status or hy_verify.",
      { journalFile, conflicts, restored },
    );
  }
  fs.rmSync(journalFile, { force: true });
  return { recovered: true, restored };
}

export function recoverRuntimeCompatConfigs(root: string): { recovered: boolean; restored: string[] } {
  if (!fs.existsSync(compatJournalPath(root)) && !fs.existsSync(compatLockPath(root))) return { recovered: false, restored: [] };
  const release = acquireCompatLock(root);
  try { return recoverCompatLocked(root); }
  finally { release(); }
}

export async function withRuntimeCompatCoordination<T>(root: string, run: () => Promise<T> | T): Promise<T> {
  const release = acquireCompatLock(root);
  try {
    recoverCompatLocked(root);
    return await run();
  } finally {
    release();
  }
}

export function withRuntimeCompatConfigs<T>(root: string, run: () => T): T {
  const release = acquireCompatLock(root);
  try {
    recoverCompatLocked(root);
    const suggestion = defaultSuggestion(root);
    const unified = requireRuntimeConfig(root, suggestion);
    const values: Array<{ file: string; filePath: string; existed: boolean; text: string | null; mode: number | null; value: JsonObject | null }> = [];
    for (const file of COMPAT_CONFIG_FILES) {
      const filePath = path.join(root, file);
      const unsafeLink = symlinkComponent(root, file);
      if (unsafeLink || !resolvesInsideProject(root, file)) {
        throw new RuntimeCompatError("RUNTIME_COMPAT_PATH_UNSAFE", `${file} is not a normal in-repository file.`, "Remove the symlink or escaping path before running lint.", { file, filePath, unsafeLink });
      }
      const existed = fs.existsSync(filePath);
      values.push({ file, filePath, existed, text: existed ? fs.readFileSync(filePath, "utf-8") : null, mode: existed ? fs.statSync(filePath).mode & 0o777 : null, value: readJsonFile(root, file).value });
    }
    const existing = Object.fromEntries(values.map(item => [item.file, item.value]));
    const configs = compatConfigs(existing, unified);
    const snapshots: CompatSnapshot[] = values.map(item => {
      const generatedText = JSON.stringify(configs[item.file], null, 2) + "\n";
      return { ...item, beforeHash: item.text === null ? null : compatHash(item.text), generatedText, generatedHash: compatHash(generatedText) };
    });
    const journal: CompatJournal = {
      schemaVersion: "1",
      id: randomUUID(),
      projectRoot: fs.realpathSync(root),
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      resources: snapshots,
    };
    atomicWriteJson(compatJournalPath(root), journal);
    let operationError: unknown;
    let result!: T;
    try {
      for (const snapshot of snapshots) {
        internalSetupTestHooks().beforeCompatWrite?.(snapshot.filePath);
        const current = compatCurrentHash(snapshot.filePath);
        if (current !== snapshot.beforeHash) {
          throw new RuntimeCompatError(
            "RUNTIME_COMPAT_CONCURRENT_EDIT",
            `Compatibility artifact changed before its temporary materialization: ${snapshot.filePath}`,
            "Preserve the external edit and recovery journal; retry only after reconciling the reported file.",
            { file: snapshot.filePath, beforeHash: snapshot.beforeHash, currentHash: current },
            true,
          );
        }
        atomicWriteText(snapshot.filePath, snapshot.generatedText);
        const written = compatCurrentHash(snapshot.filePath);
        if (written !== snapshot.generatedHash) {
          throw new RuntimeCompatError("RUNTIME_COMPAT_RECOVERY_REQUIRED", `Compatibility artifact write hash mismatch: ${snapshot.filePath}`, "Preserve the recovery journal and reconcile the file before retrying lint.", { file: snapshot.filePath, expectedHash: snapshot.generatedHash, actualHash: written });
        }
      }
      result = run();
    } catch (error) {
      operationError = error;
    }
    let recoveryError: unknown;
    try { recoverCompatLocked(root); }
    catch (error) { recoveryError = error; }
    if (operationError && recoveryError) {
      throw new AggregateError([operationError, recoveryError], "Runtime compatibility config operation and durable recovery failed.");
    }
    if (recoveryError) throw recoveryError;
    if (operationError) throw operationError;
    return result;
  } finally {
    release();
  }
}

function preservedKeys(before: JsonObject | null, after: JsonObject): string[] {
  if (!before) return Object.keys(after);
  return Object.keys(before).filter(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

export function applyConfig(root: string, suggestion: ConfigSuggestion, options: { preserveExisting: boolean; dryRun: boolean; mode?: string; overrides?: Partial<ConfigSuggestion> }): ConfigCheckResult {
  const targetPath = path.join(root, UNIFIED_CONFIG_FILE);
  const targetRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
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

  const detected = detectProject(root);
  const fullyExplicit = Boolean(
    options.overrides?.codeExt && options.overrides?.codeDirs?.length && options.overrides?.lintDirs?.length &&
    options.overrides?.docsDir && options.overrides?.baseBranch
  );
  const explicitInput = Boolean(effectiveRead.value) || fullyExplicit;
  const ambiguousGitInference = Boolean(detected.ambiguous)
    && detected.evidence.some(item => item.startsWith("project files (git):"))
    && !explicitInput;
  if (ambiguousGitInference) {
    return { ...configResult(root, suggestion, [], [], true), source: targetPath, candidate: unified, dryRun: options.dryRun };
  }

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
  const ciRaw = objectField(raw, "ci", issues);
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
  if (hasOwn(raw, "ci")) {
    if (!hasOwn(ciRaw, "commands")) issues.push(`${UNIFIED_CONFIG_FILE} ci.commands is required when ci is configured`);
    else issues.push(...validateCiCommands(ciRaw.commands));
  }

  issues.push(...validateCodeExt(projectConfig.codeExt).map(issue => `${UNIFIED_CONFIG_FILE} ${issue}`));
  if (typeof projectConfig.baseBranch !== "string") issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch must be a string; got ${typeName(projectConfig.baseBranch)}`);
  else if (!isSafeConfigRefName(projectConfig.baseBranch)) issues.push(`${UNIFIED_CONFIG_FILE} project.baseBranch is not a safe Git branch name: ${projectConfig.baseBranch}`);
  if (typeof projectConfig.docsDir !== "string") issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir must be a string; got ${typeName(projectConfig.docsDir)}`);
  else if (!projectConfig.docsDir) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir is required; no documentation directory was detected. Pass --docs-dir with an existing project-relative directory.`);
  else if (!isSafeRelativePath(projectConfig.docsDir)) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir is not a safe relative path: ${projectConfig.docsDir}`);
  else if (checkExists && !directoryExists(root, projectConfig.docsDir)) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir is not an existing directory: ${projectConfig.docsDir}`);
  else if (checkExists && !directoryHasMarkdown(root, projectConfig.docsDir)) issues.push(`${UNIFIED_CONFIG_FILE} project.docsDir contains no scannable .md files: ${projectConfig.docsDir}`);

  if (!valueCodeExtArray(projectConfig.codeExt).length) issues.push(`${UNIFIED_CONFIG_FILE} project.codeExt is empty`);
  for (const dir of valueArray(projectConfig.codeDirs)) {
    if (!isSafeRelativePath(dir)) issues.push(`${UNIFIED_CONFIG_FILE} project.codeDirs entry is not a safe relative path: ${dir}`);
    else if (checkExists && !directoryExists(root, dir)) issues.push(`${UNIFIED_CONFIG_FILE} project.codeDirs entry is not an existing directory: ${dir}`);
  }
  for (const dir of valueArray(codelintConfig.lintDirs)) {
    if (!isSafeRelativePath(dir)) issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs entry is not a safe relative path: ${dir}`);
    else if (checkExists && !directoryExists(root, dir)) issues.push(`${UNIFIED_CONFIG_FILE} codelint.lintDirs entry is not an existing directory: ${dir}`);
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
  const unifiedRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
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
  const ambiguous = Boolean(project.ambiguous) && !explicitConfigReady;
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
    "  hy-workflow doctor          Diagnose tools, client config, state, and artifact drift",
    "  hy-workflow --version       Show the installed package version",
    "  hy-workflow --help          Show this help",
    "  hy-workflow config --check --json",
    "  hy-workflow config --apply --json --docs-dir docs",
    "  hy-workflow config --apply-suggested --json",
    "  hy-workflow config --print-managed-rules",
    "  hy-workflow config --python --code-dirs src,test --docs-dir docs --base-branch dev --json",
    "",
    "Project config is stored in hy-workflow.json.",
    "Config commands emit a single JSON envelope when --json is passed.",
  ].join("\n");
}

export function managedRulesText(): string {
  const asset = new URL("../AGENTS.md", import.meta.url);
  const content = fs.readFileSync(asset, "utf-8");
  const match = /<!-- hy-workflow-rules -->[\s\S]*?<!-- \/hy-workflow-rules -->/.exec(content);
  if (!match || !match[0].includes(`hy-workflow-rules-version: ${MANAGED_RULES_VERSION}`)) {
    throw new Error(`Packaged managed rules are missing or do not match version ${MANAGED_RULES_VERSION}`);
  }
  return match[0].trimEnd() + "\n";
}

export function runConfigCli(argv: string[], root = process.cwd()): { exitCode: number; stdout: string } {
  if (argv.length === 1 && argv[0] === "--print-managed-rules") return { exitCode: 0, stdout: managedRulesText() };
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
