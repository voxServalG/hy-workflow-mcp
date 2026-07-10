import { execFileSync } from "node:child_process";
import { getBaseBranch } from "./state.js";
import type { PlanDoc } from "./state.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requireGhExecutor, requireGitExecutor, type ExecutorCapability } from "./executors.js";

type RunResult = { ok: boolean; stdout: string; stderr: string };

function run(cmd: string, args: string[], cwd?: string): RunResult {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: "utf-8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "" };
  }
}

function writeTempFile(content: string): string {
  const tmpPath = path.join(os.tmpdir(), `hy-commit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(tmpPath, content, "utf-8");
  return tmpPath;
}

export type GitOperationError = {
  type: "config" | "io" | "workflow_state";
  subtype: "config_invalid" | "io_failure" | "invalid_phase";
  code: string;
  message: string;
  hint: string;
  detail?: Record<string, unknown>;
  cause?: string;
  retryable?: boolean;
};

function error(type: GitOperationError["type"], subtype: GitOperationError["subtype"], code: string, message: string, hint: string, detail?: Record<string, unknown>, cause?: string): GitOperationError {
  return { type, subtype, code, message, hint, detail, cause, retryable: false };
}

const UNSAFE_REF_CHARS = /[\x00-\x20~^:?*\[\\;$`"'|&<>]/;

export function isSafeGitRefName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value || value.length > 200 || value.trim() !== value) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (UNSAFE_REF_CHARS.test(value)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  return value.split("/").every(part => Boolean(part) && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isSafeBranchTopic(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
}

export function isValidPrNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function invalidRefError(label: string, value: unknown): GitOperationError {
  return error(
    "config",
    "config_invalid",
    "INVALID_GIT_REF",
    `${label} must be a safe Git ref name.`,
    "Use letters, numbers, dot, underscore, slash, and hyphen only; do not use shell metacharacters, whitespace, leading dash, '..', '@{', or .lock suffixes.",
    { label, value },
  );
}

export function invalidTopicError(value: unknown): GitOperationError {
  return error(
    "config",
    "config_invalid",
    "INVALID_BRANCH_TOPIC",
    "Branch topic must be kebab-case.",
    "Use a topic like issue-143-shell-safety with lowercase letters, numbers, and single hyphens.",
    { value },
  );
}

export function invalidPrNumberError(value: unknown): GitOperationError {
  return error(
    "workflow_state",
    "invalid_phase",
    "INVALID_PR_NUMBER",
    "Workflow state prNumber must be a positive integer.",
    "Reset or repair workflow state before running hy_ci or hy_merge.",
    { value },
  );
}

function validateRef(label: string, value: string): GitOperationError | null {
  return isSafeGitRefName(value) ? null : invalidRefError(label, value);
}

function validatePrNumber(value: unknown): { ok: true; value: number } | { ok: false; error: GitOperationError } {
  return isValidPrNumber(value) ? { ok: true, value } : { ok: false, error: invalidPrNumberError(value) };
}

function remoteBaseRefExists(root: string, baseBranch: string): boolean {
  if (!isSafeGitRefName(baseBranch)) return false;
  const ref = `refs/remotes/origin/${baseBranch}`;
  return run("git", ["show-ref", "--verify", "--quiet", ref], root).ok;
}

export function createBranch(root: string, category: string, topic: string): { ok: boolean; branch: string; error?: GitOperationError } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, branch: `${category}/${String(topic)}`, error: required.error as GitOperationError };
  if (!isSafeBranchTopic(topic)) return { ok: false, branch: `${category}/${String(topic)}`, error: invalidTopicError(topic) };
  const name = `${category}/${topic}`;
  const branchError = validateRef("branch", name);
  if (branchError) return { ok: false, branch: name, error: branchError };

  const base = getBaseBranch(root);
  const baseError = validateRef("baseBranch", base);
  if (baseError) return { ok: false, branch: name, error: baseError };
  const remoteRef = `origin/${base}`;

  if (!remoteBaseRefExists(root, base)) {
    return {
      ok: false,
      branch: name,
      error: {
        type: "config",
        subtype: "config_invalid",
        code: "BASE_BRANCH_REMOTE_MISSING",
        message: `Base branch remote ref is missing: ${remoteRef}.`,
        hint: `Fetch or publish the configured base branch before retrying hy_branch, for example: git fetch origin ${base}. If this project uses a different base branch, update hy-workflow.json project.baseBranch.`,
        detail: { branch: name, baseBranch: base, remoteRef },
        retryable: true,
      },
    };
  }

  const r = run("git", ["checkout", "-b", name, remoteRef], root);
  if (!r.ok) {
    return {
      ok: false,
      branch: name,
      error: {
        type: "io",
        subtype: "io_failure",
        code: "GIT_CHECKOUT_FAILED",
        message: `Could not create branch ${name} from ${remoteRef}.`,
        hint: "Inspect git status and the branch name, fix the checkout failure, then retry hy_branch.",
        detail: { branch: name, baseBranch: base, remoteRef },
        cause: r.stderr,
        retryable: false,
      },
    };
  }
  return { ok: true, branch: name };
}

export function commitAll(root: string, title: string, body: string): { ok: boolean; hash?: string; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const r1 = run("git", ["add", "-A"], root);
  if (!r1.ok) return { ok: false, error: r1.stderr, executor: required.executor };
  const msgFile = writeTempFile(`${title}\n\n${body}`);
  try {
    const r2 = run("git", ["commit", "-F", msgFile], root);
    if (!r2.ok) return { ok: false, error: r2.stderr, executor: required.executor };
    const r3 = run("git", ["rev-parse", "HEAD"], root);
    return { ok: true, hash: r3.stdout, executor: required.executor };
  } finally {
    fs.unlinkSync(msgFile);
  }
}

export function commitScope(root: string, scope: PlanDoc["scope"], title: string, body: string): { ok: boolean; hash?: string; error?: unknown; executor?: ExecutorCapability; stagedPaths?: string[] } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const files = [...scope.changes, ...scope.new_files, ...scope.delete];
  if (!files.length) return { ok: false, error: "No files declared in PlanDoc scope", executor: required.executor };

  // A PlanDoc persists across CI-fix commit loops. Only stage paths that are
  // currently dirty; an earlier commit may already have removed delete paths.
  const changedFiles = files.filter(file => run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file], root).stdout.length > 0);
  if (!changedFiles.length) {
    return {
      ok: false,
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "NO_SCOPED_CHANGES",
        message: "No current worktree changes match the approved PlanDoc scope.",
        hint: "Inspect git status. If the intended changes are already committed, continue recovery without creating an empty commit; otherwise edit only approved scope files and rerun verification.",
        detail: { scopeFiles: files },
      },
      executor: required.executor,
      stagedPaths: [],
    };
  }

  const r1 = run("git", ["add", "-A", "--", ...changedFiles], root);
  if (!r1.ok) return { ok: false, error: r1.stderr, executor: required.executor, stagedPaths: changedFiles };
  const msgFile = writeTempFile(`${title}\n\n${body}`);
  try {
    const r2 = run("git", ["commit", "-F", msgFile], root);
    if (!r2.ok) return { ok: false, error: r2.stderr, executor: required.executor, stagedPaths: changedFiles };
    const r3 = run("git", ["rev-parse", "HEAD"], root);
    return { ok: true, hash: r3.stdout, executor: required.executor, stagedPaths: changedFiles };
  } finally {
    fs.unlinkSync(msgFile);
  }
}

