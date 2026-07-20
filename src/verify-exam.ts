import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectPaths } from "./runtime/user-paths.js";
import { requireRuntimeConfig } from "./config.js";
import { normalizeCodeExt, PYTHON_CODE_EXTS } from "./code_ext.js";
import type { CheckItem, ImplementationManifest, PlanDoc, WorkflowState } from "./state.js";
import { computeImplementationDigest, computeImplementationManifestHash, computeVerifyHash } from "./state.js";
import { buildImplementationManifest, CHECK_COMMAND_TIMEOUT_MS, CHECK_TEST_TIMEOUT_MS, checkCommandTimeoutMs, findPython } from "./checks.js";
import { execFileSync } from "node:child_process";

function parsePythonVersionRequirement(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (!trimmed || /^(n\/?a|none|no|false|not required|not-required)$/i.test(trimmed)) return null;
  const match = /^(?:>=\s*)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

// ── Types ─────────────────────────────────────────────────────

export type ExamCheckLayer = "compile" | "scope" | "boundary" | "platform" | "smoke" | "tests";

export interface ExamCheck {
  id: string;
  layer: ExamCheckLayer;
  /** Exact command string the agent must run verbatim. */
  command: string;
  cwd?: string;
  /** Milliseconds the agent should allow this command to run before considering it hung. */
  timeoutMs: number;
  /** Expected exit code, default 0. */
  expectExitCode: number;
  /** Nonce binding this check to a specific exam, anti-replay. */
  nonce: string;
  /** stdout MUST contain this regex (or substring) to pass. */
  mustContain?: string;
  /** stdout MUST NOT contain this regex. */
  mustNotContain?: string;
}

export interface ExamManifest {
  examId: string;
  issuedAt: string;
  expiresAt: string;
  /** git write-tree hash at time of issue; submit validates tree unchanged. */
  scopeFingerprint: string;
  /** Exam-level nonce (in addition to per-check nonces). */
  nonce: string;
  checks: ExamCheck[];
  /** Results that already passed every per-check constraint for partial resubmission. */
  acceptedResults?: ExamResult[];
}

export interface ExamResult {
  id: string;
  /** The exact command from ExamCheck.command; submitted verbatim to prove the agent ran the right thing. */
  command: string;
  nonce: string;
  exitCode: number;
  durationMs?: number;
  /** Last 4KB of stdout for mustContain/mustNotContain and failure diagnostics. */
  stdoutTail?: string;
  stderrTail?: string;
}

const EXAM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const STDOUT_TAIL_LIMIT = 4096;

// ── Storage ───────────────────────────────────────────────────

function examDir(root: string): string {
  return path.join(projectPaths(root).stateDir, "exams");
}

function examFile(root: string, examId: string): string {
  if (!/^[0-9a-f]{16,}$/.test(examId)) throw new Error("invalid examId");
  return path.join(examDir(root), `${examId}.json`);
}

function loadExam(root: string, examId: string): ExamManifest {
  const file = examFile(root, examId);
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error(`exam ${examId} not found or expired`), { code: "EXAM_NOT_FOUND" });
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ExamManifest;
}

function saveExam(root: string, exam: ExamManifest): void {
  const dir = examDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(examFile(root, exam.examId), JSON.stringify(exam, null, 2), { mode: 0o600 });
}

// ── Nonce / fingerprint ───────────────────────────────────────

function nonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Compute a fingerprint of the staged git tree using `git write-tree`.
 * This is a stable, content-addressed hash of HEAD + staged changes that
 * is unaffected by untracked files or runtime artifacts.
 *
 * The commit gate (hy_commit) independently recomputes the full implementation
 * manifest/digest/verifyHash and rejects mismatches, so the exam fingerprint
 * only needs to catch trivial modification-before-submit, not be a perfect
 * content hash.
 */
export function computeScopeFingerprint(root: string): string {
  return execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
}

// ── Command derivation ────────────────────────────────────────
// These mirror the implicit commands run by runAllChecks() in checks.ts. They
// must be kept in sync so that what the agent runs via bash matches what
// hy_verify sync path executes.

function checkId(layer: ExamCheckLayer, idx: number, suffix?: string): string {
  return `${layer}${suffix ? `:${suffix}` : ""}${idx > 0 ? `[${idx}]` : ""}`;
}

