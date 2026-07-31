import * as fs from "node:fs";
import * as path from "node:path";
import { codeExtOr, formatCodeExt, normalizeCodeExt, type CodeExt, validateCodeExt } from "./code_ext.js";
import { inspectProject, type ProfileConfidence, type ProjectKind as ProfileProjectKind } from "./project-profile.js";
import { explainEffectivePolicy, validatePolicyConfig } from "./policy/effective.js";
import {
  LEGACY_COMPATIBLE_POLICY_PROFILE,
  isImmutableSafetyRule,
  isPolicyProfile,
  isQualityPolicyRule,
  type PolicyRuleId,
} from "./policy/profiles.js";
import { atomicWriteJson, atomicWriteText, projectPaths } from "./runtime/user-paths.js";

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
  error?: {
    type: "config";
    subtype: "invalid_arguments";
    code: "UNKNOWN_OPTION" | "INVALID_ARGUMENTS";
    message: string;
    hint: string;
    retryable: false;
    detail: { issues: string[] };
  };
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
  mode: "check" | "apply" | "help" | "explain-policy";
  json: boolean;
  dryRun: boolean;
  applySuggested: boolean;
  shared: boolean;
  explicit: Partial<ConfigSuggestion>;
  explainRule?: string;
  explainFile?: string;
  errors: string[];
};

export const UNIFIED_CONFIG_FILE = "hy-workflow.json";
export const PROJECT_CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/schemas/hy-workflow.schema.json";
export const PROJECT_CONFIG_VERSION = 1 as const;
export const RUNTIME_CONFIG_SOURCE_SCHEMA = "hy-workflow.runtime-config-source.v1" as const;
export const RUNTIME_CONFIG_SOURCE_ENV = "HY_WORKFLOW_RUNTIME_CONFIG_SOURCE" as const;
const DEFAULT_CODE_WARNING_LINES = 300;
const DEFAULT_CODE_ERROR_LINES = 500;
const DEFAULT_DOC_WARNING_LINES = 200;
const DEFAULT_DOC_ERROR_LINES = 500;

export type RuntimeConfigAuthority = {
  kind: "project" | "external" | "legacy-detected";
  source: string;
};

export type RuntimeConfigResolution = {
  config: JsonObject;
  authority: RuntimeConfigAuthority;
  issues: string[];
};

type SelectedRuntimeConfig = {
  raw: JsonObject | null;
  authority: RuntimeConfigAuthority;
  issues: string[];
  missing: boolean;
  allowLegacyCompatible: boolean;
};

export type ProjectRuntimeConfigSource = {
  schema: typeof RUNTIME_CONFIG_SOURCE_SCHEMA;
  authority: "project";
  source: typeof UNIFIED_CONFIG_FILE;
};

export function projectRuntimeConfigSource(): ProjectRuntimeConfigSource {
  return { schema: RUNTIME_CONFIG_SOURCE_SCHEMA, authority: "project", source: UNIFIED_CONFIG_FILE };
}

export class RuntimeConfigError extends Error {
  readonly type = "config" as const;
  readonly subtype = "config_invalid" as const;
  readonly code: "ROOT_CONFIG_REQUIRED" | "ROOT_CONFIG_INVALID";
  readonly hint = "Run hy-workflow setup in the project root, or repair hy-workflow.json with hy-workflow config --apply --json.";
  readonly retryable = false;
  readonly detail: { source: string; issues: string[] };