export function push(root: string, branch: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  const r = run("git", ["push", "-u", "origin", branch], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function pushForce(root: string, branch: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  const r = run("git", ["push", "--force", "origin", branch], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function createPr(root: string, title: string, body: string, baseBranch: string, headBranch: string): { ok: boolean; prNumber?: number; url?: string; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGhExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const baseError = validateRef("baseBranch", baseBranch);
  if (baseError) return { ok: false, error: baseError, executor: required.executor };
  const headError = validateRef("headBranch", headBranch);
  if (headError) return { ok: false, error: headError, executor: required.executor };

  const bodyFile = writeTempFile(body);
  try {
    const r = run("gh", ["pr", "create", "--title", title, "--body-file", bodyFile, "--base", baseBranch, "--head", headBranch], root);
    if (!r.ok) return { ok: false, error: r.stderr, executor: required.executor };
    const match = r.stdout.match(/\/(\d+)$/);
    const prNumber = match ? parseInt(match[1], 10) : null;
    if (!isValidPrNumber(prNumber)) return { ok: false, error: "Could not parse PR number from gh pr create output", executor: required.executor };
    return { ok: true, prNumber, url: r.stdout.trim(), executor: required.executor };
  } finally {
    fs.unlinkSync(bodyFile);
  }
}

export function mergePr(root: string, prNumber: unknown): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const valid = validatePrNumber(prNumber);
  if (!valid.ok) return { ok: false, error: valid.error };
  const required = requireGhExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const r = run("gh", ["pr", "merge", String(valid.value), "--merge", "--delete-branch"], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function checkCi(root: string, prNumber: unknown): { ok: boolean; allGreen: boolean; noChecks?: boolean; checks: Array<{ name: string; conclusion: string }>; error?: unknown; executor?: ExecutorCapability } {
  const valid = validatePrNumber(prNumber);
  if (!valid.ok) return { ok: false, allGreen: false, checks: [], error: valid.error };
  const required = requireGhExecutor();
  if (!required.ok) return { ok: false, allGreen: false, checks: [], error: required.error, executor: required.executor };
  const r = run("gh", ["pr", "view", String(valid.value), "--json", "statusCheckRollup"], root);
  if (!r.ok) return { ok: false, allGreen: false, checks: [], error: r.stderr, executor: required.executor };
  try {
    const data = JSON.parse(r.stdout);
    const rollup = data.statusCheckRollup ?? [];
    const checks = rollup.map((c: any) => ({
      name: c.name,
      conclusion: c.conclusion ?? "UNKNOWN",
    }));
    if (checks.length === 0) {
      return { ok: true, allGreen: false, noChecks: true, checks, executor: required.executor };
    }
    const relevant = checks.filter((c: any) => c.conclusion !== "SKIPPED" && c.conclusion !== "NEUTRAL");
    const allGreen = relevant.length > 0 && relevant.every((c: any) => c.conclusion === "SUCCESS");
    return { ok: true, allGreen, checks, executor: required.executor };
  } catch {
    return { ok: false, allGreen: false, checks: [], error: "Could not parse gh pr view output", executor: required.executor };
  }
}

export function checkout(root: string, branch: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  const r = run("git", ["checkout", branch], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function pull(root: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const base = getBaseBranch(root);
  const baseError = validateRef("baseBranch", base);
  if (baseError) return { ok: false, error: baseError, executor: required.executor };
  const r = run("git", ["pull", "origin", base], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function rebaseDev(root: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const base = getBaseBranch(root);
  const baseError = validateRef("baseBranch", base);
  if (baseError) return { ok: false, error: baseError, executor: required.executor };
  const r = run("git", ["rebase", `origin/${base}`], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}