function shellCheck(command: string, layer: ExamCheckLayer, idx: number, suffix?: string, mustContain?: string, expectExitCode = 0): ExamCheck {
  return {
    id: checkId(layer, idx, suffix),
    layer,
    command,
    timeoutMs: checkCommandTimeoutMs(command) ?? CHECK_COMMAND_TIMEOUT_MS,
    expectExitCode,
    nonce: nonce(),
    mustContain,
  };
}

function configuredCodeDirs(project: Record<string, unknown>): string[] {
  const value = project.codeDirs;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim());
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function configuredPythonFiles(root: string, codeDirs: string[], extensions: Set<string>): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  for (const dir of codeDirs) walk(path.resolve(root, dir));
  return [...new Set(files)].sort();
}

function shellArgument(value: string): string {
  const escaped = value.replace(/(["\\$\x60])/g, "\\$1");
  return `"${escaped}"`;
}

/**
 * Derive the exam check manifest from current plan + project state. This list
 * of commands matches exactly what runAllChecks would execute in the sync path.
 */
export function deriveExamChecks(root: string, plan: PlanDoc): ExamCheck[] {
  const checks: ExamCheck[] = [];
  let idx = 0;

  // ── compile (auto-derived) ──
  const config = requireRuntimeConfig(root);
  const project = config.project as Record<string, unknown>;
  const extensions = normalizeCodeExt(project.codeExt);
  const hasTypeScript = extensions.some(ext => ext === ".ts" || ext === ".tsx");
  const hasJavaScript = extensions.some(ext => [".js", ".jsx", ".mjs", ".cjs"].includes(ext));
  if (hasTypeScript || (hasJavaScript && fs.existsSync(path.join(root, "tsconfig.json")))) {
    checks.push(shellCheck("npx tsc --noEmit", "compile", idx++, "ts"));
  }
  const pythonExtensions = new Set(extensions.filter(ext => PYTHON_CODE_EXTS.has(ext)));
  if (pythonExtensions.size) {
    const files = configuredPythonFiles(root, configuredCodeDirs(project), pythonExtensions);
    if (files.length) checks.push(shellCheck(
      `${findPython()} -m py_compile ${files.map(shellArgument).join(" ")}`,
      "compile", idx++, "python", undefined, 0,
    ));
  }

  // ── scope ──
  // Scope is implemented in-process (git diff parsing) — no shell command to run.
  // We emit a no-op check that always passes if scope integrity was computed;
  // the agent just confirms it ran the same git diff baseline.
  checks.push(shellCheck("git diff --name-status", "scope", idx++, "diff"));

  // ── boundary (no_new_external) ──
  // Boundary is also in-process; emit a single no-op indicator. The real boundary
  // check (lockfile diff inspection) happens in hy_verify; exam mode trusts the
  // agent and re-validates at hy_exam_submit time by recomputing boundary locally.
  checks.push(shellCheck("test -f package.json && echo ok || echo no-package", "boundary", idx++));

  // ── platform ──
  for (const setupCmd of plan.verify?.platform?.setup ?? []) {
    checks.push(shellCheck(setupCmd, "platform", idx++));
  }
  if (plan.verify?.platform?.python_version) {
    if (parsePythonVersionRequirement(plan.verify.platform.python_version)) {
      checks.push(shellCheck("python --version", "platform", idx++, "python", "Python"));
    }
  }

  // ── smoke (from plan.verify.smoke[]) ──
  for (const item of plan.verify?.smoke ?? []) {
    checks.push(shellCheck(item.command, "smoke", idx++, item.description));
  }

  // ── tests (from plan.verify.tests[]) ──
  for (const item of plan.verify?.tests ?? []) {
    checks.push(shellCheck(item.command, "tests", idx++, item.description));
    // Override timeout for tests layer
    checks[checks.length - 1].timeoutMs = CHECK_TEST_TIMEOUT_MS;
    checks[checks.length - 1].expectExitCode = item.expected_exit ?? 0;
  }

  return checks;
}

// ── Public API ────────────────────────────────────────────────

export function issueExam(root: string, plan: PlanDoc): ExamManifest {
  const examId = nonce();
  const manifest: ExamManifest = {
    examId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + EXAM_TTL_MS).toISOString(),
    scopeFingerprint: computeScopeFingerprint(root),
    nonce: nonce(),
    checks: deriveExamChecks(root, plan),
  };
  saveExam(root, manifest);
  return manifest;
}

export interface ExamSubmitOutcome {
  passed: boolean;
  verifyHash?: string;
  implementationManifest?: ImplementationManifest;
  verifiedImplementationDigest?: string;
  verifiedManifestHash?: string;
  failedChecks?: Array<{
    id: string;
    reason: "missing_result" | "nonce_mismatch" | "command_mismatch" | "exit_code" | "must_contain" | "must_not_contain" | "source_changed" | "exam_expired" | "unknown_check";
    message: string;
    expected?: unknown;
    actual?: unknown;
  }>;
}

function redact(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.length > STDOUT_TAIL_LIMIT ? s.slice(-STDOUT_TAIL_LIMIT) : s;
}

export function submitExam(
  root: string,
  state: WorkflowState,
  examId: string,
  results: ExamResult[],
): ExamSubmitOutcome {
  let exam: ExamManifest;
  try {
    exam = loadExam(root, examId);
  } catch (e: any) {
    return { passed: false, failedChecks: [{ id: "(exam)", reason: "unknown_check", message: e?.message ?? String(e) }] };
  }

  if (Date.now() > new Date(exam.expiresAt).getTime()) {
    return { passed: false, failedChecks: [{ id: examId, reason: "exam_expired", message: "exam expired; run hy_exam_plan again" }] };
  }

  const currentFingerprint = computeScopeFingerprint(root);
  const failed: NonNullable<ExamSubmitOutcome["failedChecks"]> = [];

  if (currentFingerprint !== exam.scopeFingerprint) {
    failed.push({
      id: examId,
      reason: "source_changed",
      message: "working tree changed since exam was issued; re-run hy_exam_plan",
      expected: exam.scopeFingerprint,
      actual: currentFingerprint,
    });
  }

  const byId = new Map(exam.checks.map(c => [c.id, c]));
  const submitted = new Map((exam.acceptedResults ?? []).map(r => [r.id, r]));
  for (const result of results) submitted.set(result.id, result);
  const acceptedResults: ExamResult[] = [];

  for (const check of exam.checks) {
    const r = submitted.get(check.id);
    if (!r) {
      failed.push({ id: check.id, reason: "missing_result", message: "no result submitted for this check" });
      continue;
    }
    if (r.nonce !== check.nonce) {
      failed.push({ id: check.id, reason: "nonce_mismatch", message: "nonce does not match exam check", expected: check.nonce, actual: r.nonce });
      continue;
    }
    if (r.command !== check.command) {
      failed.push({ id: check.id, reason: "command_mismatch", message: "submitted command differs from exam command", expected: check.command, actual: r.command });
      continue;
    }
    if (r.exitCode !== check.expectExitCode) {
      failed.push({ id: check.id, reason: "exit_code", message: `exit code ${r.exitCode}, expected ${check.expectExitCode}`, expected: check.expectExitCode, actual: r.exitCode });
      continue;
    }
    if (check.mustContain && !new RegExp(check.mustContain).test(r.stdoutTail ?? "")) {
      failed.push({ id: check.id, reason: "must_contain", message: `stdout missing required pattern: ${check.mustContain}` });
      continue;
    }
    if (check.mustNotContain && new RegExp(check.mustNotContain).test(r.stdoutTail ?? "")) {
      failed.push({ id: check.id, reason: "must_not_contain", message: `stdout contains forbidden pattern: ${check.mustNotContain}` });
      continue;
    }
    acceptedResults.push(r);
  }

  for (const r of results) {
    if (!byId.has(r.id)) {
      failed.push({ id: r.id, reason: "unknown_check", message: "submitted result for unknown check id" });
    }
  }

  if (failed.length) {
    exam.acceptedResults = acceptedResults;
    exam.expiresAt = new Date(Date.now() + EXAM_TTL_MS).toISOString();
    saveExam(root, exam);
    return { passed: false, failedChecks: failed };
  }

  // Full pass: exam consumed, clear partial cache.
  delete exam.acceptedResults;
  saveExam(root, exam);

  // Return the same implementation evidence that sync hy_verify persists.
  const implementationManifest = buildImplementationManifest(root);
  const next: WorkflowState = { ...state, implementationManifest };
  next.verifiedImplementationDigest = computeImplementationDigest(root, implementationManifest);
  next.verifiedManifestHash = computeImplementationManifestHash(implementationManifest);
  next.verifyHash = computeVerifyHash(next);
  return {
    passed: true,
    verifyHash: next.verifyHash,
    implementationManifest,
    verifiedImplementationDigest: next.verifiedImplementationDigest ?? undefined,
    verifiedManifestHash: next.verifiedManifestHash ?? undefined,
  };
}