  constructor(root: string, issues: string[], missing: boolean, selectedSource = path.join(root, UNIFIED_CONFIG_FILE)) {
    const source = selectedSource;
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
    maxCodeLines: DEFAULT_CODE_ERROR_LINES,
    maxDocLines: DEFAULT_DOC_ERROR_LINES,
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

function lineThresholds(value: JsonObject, warningDefault: number, errorDefault: number): {
  maxLinesWarning: number;
  maxLinesError: number;
} {
  const maxLinesError = numberOr(value.maxLinesError, numberOr(value.maxLines, errorDefault));
  return {
    maxLinesWarning: numberOr(value.maxLinesWarning, Math.min(warningDefault, maxLinesError)),
    maxLinesError,
  };
}

function unifiedFromInputs(
  existing: JsonObject | null,
  suggestion: ConfigSuggestion,
  preserveExisting: boolean,
): JsonObject {
  const project = asObject(existing?.project);
  const codelint = asObject(existing?.codelint);
  const doclint = asObject(existing?.doclint);
  const docsGardener = asObject(existing?.docsGardener);
  const ci = asObject(existing?.ci);
  const policy = asObject(existing?.policy);

  const use = (current: unknown, suggested: unknown) => preserveExisting ? current ?? suggested : suggested ?? current;
  const codeError = use(codelint.maxLinesError ?? codelint.maxLines, suggestion.maxCodeLines);
  const docError = use(doclint.maxLinesError ?? doclint.maxLines, suggestion.maxDocLines);

  return {
    ...(existing ?? {}),
    $schema: existing?.$schema ?? PROJECT_CONFIG_SCHEMA_URL,
    version: existing?.version ?? PROJECT_CONFIG_VERSION,
    project: {
      ...project,
      baseBranch: use(project.baseBranch, suggestion.baseBranch),
      codeExt: use(project.codeExt, suggestion.codeExt),
      codeDirs: use(project.codeDirs, suggestion.codeDirs),
      docsDir: use(project.docsDir, suggestion.docsDir),
    },
    codelint: {
      ...codelint,
      lintDirs: use(codelint.lintDirs, suggestion.lintDirs),
      maxLinesWarning: use(codelint.maxLinesWarning, Math.min(DEFAULT_CODE_WARNING_LINES, Number(codeError))),
      maxLinesError: codeError,
    },
    doclint: {
      ...doclint,
      maxLinesWarning: use(doclint.maxLinesWarning, Math.min(DEFAULT_DOC_WARNING_LINES, Number(docError))),
      maxLinesError: docError,
    },
    docsGardener: {
      ...docsGardener,
      catalogs: docsGardener.catalogs ?? {},
    },
    policy: {
      ...policy,
      profile: isPolicyProfile(policy.profile) ? policy.profile : "standard",
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
  if (explicit.maxCodeLines !== undefined) {
    codelint.maxLinesError = explicit.maxCodeLines;
    if (hasOwn(codelint, "maxLines")) codelint.maxLines = explicit.maxCodeLines;
  }
  if (explicit.maxDocLines !== undefined) {
    doclint.maxLinesError = explicit.maxDocLines;
    if (hasOwn(doclint, "maxLines")) doclint.maxLines = explicit.maxDocLines;
  }
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
      ...lineThresholds(codelint, DEFAULT_CODE_WARNING_LINES, suggestion.maxCodeLines),
    },
    doclint: {
      ...doclint,
      ...lineThresholds(doclint, DEFAULT_DOC_WARNING_LINES, suggestion.maxDocLines),
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

export function isProjectRuntimeConfigSource(value: JsonObject): value is ProjectRuntimeConfigSource {
  return value.schema === RUNTIME_CONFIG_SOURCE_SCHEMA
    && value.authority === "project"
    && value.source === UNIFIED_CONFIG_FILE
    && Object.keys(value).every(key => key === "schema" || key === "authority" || key === "source");
}

function legacyDetectedConfig(suggestion: ConfigSuggestion): JsonObject {
  return {
    project: {
      baseBranch: suggestion.baseBranch,
      codeExt: suggestion.codeExt,
      codeDirs: suggestion.codeDirs,
      docsDir: suggestion.docsDir,
    },
    codelint: {
      lintDirs: suggestion.lintDirs,
      maxLinesWarning: DEFAULT_CODE_WARNING_LINES,
      maxLinesError: DEFAULT_CODE_ERROR_LINES,
    },
    doclint: {
      maxLinesWarning: DEFAULT_DOC_WARNING_LINES,
      maxLinesError: DEFAULT_DOC_ERROR_LINES,
    },
    docsGardener: { catalogs: {} },
    policy: { profile: LEGACY_COMPATIBLE_POLICY_PROFILE },
  };
}

export function validateRuntimeConfigValue(
  root: string,
  raw: JsonObject,
  suggestion = defaultSuggestion(root),
  options: { allowLegacyCompatible?: boolean } = {},
): { config: JsonObject; issues: string[] } {
  const normalized = normalizedUnified(raw, suggestion);
  const issues = [
    ...validateUnifiedConfig(root, raw, normalized, { checkExists: false, allowLegacyCompatible: options.allowLegacyCompatible }),
    ...runtimeRequiredFieldIssues(raw),
  ];
  return { config: normalized, issues: [...new Set(issues)] };
}

function selectProjectRuntimeConfig(root: string): SelectedRuntimeConfig {
  const source = path.join(root, UNIFIED_CONFIG_FILE);
  const read = readJsonFile(root, UNIFIED_CONFIG_FILE);
  return {
    raw: read.value,
    authority: { kind: "project", source },
    issues: read.value ? [] : [read.issue ?? `Missing project config: ${source}`],
    missing: read.value === null && read.issue === null,
    allowLegacyCompatible: false,
  };
}

function selectRuntimeConfig(root: string, suggestion: ConfigSuggestion): SelectedRuntimeConfig {
  const externalSource = projectPaths(root).config;
  const externalRead = readJsonPath(externalSource, "external runtime config");
  if (externalRead.issue) {
    return {
      raw: null,
      authority: { kind: "external", source: externalSource },
      issues: [externalRead.issue],
      missing: false,
      allowLegacyCompatible: false,
    };
  }
  if (externalRead.value && isProjectRuntimeConfigSource(externalRead.value)) {
    return selectProjectRuntimeConfig(root);
  }
  if (externalRead.value) {
    return {
      raw: externalRead.value,
      authority: { kind: "external", source: externalSource },
      issues: [],
      missing: false,
      allowLegacyCompatible: false,
    };
  }
  if (process.env[RUNTIME_CONFIG_SOURCE_ENV] === RUNTIME_CONFIG_SOURCE_SCHEMA) {
    return selectProjectRuntimeConfig(root);
  }
  const detected = legacyDetectedConfig(suggestion);
  return {
    raw: detected,
    authority: { kind: "legacy-detected", source: "read-only project detection with frozen historical defaults" },
    issues: [],
    missing: false,
    allowLegacyCompatible: true,
  };
}

function resolveSelectedRuntimeConfig(
  root: string,
  suggestion: ConfigSuggestion,
  selected: SelectedRuntimeConfig,
): RuntimeConfigResolution {
  if (!selected.raw) {
    return {
      config: legacyDetectedConfig(suggestion),
      authority: selected.authority,
      issues: selected.issues,
    };
  }
  const validated = validateRuntimeConfigValue(root, selected.raw, suggestion, {
    allowLegacyCompatible: selected.allowLegacyCompatible,
  });
  return {
    config: validated.config,
    authority: selected.authority,
    issues: [...new Set([...selected.issues, ...validated.issues])],
  };
}

export function resolveRuntimeConfig(root: string, suggestion = defaultSuggestion(root)): RuntimeConfigResolution {
  return resolveSelectedRuntimeConfig(root, suggestion, selectRuntimeConfig(root, suggestion));
}

export function readUnifiedConfig(root: string, suggestion = defaultSuggestion(root)): JsonObject | null {
  return inspectRuntimeConfig(root, suggestion).config;
}

function runtimeBaseBranchIssues(raw: JsonObject): string[] {
  const projectValue = raw.project;
  if (!projectValue || typeof projectValue !== "object" || Array.isArray(projectValue)) {
    return [`${UNIFIED_CONFIG_FILE} project must be an object; got ${typeName(projectValue)}`];
  }
  const project = projectValue as JsonObject;
  if (!hasOwn(project, "baseBranch")) return [`${UNIFIED_CONFIG_FILE} project.baseBranch is required at runtime`];
  if (typeof project.baseBranch !== "string") {
    return [`${UNIFIED_CONFIG_FILE} project.baseBranch must be a string; got ${typeName(project.baseBranch)}`];
  }
  if (!isSafeConfigRefName(project.baseBranch)) {
    return [`${UNIFIED_CONFIG_FILE} project.baseBranch is not a safe Git branch name: ${project.baseBranch}`];
  }
  return [];
}

export function requireRuntimeBaseBranch(root: string): string {
  const suggestion = defaultSuggestion(root);
  const selected = selectRuntimeConfig(root, suggestion);
  const issues = [...selected.issues, ...(selected.raw ? runtimeBaseBranchIssues(selected.raw) : [])];
  if (issues.length) throw new RuntimeConfigError(root, [...new Set(issues)], selected.missing, selected.authority.source);
  return (selected.raw!.project as JsonObject).baseBranch as string;
}

export function requireRuntimeConfig(root: string, suggestion = defaultSuggestion(root)): JsonObject {
  const selected = selectRuntimeConfig(root, suggestion);
  const resolved = resolveSelectedRuntimeConfig(root, suggestion, selected);
  if (resolved.issues.length) throw new RuntimeConfigError(root, resolved.issues, selected.missing, resolved.authority.source);
  return resolved.config;
}

function preservedKeys(before: JsonObject | null, after: JsonObject): string[] {
  if (!before) return Object.keys(after);
  return Object.keys(before).filter(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

export function applyConfig(root: string, suggestion: ConfigSuggestion, options: { preserveExisting: boolean; dryRun: boolean; mode?: string; overrides?: Partial<ConfigSuggestion> }): ConfigCheckResult {
  const targetPath = path.join(root, UNIFIED_CONFIG_FILE);
  const targetRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
  if (targetRead.issue) return configResult(root, suggestion, [targetRead.issue], [], false);

  const before = targetRead.value;
  const merged = unifiedFromInputs(before, suggestion, options.preserveExisting);
  const unified = normalizedUnified(withExplicitOverrides(merged, options.overrides ?? {}), suggestion);
  const validationIssues = validateUnifiedConfig(root, unified, unified);
  if (validationIssues.length) return configResult(root, suggestion, validationIssues, [], false);

  const detected = detectProject(root);
  const fullyExplicit = Boolean(
    options.overrides?.codeExt && options.overrides?.codeDirs?.length && options.overrides?.lintDirs?.length &&
    options.overrides?.docsDir && options.overrides?.baseBranch
  );
  const explicitInput = Boolean(before) || fullyExplicit;
  const ambiguousGitInference = Boolean(detected.ambiguous)
    && detected.evidence.some(item => item.startsWith("project files (git):"))
    && !explicitInput;
  if (ambiguousGitInference) {
    return { ...configResult(root, suggestion, [], [], true), source: targetPath, candidate: unified, dryRun: options.dryRun };
  }

  const changed: string[] = [];
  const preserved: Record<string, string[]> = {};
  if (!fs.existsSync(targetPath) || JSON.stringify(before) !== JSON.stringify(unified)) changed.push(UNIFIED_CONFIG_FILE);
  preserved[UNIFIED_CONFIG_FILE] = preservedKeys(before, unified);
  if (!options.dryRun) writeJson(root, UNIFIED_CONFIG_FILE, unified);
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
    hint: result.ok ? "The project-owned config is valid and can be used immediately." : result.hint,
  };
}

function valueArray(value: any): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function valueCodeExtArray(value: any): string[] {
  return normalizeCodeExt(value);
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

function validatePositiveIntegerField(raw: JsonObject, key: string, field: string, issues: string[]): void {
  if (!hasOwn(raw, key)) return;
  const value = raw[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field} must be a positive integer; got ${JSON.stringify(value)}`);
  }
}

function validateLineThresholds(raw: JsonObject, field: string, issues: string[]): void {
  validateNumberField(raw, "maxLines", `${field}.maxLines`, issues);
  validatePositiveIntegerField(raw, "maxLinesWarning", `${field}.maxLinesWarning`, issues);
  validatePositiveIntegerField(raw, "maxLinesError", `${field}.maxLinesError`, issues);
  const legacy = typeof raw.maxLines === "number" && Number.isFinite(raw.maxLines) ? raw.maxLines : null;
  const warning = typeof raw.maxLinesWarning === "number" && Number.isSafeInteger(raw.maxLinesWarning) && raw.maxLinesWarning > 0
    ? raw.maxLinesWarning
    : null;
  const explicitError = typeof raw.maxLinesError === "number" && Number.isSafeInteger(raw.maxLinesError) && raw.maxLinesError > 0
    ? raw.maxLinesError
    : null;
  if (legacy !== null && explicitError !== null && legacy !== explicitError) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field}.maxLinesError must equal legacy ${field}.maxLines while both are configured`);
  }
  const error = explicitError ?? legacy;
  if (warning !== null && error !== null && warning > error) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field}.maxLinesWarning must not exceed ${field}.maxLinesError`);
  }
}

function normalizedTierPath(value: string): string {
  return value.replace(/\/+$/, "");
}

function validateTiers(root: string, raw: JsonObject, checkExists: boolean, issues: string[]): void {
  if (!hasOwn(raw, "tiers")) return;
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) {
    issues.push(`${UNIFIED_CONFIG_FILE} codelint.tiers must be a non-empty array when configured`);
    return;
  }
  const names = new Set<string>();
  const paths: Array<{ name: string; path: string }> = [];
  raw.tiers.forEach((value: unknown, index: number) => {
    const label = `codelint.tiers[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${UNIFIED_CONFIG_FILE} ${label} must be an object with name and paths`);
      return;
    }
    const tier = value as JsonObject;
    const unknown = Object.keys(tier).filter(key => key !== "name" && key !== "paths");
    if (unknown.length) issues.push(`${UNIFIED_CONFIG_FILE} ${label} has unknown fields: ${unknown.join(", ")}`);
    if (typeof tier.name !== "string" || !tier.name.trim() || tier.name !== tier.name.trim() || /[\0\r\n]/.test(tier.name)) {
      issues.push(`${UNIFIED_CONFIG_FILE} ${label}.name must be a non-empty trimmed single-line string`);
    } else if (names.has(tier.name)) {
      issues.push(`${UNIFIED_CONFIG_FILE} codelint.tiers names must be unique: ${tier.name}`);
    } else names.add(tier.name);
    if (!Array.isArray(tier.paths) || tier.paths.length === 0 || !tier.paths.every((item: unknown) => typeof item === "string")) {
      issues.push(`${UNIFIED_CONFIG_FILE} ${label}.paths must be a non-empty array of strings`);
      return;
    }
    for (const tierPath of tier.paths as string[]) {
      if (!isSafeRelativePath(tierPath)) {
        issues.push(`${UNIFIED_CONFIG_FILE} ${label}.paths entry is not a safe relative path: ${tierPath}`);
        continue;
      }
      if (checkExists && !directoryExists(root, tierPath)) {
        issues.push(`${UNIFIED_CONFIG_FILE} ${label}.paths entry is not an existing directory: ${tierPath}`);
      }
      paths.push({ name: typeof tier.name === "string" ? tier.name : label, path: normalizedTierPath(tierPath) });
    }
  });
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const a = paths[left];
      const b = paths[right];
      if (a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`)) {
        issues.push(`${UNIFIED_CONFIG_FILE} codelint.tiers paths must not duplicate or overlap: ${a.path} (${a.name}) and ${b.path} (${b.name})`);
      }
    }
  }
}

function validateObjectField(raw: JsonObject, key: string, field: string, issues: string[]): void {
  if (!hasOwn(raw, key)) return;
  const value = raw[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${UNIFIED_CONFIG_FILE} ${field} must be an object; got ${typeName(value)}`);
  }
}

function validateUnifiedConfig(
  root: string,
  raw: JsonObject,
  unified: JsonObject,
  options: { checkExists?: boolean; allowLegacyCompatible?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const projectRaw = objectField(raw, "project", issues);
  const codelintRaw = objectField(raw, "codelint", issues);
  const doclintRaw = objectField(raw, "doclint", issues);
  const docsGardenerRaw = objectField(raw, "docsGardener", issues);
  const ciRaw = objectField(raw, "ci", issues);
  const projectConfig = asObject(unified.project);
  const codelintConfig = asObject(unified.codelint);
  const checkExists = options.checkExists ?? true;

  if (hasOwn(raw, "$schema") && raw.$schema !== PROJECT_CONFIG_SCHEMA_URL) {
    issues.push(`${UNIFIED_CONFIG_FILE} $schema must be ${PROJECT_CONFIG_SCHEMA_URL}`);
  }
  if (hasOwn(raw, "version") && raw.version !== PROJECT_CONFIG_VERSION) {
    issues.push(`${UNIFIED_CONFIG_FILE} version must be ${PROJECT_CONFIG_VERSION}`);
  }

  validateStringField(projectRaw, "baseBranch", "project.baseBranch", issues);
  validateCodeExtField(projectRaw, issues);
  validateStringArrayField(projectRaw, "codeDirs", "project.codeDirs", issues);
  validateStringField(projectRaw, "docsDir", "project.docsDir", issues);
  validateStringArrayField(codelintRaw, "lintDirs", "codelint.lintDirs", issues);
  validateLineThresholds(codelintRaw, "codelint", issues);
  validateLineThresholds(doclintRaw, "doclint", issues);
  validateTiers(root, codelintRaw, checkExists, issues);
  validateObjectField(docsGardenerRaw, "catalogs", "docsGardener.catalogs", issues);
  issues.push(...validatePolicyConfig(raw, { allowLegacyCompatible: options.allowLegacyCompatible }));
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
  return readJsonFile(root, UNIFIED_CONFIG_FILE).value;
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
  const suggestedCommand = docsIssue && existing
    ? buildDocsRecoveryCommand()
    : existing
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
        ? `${UNIFIED_CONFIG_FILE} is a valid project-owned configuration; historical injected files are not consulted.`
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
  const source = path.join(root, UNIFIED_CONFIG_FILE);
  const unifiedRead = readJsonFile(root, UNIFIED_CONFIG_FILE);
  const unifiedRaw = unifiedRead.value;

  if (unifiedRead.issue) issues.push(unifiedRead.issue);
  if (!unifiedRaw && !unifiedRead.issue) issues.push("Missing project config: " + source);

  const unified = normalizedUnified(
    unifiedRaw ?? unifiedFromInputs(null, suggestion, true),
    suggestion,
  );
  const projectConfig = asObject(unified.project);

  if (unifiedRaw) {
    issues.push(...validateUnifiedConfig(root, unifiedRaw, unified));
    issues.push(...runtimeRequiredFieldIssues(unifiedRaw));
  }

  const explicitConfigReady = Boolean(
    unifiedRaw &&
    valueCodeExtArray(projectConfig.codeExt).length &&
    valueArray(projectConfig.codeDirs).length &&
    valueArray(asObject(unified.codelint).lintDirs).length &&
    projectConfig.docsDir,
  );
  const ambiguous = Boolean(project.ambiguous) && !explicitConfigReady;
  return { ...configResult(root, suggestion, [...new Set(issues)], [], ambiguous), source, candidate: unified };
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
    else if (arg === "--explain-policy") {
      args.mode = "explain-policy";
      args.explainRule = next(arg);
    }
    else if (arg === "--file") args.explainFile = next(arg);
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
    "  hy-workflow lint --json      Run built-in D001-D005 and C001-C005 rules",
    "  hy-workflow --version       Show the installed package version",
    "  hy-workflow --help          Show this help",
    "  hy-workflow config --check --json",
    "  hy-workflow config --apply --json --docs-dir docs",
    "  hy-workflow config --apply-suggested --json",
    "  hy-workflow config --explain-policy code.max-lines --file src/parser.ts --json",
    "  hy-workflow config --python --code-dirs src,test --docs-dir docs --base-branch dev --json",
    "",
    "Project config is stored in hy-workflow.json.",
    "Config commands emit a single JSON envelope when --json is passed.",
  ].join("\n");
}

type ConfigFileSnapshot = {
  file: string;
  existed: boolean;
  content: string | null;
  mode: number | null;
};

class ConfigApplyTransactionError extends Error {
  readonly type = "config" as const;
  readonly subtype = "config_apply_transaction_failed" as const;
  readonly code = "CONFIG_APPLY_TRANSACTION_FAILED" as const;
  readonly retryable = false;

  constructor(readonly detail: { cause: string; rollback: string[] }) {
    super("Config apply failed and its previous files could not be restored completely.");
    this.name = "ConfigApplyTransactionError";
  }
}

function configFileSnapshot(file: string): ConfigFileSnapshot {
  if (!fs.existsSync(file)) return { file, existed: false, content: null, mode: null };
  return {
    file,
    existed: true,
    content: fs.readFileSync(file, "utf-8"),
    mode: fs.statSync(file).mode & 0o777,
  };
}

function configFileMatches(snapshot: ConfigFileSnapshot): boolean {
  if (!snapshot.existed) return !fs.existsSync(snapshot.file);
  if (!fs.existsSync(snapshot.file)) return false;
  return fs.readFileSync(snapshot.file, "utf-8") === snapshot.content
    && (fs.statSync(snapshot.file).mode & 0o777) === snapshot.mode;
}

function restoreConfigFile(snapshot: ConfigFileSnapshot): void {
  if (configFileMatches(snapshot)) return;
  if (!snapshot.existed) {
    fs.rmSync(snapshot.file, { force: true });
    return;
  }
  atomicWriteText(snapshot.file, snapshot.content!, snapshot.mode ?? 0o600);
  if (snapshot.mode !== null) fs.chmodSync(snapshot.file, snapshot.mode);
}

function rollbackConfigApply(snapshots: ConfigFileSnapshot[], cause: unknown): void {
  const rollback: string[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      restoreConfigFile(snapshot);
      if (!configFileMatches(snapshot)) rollback.push(`${snapshot.file}: restored content or mode did not match`);
    } catch (error: any) {
      rollback.push(`${snapshot.file}: ${error?.message ?? String(error)}`);
    }
  }
  if (rollback.length) {
    throw new ConfigApplyTransactionError({
      cause: cause instanceof Error ? cause.message : String(cause),
      rollback,
    });
  }
}

export function runConfigCli(argv: string[], root = process.cwd()): { exitCode: number; stdout: string } {
  const args = parseArgs(argv);
  if (args.mode === "help") return { exitCode: 0, stdout: configHelp() + "\n" };
  if (args.mode === "explain-policy") {
    const rule = args.explainRule;
    if (!rule) args.errors.push("Missing value for --explain-policy");
    else if (!isQualityPolicyRule(rule) && !isImmutableSafetyRule(rule)) {
      args.errors.push(`Unknown policy rule: ${rule}`);
    }
    if (args.explainFile !== undefined && !isSafeRelativePath(args.explainFile)) {
      args.errors.push(`Policy explanation --file must be a safe project-relative path: ${args.explainFile}`);
    }
    const resolved = resolveRuntimeConfig(root);
    const issues = [...args.errors, ...resolved.issues];
    if (issues.length) {
      const payload = {
        ok: false,
        phase: "config",
        status: "failed",
        authority: resolved.authority,
        issues,
      };
      return { exitCode: 1, stdout: args.json ? JSON.stringify(payload, null, 2) + "\n" : `${issues.join("\n")}\n` };
    }
    const explanation = explainEffectivePolicy(resolved.config, rule as PolicyRuleId, { file: args.explainFile });
    const payload = {
      ok: true,
      phase: "config",
      status: "completed",
      authority: resolved.authority,
      explanation,
    };
    return { exitCode: 0, stdout: args.json ? JSON.stringify(payload, null, 2) + "\n" : `${JSON.stringify(explanation, null, 2)}\n` };
  }
  const suggestion = mergeSuggestion(root, args.explicit);
  if (!args.explicit.lintDirs && args.explicit.codeDirs) suggestion.lintDirs = args.explicit.codeDirs;
  let result: ConfigCheckResult;
  if (args.errors.length) {
    const base = configResult(root, suggestion, args.errors, [], false);
    const code = args.errors.some(issue => issue.startsWith("Unknown config option:")) ? "UNKNOWN_OPTION" : "INVALID_ARGUMENTS";
    result = {
      ...base,
      error: {
        type: "config",
        subtype: "invalid_arguments",
        code,
        message: args.errors.join("; "),
        hint: "Use hy-workflow config --help and retry with supported options.",
        retryable: false,
        detail: { issues: [...args.errors] },
      },
    };
  }
  else if (args.mode !== "apply") result = checkConfig(root, suggestion);
  else if (args.dryRun) {
    result = applyConfig(root, suggestion, {
      preserveExisting: !args.applySuggested,
      dryRun: true,
      mode: "shared",
      overrides: args.applySuggested ? undefined : args.explicit,
    });
  } else {
    const snapshots = [
      configFileSnapshot(path.join(root, UNIFIED_CONFIG_FILE)),
      configFileSnapshot(projectPaths(root).config),
    ];
    try {
      result = applyConfig(root, suggestion, {
        preserveExisting: !args.applySuggested,
        dryRun: false,
        mode: "shared",
        overrides: args.applySuggested ? undefined : args.explicit,
      });
      if (result.ok) atomicWriteJson(projectPaths(root).config, projectRuntimeConfigSource());
      else rollbackConfigApply(snapshots, result.issues.join("; ") || "config validation failed");
    } catch (error) {
      rollbackConfigApply(snapshots, error);
      throw error;
    }
  }
  return { exitCode: result.ok ? 0 : 1, stdout: args.json ? JSON.stringify(result, null, 2) + "\n" : `${result.display.title}
${result.display.body}
` };
}
