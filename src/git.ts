import { execFileSync } from "node:child_process";
import { getBaseBranch, readState } from "./state.js";
import type { PlanDoc } from "./state.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requireGhExecutor, requireGitExecutor, type ExecutorCapability } from "./executors.js";
import { requireRuntimeConfig } from "./config.js";
import { parsePullRequestSnapshot, type GitIntegrationEvidence, type MergeIdentity, type PullRequestEvidence } from "./merge-recovery.js";
import { isRuntimeIgnoredArtifact, runtimeArtifactExclusionPathspecs } from "./policy/artifacts.js";

type RunResult = { ok: boolean; stdout: string; stderr: string; exitCode: number | null };

function run(cmd: string, args: string[], cwd?: string): RunResult {
  try {
    const env = { ...process.env };
    delete env.GH_REPO;
    delete env.GH_HOST;
    const stdout = execFileSync(cmd, args, { cwd, env, encoding: "utf-8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "", exitCode: Number.isInteger(e.status) ? e.status : null };
  }
}

export function trackedFiles(root: string): string[] {
  const r = run("git", ["ls-files"], root);
  return r.ok ? r.stdout.split("\n").map(line => line.trim()).filter(Boolean).filter(file => !isRuntimeIgnoredArtifact(root, file)) : [];
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

function requireBoundGhExecutor(): ReturnType<typeof requireGhExecutor> {
  const ghRepo = process.env.GH_REPO;
  const ghHost = process.env.GH_HOST;
  delete process.env.GH_REPO;
  delete process.env.GH_HOST;
  try {
    return requireGhExecutor();
  } finally {
    if (ghRepo === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = ghRepo;
    if (ghHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = ghHost;
  }
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
    "Reset or repair workflow state before resuming hy_commit or hy_merge.",
    { value },
  );
}

function validateRef(label: string, value: string): GitOperationError | null {
  return isSafeGitRefName(value) ? null : invalidRefError(label, value);
}

function validatePrNumber(value: unknown): { ok: true; value: number } | { ok: false; error: GitOperationError } {
  return isValidPrNumber(value) ? { ok: true, value } : { ok: false, error: invalidPrNumberError(value) };
}

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isValidGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

export type CommitRecoveryRecord = {
  version: 1;
  commitOid: string;
  implementationDigest: string;
  branch: string;
  baseBranch: string;
  repository: string;
};

const REPOSITORY_SELECTOR = /^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseCommitRecovery(value: unknown): CommitRecoveryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || !isValidGitObjectId(record.commitOid)
    || typeof record.implementationDigest !== "string"
    || !record.implementationDigest
    || !isSafeGitRefName(record.branch)
    || !isSafeGitRefName(record.baseBranch)
    || typeof record.repository !== "string"
    || !REPOSITORY_SELECTOR.test(record.repository)
  ) return null;
  return record as CommitRecoveryRecord;
}

function invalidGitObjectIdError(value: unknown): GitOperationError {
  return error(
    "workflow_state",
    "invalid_phase",
    "INVALID_GIT_OID",
    "The verified Git commit object ID is invalid.",
    "Rerun hy_verify and hy_commit from the workflow branch; do not push a movable branch ref.",
    { value },
  );
}

export type OriginRepositoryResult =
  | { ok: true; repository: string; executor?: ExecutorCapability }
  | { ok: false; error: GitOperationError; executor?: ExecutorCapability };

function parseOriginRepository(remoteUrl: string): string | null {
  let host = "";
  let repositoryPath = "";
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
      const parsed = new URL(remoteUrl);
      if (!["https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
      host = parsed.hostname.toLowerCase();
      repositoryPath = parsed.pathname;
    } else {
      const scp = remoteUrl.match(/^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(.+)$/);
      if (!scp) return null;
      host = scp[1].toLowerCase();
      repositoryPath = scp[2];
    }
  } catch {
    return null;
  }

  const cleanPath = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = cleanPath.split("/");
  if (!/^[A-Za-z0-9.-]+$/.test(host) || segments.length !== 2) return null;
  const [owner, repository] = segments;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return null;
  return `${host}/${owner}/${repository}`;
}

export function resolveOriginRepository(root: string): OriginRepositoryResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const fetchRemote = run("git", ["remote", "get-url", "--all", "origin"], root);
  const pushRemote = run("git", ["remote", "get-url", "--push", "--all", "origin"], root);
  const fetchUrls = fetchRemote.ok ? fetchRemote.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
  const pushUrls = pushRemote.ok ? pushRemote.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
  const fetchRepositories = fetchUrls.map(parseOriginRepository);
  const pushRepositories = pushUrls.map(parseOriginRepository);
  if (!fetchUrls.length || !pushUrls.length || fetchRepositories.some(value => !value) || pushRepositories.some(value => !value)) {
    return {
      ok: false,
      error: {
        type: "config",
        subtype: "config_invalid",
        code: "ORIGIN_REPOSITORY_UNRESOLVED",
        message: "Could not resolve one GitHub repository from both the origin fetch and push URLs.",
        hint: "Set origin fetch and push URLs to the same repository HTTPS or SSH identity, then retry; GH_REPO and GH_HOST are intentionally ignored.",
        detail: { fetchUrls, pushUrls },
        cause: [fetchRemote.ok ? "" : fetchRemote.stderr, pushRemote.ok ? "" : pushRemote.stderr].filter(Boolean).join("; ") || undefined,
        retryable: false,
      },
      executor: required.executor,
    };
  }
  const uniqueFetch = [...new Set(fetchRepositories as string[])];
  const uniquePush = [...new Set(pushRepositories as string[])];
  if (uniqueFetch.length !== 1 || uniquePush.length !== 1 || uniqueFetch[0] !== uniquePush[0]) {
    return {
      ok: false,
      error: error(
        "config",
        "config_invalid",
        "ORIGIN_REPOSITORY_MISMATCH",
        "The origin fetch and push URLs resolve to different repositories.",
        "Make origin fetch and push URLs refer to the same repository before retrying.",
        { fetchRepositories: uniqueFetch, pushRepositories: uniquePush, fetchUrls, pushUrls },
      ),
      executor: required.executor,
    };
  }
  return { ok: true, repository: uniqueFetch[0], executor: required.executor };
}

function repositoryChangedError(expected: string, actual: string): GitOperationError {
  return error(
    "workflow_state",
    "invalid_phase",
    "ORIGIN_REPOSITORY_CHANGED",
    "The origin repository changed after the verified commit identity was selected.",
    "Restore origin to the verified repository or rerun hy_verify and hy_commit.",
    { expected, actual },
  );
}

function validateMergeIdentityInput(identity: MergeIdentity): GitOperationError | null {
  if (!REPOSITORY_SELECTOR.test(identity.repository)) {
    return error("workflow_state", "invalid_phase", "MERGE_INPUT_INVALID", "Merge repository identity is invalid.", "Return to hy_verify and hy_commit to rebuild the exact PR identity.", { identity });
  }
  const pr = validatePrNumber(identity.prNumber);
  if (!pr.ok) return pr.error;
  const baseError = validateRef("baseBranch", identity.baseBranch);
  if (baseError) return baseError;
  const headError = validateRef("headBranch", identity.headBranch);
  if (headError) return headError;
  if (identity.baseBranch === identity.headBranch || !isValidGitObjectId(identity.verifiedOid)) {
    return error("workflow_state", "invalid_phase", "MERGE_INPUT_INVALID", "Merge branch or verified commit identity is invalid.", "Return to hy_verify and hy_commit to rebuild the exact PR identity.", { identity });
  }
  return null;
}
export type GitOidResult = { ok: true; oid: string; executor?: ExecutorCapability } | { ok: false; missing: boolean; error: GitOperationError; executor?: ExecutorCapability };
export type GitBooleanResult = { ok: true; value: boolean; executor?: ExecutorCapability } | { ok: false; error: GitOperationError; executor?: ExecutorCapability };
export type GitActionResult = { ok: true; oid?: string; executor?: ExecutorCapability } | { ok: false; error: GitOperationError; executor?: ExecutorCapability };
export type GitBranchesResult = { ok: true; branches: string[]; executor?: ExecutorCapability } | { ok: false; error: GitOperationError; executor?: ExecutorCapability };
export function resolveRefOid(root: string, ref: string): GitOidResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, missing: false, error: required.error as GitOperationError, executor: required.executor };
  const refError = validateRef("ref", ref);
  if (refError) return { ok: false, missing: false, error: refError, executor: required.executor };
  const result = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], root);
  if (result.ok && isValidGitObjectId(result.stdout)) return { ok: true, oid: result.stdout, executor: required.executor };
  return {
    ok: false,
    missing: result.exitCode === 128,
    error: error("io", "io_failure", "GIT_REF_OID_UNAVAILABLE", `Could not resolve ${ref} to an immutable commit.`, "Restore the expected Git ref and retry.", { ref, exitCode: result.exitCode }, result.stderr || result.stdout),
    executor: required.executor,
  };
}
export function resolveRemoteBranchOid(root: string, branch: string): GitOidResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, missing: false, error: required.error as GitOperationError, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, missing: false, error: branchError, executor: required.executor };
  const remoteRef = `refs/heads/${branch}`;
  const result = run("git", ["ls-remote", "--heads", "origin", remoteRef], root);
  if (!result.ok) {
    return { ok: false, missing: false, error: error("io", "io_failure", "REMOTE_BRANCH_QUERY_FAILED", `Could not inspect origin/${branch}.`, "Restore origin access and retry.", { branch, exitCode: result.exitCode }, result.stderr), executor: required.executor };
  }
  const rows = result.stdout.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (!rows.length) {
    return { ok: false, missing: true, error: error("io", "io_failure", "REMOTE_BRANCH_MISSING", `origin/${branch} does not exist.`, "Refresh workflow state before retrying.", { branch }), executor: required.executor };
  }
  const parsed = rows.length === 1 ? rows[0].split(/\s+/) : [];
  if (parsed.length !== 2 || parsed[1] !== remoteRef || !isValidGitObjectId(parsed[0])) {
    return { ok: false, missing: false, error: error("io", "io_failure", "REMOTE_BRANCH_QUERY_INVALID", `origin/${branch} returned invalid ref evidence.`, "Repair the remote ref or Git client before retrying.", { branch, output: result.stdout }), executor: required.executor };
  }
  return { ok: true, oid: parsed[0], executor: required.executor };
}
export function isAncestorCommit(root: string, ancestorOid: string, descendantOid: string): GitBooleanResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  if (!isValidGitObjectId(ancestorOid) || !isValidGitObjectId(descendantOid)) {
    return { ok: false, error: invalidGitObjectIdError(!isValidGitObjectId(ancestorOid) ? ancestorOid : descendantOid), executor: required.executor };
  }
  const result = run("git", ["merge-base", "--is-ancestor", ancestorOid, descendantOid], root);
  if (result.ok) return { ok: true, value: true, executor: required.executor };
  if (result.exitCode === 1) return { ok: true, value: false, executor: required.executor };
  return { ok: false, error: error("io", "io_failure", "GIT_ANCESTRY_CHECK_FAILED", "Could not determine commit ancestry.", "Restore the local object database and retry.", { ancestorOid, descendantOid, exitCode: result.exitCode }, result.stderr), executor: required.executor };
}
export function fetchRemoteBaseEvidence(root: string, identity: MergeIdentity): { evidence: GitIntegrationEvidence; executor?: ExecutorCapability } {
  const unavailable = (reason: string, head: GitIntegrationEvidence["head"] = { status: "unavailable", reason }): { evidence: GitIntegrationEvidence } => ({
    evidence: { status: "unavailable", repository: identity.repository, baseBranch: identity.baseBranch, verifiedOid: identity.verifiedOid, reason, head },
  });
  const identityError = validateMergeIdentityInput(identity);
  if (identityError) return unavailable(identityError.message);
  const required = requireGitExecutor();
  if (!required.ok) return { ...unavailable(String((required.error as GitOperationError).message)), executor: required.executor };
  const origin = resolveOriginRepository(root);
  if (!origin.ok) return { ...unavailable(origin.error.message), executor: required.executor };
  if (origin.repository !== identity.repository) return { ...unavailable(repositoryChangedError(identity.repository, origin.repository).message), executor: required.executor };
  const remoteHead = resolveRemoteBranchOid(root, identity.headBranch);
  const head: GitIntegrationEvidence["head"] = remoteHead.ok
    ? { status: "present", oid: remoteHead.oid }
    : remoteHead.missing ? { status: "missing" } : { status: "unavailable", reason: remoteHead.error.message };
  const remoteBaseRef = `refs/remotes/origin/${identity.baseBranch}`;
  const refspec = `+refs/heads/${identity.baseBranch}:${remoteBaseRef}`;
  const fetched = run("git", ["fetch", "--no-tags", "origin", refspec], root);
  if (!fetched.ok) return { ...unavailable(`Fresh base fetch failed: ${fetched.stderr || "unknown Git error"}`, head), executor: required.executor };
  const base = resolveRefOid(root, remoteBaseRef);
  if (!base.ok) return { ...unavailable(base.error.message, head), executor: required.executor };
  const ancestor = isAncestorCommit(root, identity.verifiedOid, base.oid);
  if (!ancestor.ok) return { ...unavailable(ancestor.error.message, head), executor: required.executor };
  return {
    evidence: {
      status: "available",
      repository: identity.repository,
      baseBranch: identity.baseBranch,
      verifiedOid: identity.verifiedOid,
      baseOid: base.oid,
      containsVerifiedOid: ancestor.value,
      head,
    },
    executor: required.executor,
  };
}
export function inspectPullRequestForMerge(root: string, identity: MergeIdentity): { evidence: PullRequestEvidence; executor?: ExecutorCapability } {
  const identityError = validateMergeIdentityInput(identity);
  if (identityError) return { evidence: { status: "unavailable", reason: identityError.message } };
  const required = requireBoundGhExecutor();
  if (!required.ok) return { evidence: { status: "unavailable", reason: String((required.error as GitOperationError).message) }, executor: required.executor };
  let reason = "GitHub PR inspection failed.";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = run("gh", ["pr", "view", String(identity.prNumber), "--repo", identity.repository, "--json", "state,baseRefName,headRefName,headRefOid,isCrossRepository"], root);
    if (!result.ok) {
      reason = `GitHub PR inspection failed (${attempt}/3): ${result.stderr || "unknown gh error"}`;
      continue;
    }
    try {
      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      const snapshot = parsePullRequestSnapshot({
        identity: {
          repository: identity.repository,
          prNumber: identity.prNumber,
          baseBranch: data.baseRefName,
          headBranch: data.headRefName,
          headOid: data.headRefOid,
          isCrossRepository: data.isCrossRepository,
        },
        lifecycle: { state: data.state },
      });
      if (snapshot) return { evidence: { status: "available", snapshot }, executor: required.executor };
      reason = `GitHub PR inspection returned invalid identity or lifecycle data (${attempt}/3).`;
    } catch (caught: any) {
      reason = `GitHub PR inspection returned invalid JSON (${attempt}/3): ${caught?.message ?? String(caught)}`;
    }
  }
  return { evidence: { status: "unavailable", reason }, executor: required.executor };
}
export function executePrMerge(root: string, identity: MergeIdentity): GitActionResult {
  const identityError = validateMergeIdentityInput(identity);
  if (identityError) return { ok: false, error: identityError };
  const required = requireBoundGhExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const origin = resolveOriginRepository(root);
  if (!origin.ok) return { ok: false, error: origin.error, executor: required.executor };
  if (origin.repository !== identity.repository) return { ok: false, error: repositoryChangedError(identity.repository, origin.repository), executor: required.executor };
  const result = run("gh", ["pr", "merge", String(identity.prNumber), "--repo", identity.repository, "--match-head-commit", identity.verifiedOid, "--merge", "--delete-branch"], root);
  if (result.ok) return { ok: true, executor: required.executor };
  return { ok: false, error: error("io", "io_failure", "PR_MERGE_COMMAND_FAILED", `GitHub merge command for PR #${identity.prNumber} did not confirm success.`, "Reconcile the persisted merge receipt before any retry; do not invoke the merge mutation again until the outcome is known.", { identity, exitCode: result.exitCode }, result.stderr), executor: required.executor };
}
type ActiveRecoveryResult =
  | { ok: true; required: false; identityError: GitOperationError }
  | { ok: true; required: true; record: CommitRecoveryRecord }
  | { ok: false; error: GitOperationError };
function verifiedCommitIdentityMissing(detail: Record<string, unknown>): GitOperationError {
  return error(
    "workflow_state",
    "invalid_phase",
    "VERIFIED_COMMIT_OID_MISSING",
    "Workflow state does not contain the exact verified commit identity required for CI or merge.",
    "Return to hy_verify and hy_commit so the verified commit identity can be recorded before querying or merging the PR.",
    detail,
  );
}
function activeCommitRecovery(root: string): ActiveRecoveryResult {
  let state;
  try {
    state = readState();
  } catch (caught: any) {
    return {
      ok: false,
      error: error("workflow_state", "invalid_phase", "WORKFLOW_STATE_UNAVAILABLE", "Could not read the workflow state needed to bind the PR commit.", "Repair or reset workflow state before retrying.", undefined, caught?.message ?? String(caught)),
    };
  }
  if (!state.plan) {
    return {
      ok: true,
      required: false,
      identityError: verifiedCommitIdentityMissing({
        reason: "plan_missing",
        implementationDigest: state.verifiedImplementationDigest,
        branch: state.branch,
      }),
    };
  }
  const raw = (state.approval as ({ commitRecovery?: unknown } | null))?.commitRecovery;
  const record = parseCommitRecovery(raw);
  let baseBranch: string;
  try {
    requireRuntimeConfig(root);
    baseBranch = getBaseBranch(root);
  } catch (caught: any) {
    return { ok: false, error: caught as GitOperationError };
  }
  if (!record || record.implementationDigest !== state.verifiedImplementationDigest || record.branch !== state.branch || record.baseBranch !== baseBranch) {
    return {
      ok: false,
      error: verifiedCommitIdentityMissing({ implementationDigest: state.verifiedImplementationDigest, branch: state.branch, baseBranch, recovery: raw ?? null }),
    };
  }
  return { ok: true, required: true, record };
}
export type ResolveMergeIdentityResult = { ok: true; identity: MergeIdentity; executor?: ExecutorCapability }
  | { ok: false; error: GitOperationError; executor?: ExecutorCapability };
export function resolveMergeIdentity(root: string, prNumber: unknown): ResolveMergeIdentityResult {
  const valid = validatePrNumber(prNumber);
  if (!valid.ok) return { ok: false, error: valid.error };
  const recovery = activeCommitRecovery(root);
  if (!recovery.ok) return { ok: false, error: recovery.error };
  if (!recovery.required) return { ok: false, error: recovery.identityError };
  const origin = resolveOriginRepository(root);
  if (!origin.ok) return { ok: false, error: origin.error, executor: origin.executor };
  if (origin.repository !== recovery.record.repository) {
    return { ok: false, error: repositoryChangedError(recovery.record.repository, origin.repository), executor: origin.executor };
  }
  const identity: MergeIdentity = {
    repository: recovery.record.repository,
    prNumber: valid.value,
    baseBranch: recovery.record.baseBranch,
    headBranch: recovery.record.branch,
    verifiedOid: recovery.record.commitOid,
  };
  const identityError = validateMergeIdentityInput(identity);
  return identityError ? { ok: false, error: identityError, executor: origin.executor } : { ok: true, identity, executor: origin.executor };
}
export function resolveHeadCommit(root: string): { ok: boolean; hash?: string; error?: GitOperationError; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const head = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (!head.ok) {
    return {
      ok: false,
      error: error("io", "io_failure", "GIT_HEAD_UNAVAILABLE", "Could not resolve the current commit.", "Repair the workflow branch and retry hy_commit.", undefined, head.stderr),
      executor: required.executor,
    };
  }
  if (!isValidGitObjectId(head.stdout)) return { ok: false, error: invalidGitObjectIdError(head.stdout), executor: required.executor };
  return { ok: true, hash: head.stdout, executor: required.executor };
}

function remoteBaseRefExists(root: string, baseBranch: string): boolean {
  if (!isSafeGitRefName(baseBranch)) return false;
  const localRef = `refs/remotes/origin/${baseBranch}`;
  const localExists = run("git", ["show-ref", "--verify", "--quiet", localRef], root).ok;
  if (!localExists) return false;
  const lsRemote = run("git", ["ls-remote", "--heads", "origin", baseBranch], root);
  if (!lsRemote.ok) return false;
  const expected = `refs/heads/${baseBranch}`;
  return lsRemote.stdout.split(/\r?\n/).some(line => line.trim().endsWith(`\t${expected}`));
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
        hint: `Fetch or publish the configured base branch before retrying hy_branch, for example: git fetch origin ${base}. If this project uses a different base branch, update project.baseBranch in the authoritative project configuration.`,
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
  const r1 = run("git", ["add", "-A", "--", ".", ...runtimeArtifactExclusionPathspecs(root)], root);
  if (!r1.ok) return { ok: false, error: r1.stderr, executor: required.executor };
  const msgFile = writeTempFile(`${title}\n\n${body}`);
  try {
    const r2 = run("git", ["commit", "--only", "-F", msgFile, "--", ".", ...runtimeArtifactExclusionPathspecs(root)], root);
    if (!r2.ok) return { ok: false, error: r2.stderr, executor: required.executor };
    const r3 = run("git", ["rev-parse", "HEAD"], root);
    return { ok: true, hash: r3.stdout, executor: required.executor };
  } finally {
    fs.unlinkSync(msgFile);
  }
}

export type ScopedWorktreeResult =
  | { ok: true; changedPaths: string[]; executor?: ExecutorCapability }
  | { ok: false; changedPaths: string[]; error: unknown; executor?: ExecutorCapability };

export function inspectScopedWorktree(root: string, scope: PlanDoc["scope"]): ScopedWorktreeResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, changedPaths: [], error: required.error, executor: required.executor };
  const files = [...new Set([...scope.changes, ...scope.new_files, ...scope.delete])]
    .filter(file => !isRuntimeIgnoredArtifact(root, file));
  if (!files.length) {
    return {
      ok: false,
      changedPaths: [],
      error: error(
        "workflow_state",
        "invalid_phase",
        "NO_SCOPE_FILES",
        "PlanDoc scope does not declare any authoritative files to commit.",
        "Return to hy_plan and declare every intended non-legacy implementation path before committing.",
      ),
      executor: required.executor,
    };
  }

  const changedPaths: string[] = [];
  for (const file of files) {
    const status = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file], root);
    if (!status.ok) {
      return {
        ok: false,
        changedPaths,
        error: error(
          "io",
          "io_failure",
          "GIT_STATUS_FAILED",
          `Could not inspect scoped worktree path ${file}.`,
          "Repair the Git worktree, then retry hy_commit without changing the verified snapshot.",
          { file },
          status.stderr,
        ),
        executor: required.executor,
      };
    }
    if (status.stdout.length > 0) changedPaths.push(file);
  }
  return { ok: true, changedPaths, executor: required.executor };
}

export function commitScope(root: string, scope: PlanDoc["scope"], title: string, body: string): { ok: boolean; hash?: string; error?: unknown; executor?: ExecutorCapability; stagedPaths?: string[] } {
  const inspection = inspectScopedWorktree(root, scope);
  if (!inspection.ok) return { ok: false, error: inspection.error, executor: inspection.executor, stagedPaths: inspection.changedPaths };

  // A PlanDoc persists across CI-fix commit loops. Only stage paths that are
  // currently dirty; an earlier commit may already have removed delete paths.
  const changedFiles = inspection.changedPaths;
  if (!changedFiles.length) {
    return {
      ok: false,
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "NO_SCOPED_CHANGES",
        message: "No current worktree changes match the approved PlanDoc scope.",
        hint: "Inspect git status. If the intended changes are already committed, continue recovery without creating an empty commit; otherwise edit only approved scope files and rerun verification.",
        detail: { scopeFiles: [...scope.changes, ...scope.new_files, ...scope.delete] },
      },
      executor: inspection.executor,
      stagedPaths: [],
    };
  }

  const r1 = run("git", ["add", "-A", "--", ...changedFiles], root);
  if (!r1.ok) return { ok: false, error: r1.stderr, executor: inspection.executor, stagedPaths: changedFiles };
  const msgFile = writeTempFile(`${title}\n\n${body}`);
  try {
    const r2 = run("git", ["commit", "--only", "-F", msgFile, "--", ...changedFiles], root);
    if (!r2.ok) return { ok: false, error: r2.stderr, executor: inspection.executor, stagedPaths: changedFiles };
    const r3 = run("git", ["rev-parse", "HEAD"], root);
    return { ok: true, hash: r3.stdout, executor: inspection.executor, stagedPaths: changedFiles };
  } finally {
    fs.unlinkSync(msgFile);
  }
}

export function push(root: string, branch: string, expectedHeadOid: string, expectedRepository: string): { ok: boolean; hash?: string; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  const head = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (!head.ok) return { ok: false, error: error("io", "io_failure", "GIT_HEAD_UNAVAILABLE", "Could not resolve the current commit before push.", "Repair the workflow branch and retry hy_commit.", undefined, head.stderr), executor: required.executor };
  if (!isValidGitObjectId(expectedHeadOid)) return { ok: false, error: invalidGitObjectIdError(expectedHeadOid), executor: required.executor };
  if (!isValidGitObjectId(head.stdout) || head.stdout !== expectedHeadOid) {
    return {
      ok: false,
      error: error(
        "workflow_state",
        "invalid_phase",
        "GIT_HEAD_OID_MISMATCH",
        "The current Git commit no longer matches the verified commit selected for push.",
        "Do not push. Restore the workflow branch to the verified commit or rerun hy_verify and hy_commit.",
        { expected: expectedHeadOid, actual: head.stdout },
      ),
      executor: required.executor,
    };
  }
  const origin = resolveOriginRepository(root);
  if (!origin.ok) return { ok: false, error: origin.error, executor: origin.executor ?? required.executor };
  if (origin.repository !== expectedRepository) return { ok: false, error: repositoryChangedError(expectedRepository, origin.repository), executor: origin.executor ?? required.executor };
  const refspec = `${expectedHeadOid}:refs/heads/${branch}`;
  const r = run("git", ["push", "-u", "origin", refspec], root);
  if (!r.ok) {
    return {
      ok: false,
      error: error("io", "io_failure", "GIT_PUSH_FAILED", `Could not push verified commit ${expectedHeadOid} to ${branch}.`, "Resolve the origin push failure, then retry hy_commit with the same verified commit.", { branch, expected: expectedHeadOid, expectedRepository, refspec }, r.stderr),
      executor: required.executor,
    };
  }
  return { ok: true, hash: expectedHeadOid, executor: required.executor };
}

export function pushForceWithLease(root: string, branch: string, expectedRemoteOid: string, localOid: string): GitActionResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  if (!isValidGitObjectId(expectedRemoteOid) || !isValidGitObjectId(localOid)) {
    return { ok: false, error: invalidGitObjectIdError(!isValidGitObjectId(expectedRemoteOid) ? expectedRemoteOid : localOid), executor: required.executor };
  }
  const local = resolveRefOid(root, `refs/heads/${branch}`);
  if (!local.ok) return { ok: false, error: local.error, executor: required.executor };
  if (local.oid !== localOid) {
    return { ok: false, error: error("workflow_state", "invalid_phase", "LOCAL_BRANCH_OID_MISMATCH", `Local branch ${branch} moved after its sync receipt was prepared.`, "Restore the recorded local branch commit or restart merge synchronization from a newly verified state.", { branch, expected: localOid, actual: local.oid }), executor: required.executor };
  }
  const remote = resolveRemoteBranchOid(root, branch);
  if (!remote.ok) return { ok: false, error: remote.error, executor: required.executor };
  if (remote.oid !== expectedRemoteOid) {
    return { ok: false, error: error("workflow_state", "invalid_phase", "REMOTE_BRANCH_OID_MISMATCH", `Remote branch ${branch} moved after its sync receipt was prepared.`, "Inspect the downstream branch update and rebuild the synchronization receipt before pushing.", { branch, expected: expectedRemoteOid, actual: remote.oid }), executor: required.executor };
  }
  const destination = `refs/heads/${branch}`;
  const refspec = `${localOid}:${destination}`;
  const lease = `--force-with-lease=${destination}:${expectedRemoteOid}`;
  const pushed = run("git", ["push", lease, "origin", refspec], root);
  if (!pushed.ok) return { ok: false, error: error("io", "io_failure", "GIT_FORCE_WITH_LEASE_FAILED", `Could not safely update ${branch}.`, "Resolve the remote change or push failure, then retry without weakening the lease.", { branch, expectedRemoteOid, localOid, refspec, lease }, pushed.stderr), executor: required.executor };
  return { ok: true, oid: localOid, executor: required.executor };
}

type OpenPr = { number: number; url: string; headRefOid: string };
type PrLookupResult = { ok: true; pr?: OpenPr } | { ok: false; error: GitOperationError };
export type CreatePrResult = { ok: boolean; prNumber?: number; url?: string; reused?: boolean; repository?: string; headRefOid?: string; error?: unknown; executor?: ExecutorCapability };

function findOpenPr(root: string, repository: string, baseBranch: string, headBranch: string, expectedHeadOid: string): PrLookupResult {
  const result = run("gh", ["pr", "list", "--repo", repository, "--state", "open", "--base", baseBranch, "--head", headBranch, "--limit", "2", "--json", "number,url,state,baseRefName,headRefName,headRefOid,isCrossRepository"], root);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        type: "io",
        subtype: "io_failure",
        code: "PR_LOOKUP_FAILED",
        message: `Could not inspect open pull requests for ${headBranch} -> ${baseBranch}.`,
        hint: "Resolve the GitHub CLI or API failure, then retry without creating another pull request manually.",
        detail: { repository, baseBranch, headBranch, expectedHeadOid },
        cause: result.stderr,
        retryable: true,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e: any) {
    return {
      ok: false,
      error: error(
        "io",
        "io_failure",
        "PR_LOOKUP_INVALID",
        "GitHub CLI returned invalid JSON while inspecting open pull requests.",
        "Repair or update gh, then retry; hy-workflow will not create a PR while the existing-PR lookup is untrusted.",
        { repository, baseBranch, headBranch, expectedHeadOid },
        e?.message ?? String(e),
      ),
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: error(
        "io",
        "io_failure",
        "PR_LOOKUP_INVALID",
        "GitHub CLI returned an invalid pull request list.",
        "Repair or update gh, then retry; hy-workflow will not create a PR while the existing-PR lookup is untrusted.",
        { repository, baseBranch, headBranch, expectedHeadOid },
      ),
    };
  }
  const prs: OpenPr[] = [];
  for (const value of parsed) {
    if (
      !value
      || typeof value !== "object"
      || !isValidPrNumber((value as any).number)
      || typeof (value as any).url !== "string"
      || !(value as any).url.trim()
      || (value as any).state !== "OPEN"
      || (value as any).baseRefName !== baseBranch
      || (value as any).headRefName !== headBranch
      || (value as any).isCrossRepository !== false
    ) {
      return {
        ok: false,
        error: error(
          "io",
          "io_failure",
          "PR_LOOKUP_INVALID",
          "GitHub CLI returned a pull request that did not exactly match the current repository, base branch, and head branch.",
          "Inspect the repository and gh output, then retry; hy-workflow will not guess which PR to use.",
          { repository, baseBranch, headBranch, expectedHeadOid },
        ),
      };
    }
    const actualHeadOid = (value as any).headRefOid;
    if (!isValidGitObjectId(actualHeadOid)) {
      return {
        ok: false,
        error: error("io", "io_failure", "PR_LOOKUP_INVALID", "GitHub CLI returned an invalid pull request head object ID.", "Inspect the repository and gh output, then retry; hy-workflow will not reuse an unverified PR.", { repository, baseBranch, headBranch, expectedHeadOid, actualHeadOid }),
      };
    }
    if (actualHeadOid !== expectedHeadOid) {
      return {
        ok: false,
        error: error("workflow_state", "invalid_phase", "PR_HEAD_OID_MISMATCH", `Open PR #${(value as any).number} does not point at the verified commit.`, "Do not create another PR. Repair the remote workflow branch or rerun verification before retrying hy_commit.", { repository, baseBranch, headBranch, expectedHeadOid, actualHeadOid, prNumber: (value as any).number }),
      };
    }
    prs.push({ number: (value as any).number, url: (value as any).url.trim(), headRefOid: actualHeadOid });
  }
  if (prs.length > 1) {
    return {
      ok: false,
      error: error(
        "workflow_state",
        "invalid_phase",
        "PR_LOOKUP_AMBIGUOUS",
        `Multiple open pull requests match ${headBranch} -> ${baseBranch}.`,
        "Close the duplicate PRs or repair the branch context, then retry hy_commit.",
        { repository, baseBranch, headBranch, expectedHeadOid, prNumbers: prs.map(pr => pr.number) },
      ),
    };
  }
  return { ok: true, pr: prs[0] };
}

export function createPr(root: string, title: string, body: string, baseBranch: string, headBranch: string, expectedHeadOid: string, expectedRepository: string): CreatePrResult {
  const required = requireBoundGhExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const baseError = validateRef("baseBranch", baseBranch);
  if (baseError) return { ok: false, error: baseError, executor: required.executor };
  const headError = validateRef("headBranch", headBranch);
  if (headError) return { ok: false, error: headError, executor: required.executor };
  if (!isValidGitObjectId(expectedHeadOid)) return { ok: false, error: invalidGitObjectIdError(expectedHeadOid), executor: required.executor };
  const origin = resolveOriginRepository(root);
  if (!origin.ok) return { ok: false, error: origin.error, executor: required.executor };
  const repository = origin.repository;
  if (repository !== expectedRepository) return { ok: false, error: repositoryChangedError(expectedRepository, repository), executor: required.executor };
  const existing = findOpenPr(root, repository, baseBranch, headBranch, expectedHeadOid);
  if (!existing.ok) return { ok: false, error: existing.error, executor: required.executor };
  if (existing.pr) return { ok: true, prNumber: existing.pr.number, url: existing.pr.url, reused: true, repository, headRefOid: existing.pr.headRefOid, executor: required.executor };

  const bodyFile = writeTempFile(body);
  try {
    const r = run("gh", ["pr", "create", "--repo", repository, "--title", title, "--body-file", bodyFile, "--base", baseBranch, "--head", headBranch], root);
    const match = r.ok ? r.stdout.match(/\/pull\/(\d+)\/?$/) : null;
    const reportedPrNumber = match ? parseInt(match[1], 10) : null;
    const afterCreate = findOpenPr(root, repository, baseBranch, headBranch, expectedHeadOid);
    if (!afterCreate.ok) return { ok: false, error: afterCreate.error, executor: required.executor };
    if (!afterCreate.pr) {
      return {
        ok: false,
        error: error("io", "io_failure", "PR_CREATE_UNCONFIRMED", "Pull request creation could not be confirmed against the verified commit.", "Inspect GitHub for the exact repository/base/head pair, resolve the API issue, then retry hy_commit without creating a duplicate PR.", { repository, baseBranch, headBranch, expectedHeadOid, reportedPrNumber }, r.ok ? undefined : r.stderr),
        executor: required.executor,
      };
    }
    if (r.ok && isValidPrNumber(reportedPrNumber) && reportedPrNumber !== afterCreate.pr.number) {
      return {
        ok: false,
        error: error("workflow_state", "invalid_phase", "PR_CREATE_CONFIRMATION_MISMATCH", "GitHub CLI creation output did not match the confirmed pull request.", "Inspect the repository and close any incorrect duplicate before retrying hy_commit.", { repository, baseBranch, headBranch, expectedHeadOid, reportedPrNumber, confirmedPrNumber: afterCreate.pr.number }),
        executor: required.executor,
      };
    }
    return { ok: true, prNumber: afterCreate.pr.number, url: afterCreate.pr.url, reused: !r.ok, repository, headRefOid: afterCreate.pr.headRefOid, executor: required.executor };
  } finally {
    fs.unlinkSync(bodyFile);
  }
}

type InspectedPr = Record<string, unknown>;
type InspectPrResult = { ok: true; data: InspectedPr } | { ok: false; error: GitOperationError };

function inspectPr(root: string, prNumber: number, repoArgs: string[]): InspectPrResult {
  const result = run("gh", ["pr", "view", String(prNumber), ...repoArgs, "--json", "state,baseRefName,headRefName,headRefOid,isCrossRepository"], root);
  if (!result.ok) {
    return { ok: false, error: error("io", "io_failure", "CI_QUERY_FAILED", `Could not inspect PR #${prNumber}.`, "Resolve the GitHub CLI or API failure, then retry.", { prNumber }, result.stderr) };
  }
  try {
    const data = JSON.parse(result.stdout);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("expected an object");
    return { ok: true, data };
  } catch (caught: any) {
    return { ok: false, error: error("io", "io_failure", "CI_QUERY_INVALID", `GitHub CLI returned invalid JSON for PR #${prNumber}.`, "Repair or update gh, then retry.", { prNumber }, caught?.message ?? String(caught)) };
  }
}

function validatePrIdentity(data: InspectedPr, prNumber: number, record: CommitRecoveryRecord): GitOperationError | null {
  if (data.state !== "OPEN" || data.baseRefName !== record.baseBranch || data.headRefName !== record.branch || data.isCrossRepository !== false) {
    return error(
      "workflow_state",
      "invalid_phase",
      "PR_IDENTITY_MISMATCH",
      `PR #${prNumber} no longer matches the verified repository/base/head identity.`,
      "Do not merge. Restore the exact PR identity or rerun verification and commit through a new workflow.",
      {
        prNumber,
        expected: { baseRefName: record.baseBranch, headRefName: record.branch, isCrossRepository: false },
        actual: { state: data.state, baseRefName: data.baseRefName, headRefName: data.headRefName, isCrossRepository: data.isCrossRepository },
      },
    );
  }
  if (!isValidGitObjectId(data.headRefOid) || data.headRefOid !== record.commitOid) {
    return error(
      "workflow_state",
      "invalid_phase",
      "PR_HEAD_OID_MISMATCH",
      `PR #${prNumber} no longer points at the verified commit.`,
      "Do not merge. Restore the remote branch to the verified commit or rerun hy_verify and hy_commit.",
      { prNumber, expectedHeadOid: record.commitOid, actualHeadOid: data.headRefOid },
    );
  }
  return null;
}

export function mergePr(root: string, prNumber: unknown): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const valid = validatePrNumber(prNumber);
  if (!valid.ok) return { ok: false, error: valid.error };
  const required = requireBoundGhExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const recovery = activeCommitRecovery(root);
  if (!recovery.ok) return { ok: false, error: recovery.error, executor: required.executor };
  if (!recovery.required) return { ok: false, error: recovery.identityError, executor: required.executor };
  const origin = resolveOriginRepository(root);
  if (!origin.ok) return { ok: false, error: origin.error, executor: required.executor };
  if (origin.repository !== recovery.record.repository) {
    return { ok: false, error: repositoryChangedError(recovery.record.repository, origin.repository), executor: required.executor };
  }
  const repoArgs = ["--repo", origin.repository];
  const inspected = inspectPr(root, valid.value, repoArgs);
  if (!inspected.ok) return { ok: false, error: inspected.error, executor: required.executor };
  const identityError = validatePrIdentity(inspected.data, valid.value, recovery.record);
  if (identityError) return { ok: false, error: identityError, executor: required.executor };
  return executePrMerge(root, {
    repository: recovery.record.repository,
    prNumber: valid.value,
    baseBranch: recovery.record.baseBranch,
    headBranch: recovery.record.branch,
    verifiedOid: recovery.record.commitOid,
  });
}

export type CiCheck = {
  name: string;
  conclusion: string;
  workflow: string;
  link: string;
  provenanceVerified: boolean;
  provenanceDetail?: string;
};

export function isVerifyCheckIdentity(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized === "Verify";
}

export function classifyVerifyChecks(checks: CiCheck[]): { candidates: CiCheck[]; required: CiCheck[]; effective: CiCheck[]; rollupEffective: CiCheck[]; allGreen: boolean } {
  const candidates = checks.filter(check => isVerifyCheckIdentity(check.name));
  const required = candidates.filter(check => check.provenanceVerified);
  const effective = required.filter(check => check.conclusion !== "SKIPPED" && check.conclusion !== "NEUTRAL");
  const rollupEffective = checks.filter(check => check.conclusion !== "SKIPPED" && check.conclusion !== "NEUTRAL");
  const allGreen = required.length === 1
    && effective.length === 1
    && effective.every(check => check.conclusion === "SUCCESS")
    && rollupEffective.every(check => check.conclusion === "SUCCESS");
  return { candidates, required, effective, rollupEffective, allGreen };
}

function queryCiChecks(root: string, prNumber: number, repoArgs: string[]): { ok: true; checks: CiCheck[] } | { ok: false; error: GitOperationError } {
  const result = run("gh", ["pr", "checks", String(prNumber), ...repoArgs, "--json", "name,workflow,bucket,state,link"], root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (caught: any) {
    return {
      ok: false,
      error: error(
        "io",
        "io_failure",
        "CI_QUERY_FAILED",
        "Could not read structured checks for PR #" + prNumber + ".",
        "Update or repair gh so its pr checks JSON fields name,workflow,bucket,state,link are available, then retry hy_commit.",
        { prNumber },
        result.stderr || caught?.message || String(caught),
      ),
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: error("io", "io_failure", "CI_QUERY_INVALID", "GitHub CLI returned an invalid checks list.", "Repair or update gh, then retry hy_commit.", { prNumber }) };
  }
  const checks = parsed.map((value: any): CiCheck => {
    const bucket = typeof value?.bucket === "string" ? value.bucket.toLowerCase() : "";
    const state = typeof value?.state === "string" ? value.state.toUpperCase() : "UNKNOWN";
    const conclusion = bucket === "pass"
      ? "SUCCESS"
      : bucket === "fail"
        ? (["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"].includes(state) ? state : "FAILURE")
        : bucket === "cancel"
          ? "CANCELLED"
          : bucket === "skipping"
            ? (state === "NEUTRAL" ? "NEUTRAL" : "SKIPPED")
            : bucket === "pending" ? "PENDING" : "UNKNOWN";
    return {
      name: typeof value?.name === "string" ? value.name.trim() : "",
      conclusion,
      workflow: typeof value?.workflow === "string" ? value.workflow.trim() : "",
      link: typeof value?.link === "string" ? value.link.trim() : "",
      provenanceVerified: false,
    };
  });
  return { ok: true, checks };
}

function actionsRunId(link: string, repository: string): string | null {
  const [host, owner, name] = repository.split("/");
  if (!host || !owner || !name) return null;
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== host.toLowerCase()) return null;
    const parts = parsed.pathname.split("/").filter(Boolean).map(value => decodeURIComponent(value));
    if (
      parts.length < 5
      || parts[0].toLowerCase() !== owner.toLowerCase()
      || parts[1].toLowerCase() !== name.toLowerCase()
      || parts[2] !== "actions"
      || parts[3] !== "runs"
      || !/^\d+$/.test(parts[4])
      || (parts.length > 5 && !(parts.length === 7 && parts[5] === "job" && /^\d+$/.test(parts[6])))
    ) return null;
    return parts[4];
  } catch {
    return null;
  }
}

function verifyActionsRun(
  root: string,
  repository: string,
  runId: string,
  expectedHeadOid: string,
): { ok: true; trusted: boolean; detail: string } | { ok: false; error: GitOperationError } {
  const [host, owner, name] = repository.split("/");
  const result = run("gh", ["api", "--hostname", host, "repos/" + owner + "/" + name + "/actions/runs/" + runId], root);
  if (!result.ok) {
    return {
      ok: false,
      error: error("io", "io_failure", "CI_PROVENANCE_QUERY_FAILED", "Could not verify GitHub Actions run " + runId + ".", "Resolve the GitHub API failure, then retry hy_commit; do not merge based on an unverified check name.", { repository, runId }, result.stderr),
    };
  }
  let data: any;
  try { data = JSON.parse(result.stdout); }
  catch (caught: any) {
    return { ok: false, error: error("io", "io_failure", "CI_PROVENANCE_QUERY_INVALID", "GitHub Actions run " + runId + " returned invalid JSON.", "Repair or update gh, then retry hy_commit.", { repository, runId }, caught?.message ?? String(caught)) };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: error("io", "io_failure", "CI_PROVENANCE_QUERY_INVALID", "GitHub Actions run " + runId + " returned an invalid object.", "Repair or update gh, then retry hy_commit.", { repository, runId }) };
  }
  const expectedFullName = (owner + "/" + name).toLowerCase();
  const expectedWorkflowPath = ".github/workflows/hy-workflow.yml";
  const workflowPathMatches = data.path === expectedWorkflowPath || (
    typeof data.path === "string"
    && data.path.startsWith(expectedWorkflowPath + "@")
    && data.path.length > expectedWorkflowPath.length + 1
  );
  const trusted = String(data.id) === runId
    && data.name === "hy-workflow"
    && workflowPathMatches
    && data.head_sha === expectedHeadOid
    && data.event === "pull_request"
    && typeof data.repository?.full_name === "string"
    && data.repository.full_name.toLowerCase() === expectedFullName;
  return {
    ok: true,
    trusted,
    detail: trusted
      ? "actions run " + runId + " verified"
      : "actions run " + runId + " did not match repository, workflow path, pull_request event, and verified head SHA",
  };
}

export function checkCi(root: string, prNumber: unknown): { ok: boolean; allGreen: boolean; noChecks?: boolean; noEffectiveChecks?: boolean; requiredCheckMissing?: boolean; requiredCheckAmbiguous?: boolean; checks: CiCheck[]; error?: unknown; executor?: ExecutorCapability } {
  const valid = validatePrNumber(prNumber);
  if (!valid.ok) return { ok: false, allGreen: false, checks: [], error: valid.error };
  const required = requireBoundGhExecutor();
  if (!required.ok) return { ok: false, allGreen: false, checks: [], error: required.error, executor: required.executor };
  const recovery = activeCommitRecovery(root);
  if (!recovery.ok) return { ok: false, allGreen: false, checks: [], error: recovery.error, executor: required.executor };
  const origin = resolveOriginRepository(root);
  if (!origin.ok && recovery.required) return { ok: false, allGreen: false, checks: [], error: origin.error, executor: required.executor };
  if (origin.ok && recovery.required && origin.repository !== recovery.record.repository) {
    return { ok: false, allGreen: false, checks: [], error: repositoryChangedError(recovery.record.repository, origin.repository), executor: required.executor };
  }
  const repoArgs = origin.ok ? ["--repo", origin.repository] : [];
  const inspected = inspectPr(root, valid.value, repoArgs);
  if (!inspected.ok) return { ok: false, allGreen: false, checks: [], error: inspected.error, executor: required.executor };
  if (recovery.required) {
    const identityError = validatePrIdentity(inspected.data, valid.value, recovery.record);
    if (identityError) return { ok: false, allGreen: false, checks: [], error: identityError, executor: required.executor };
  }
  const queried = queryCiChecks(root, valid.value, repoArgs);
  if (!queried.ok) return { ok: false, allGreen: false, checks: [], error: queried.error, executor: required.executor };
  const checks = queried.checks;
  if (checks.length === 0) return { ok: true, allGreen: false, noChecks: true, checks, executor: required.executor };
  const preliminary = checks.filter(check => isVerifyCheckIdentity(check.name) && check.workflow === "hy-workflow");
  if (preliminary.length && !recovery.required) {
    return { ok: false, allGreen: false, checks, error: recovery.identityError, executor: required.executor };
  }
  if (recovery.required) {
    const cache = new Map<string, { trusted: boolean; detail: string }>();
    for (const check of preliminary) {
      const runId = actionsRunId(check.link, recovery.record.repository);
      if (!runId) {
        check.provenanceDetail = "check link is not a run/job URL in the bound origin repository";
        continue;
      }
      let provenance = cache.get(runId);
      if (!provenance) {
        const verified = verifyActionsRun(root, recovery.record.repository, runId, recovery.record.commitOid);
        if (!verified.ok) return { ok: false, allGreen: false, checks, error: verified.error, executor: required.executor };
        provenance = { trusted: verified.trusted, detail: verified.detail };
        cache.set(runId, provenance);
      }
      check.provenanceVerified = provenance.trusted;
      check.provenanceDetail = provenance.detail;
    }
  }
  const verify = classifyVerifyChecks(checks);
  if (verify.required.length === 0) return { ok: true, allGreen: false, noEffectiveChecks: true, requiredCheckMissing: true, checks, executor: required.executor };
  if (verify.required.length > 1) return { ok: true, allGreen: false, noEffectiveChecks: true, requiredCheckAmbiguous: true, checks, executor: required.executor };
  if (verify.effective.length === 0) return { ok: true, allGreen: false, noEffectiveChecks: true, checks, executor: required.executor };
  return { ok: true, allGreen: verify.allGreen, checks, executor: required.executor };
}

export function checkout(root: string, branch: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  const r = run("git", ["checkout", branch], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function checkoutDetached(root: string, oid: string): GitActionResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  if (!isValidGitObjectId(oid)) return { ok: false, error: invalidGitObjectIdError(oid), executor: required.executor };
  const result = run("git", ["checkout", "--detach", oid], root);
  if (!result.ok) return { ok: false, error: error("io", "io_failure", "GIT_DETACHED_CHECKOUT_FAILED", "Could not prepare the recorded downstream commit in detached mode.", "Repair the local object database and worktree, then retry merge synchronization.", { oid }, result.stderr), executor: required.executor };
  return { ok: true, oid, executor: required.executor };
}

export function listLocalBranches(root: string): GitBranchesResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const r = run("git", ["branch", "--format=%(refname:short)"], root);
  if (!r.ok) return { ok: false, error: error("io", "io_failure", "GIT_LOCAL_BRANCH_LIST_FAILED", "Could not enumerate local branches for downstream synchronization.", "Repair the Git worktree and retry; no merge mutation will run without a complete branch snapshot.", undefined, r.stderr), executor: required.executor };
  return { ok: true, branches: r.stdout.split("\n").map(line => line.trim()).filter(Boolean), executor: required.executor };
}

export function pull(root: string): { ok: boolean; error?: unknown; executor?: ExecutorCapability } {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error, executor: required.executor };
  const base = getBaseBranch(root);
  const baseError = validateRef("baseBranch", base);
  if (baseError) return { ok: false, error: baseError, executor: required.executor };
  const r = run("git", ["pull", "origin", base, "--ff-only"], root);
  return { ok: r.ok, error: r.stderr, executor: required.executor };
}

export function isWorktreeClean(root: string): GitBooleanResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const status = run("git", ["status", "--porcelain=v1", "-uall", "--", ".", ...runtimeArtifactExclusionPathspecs(root)], root);
  if (!status.ok) return { ok: false, error: error("io", "io_failure", "GIT_WORKTREE_STATUS_FAILED", "Could not inspect worktree cleanliness.", "Repair the Git worktree and retry synchronization.", undefined, status.stderr), executor: required.executor };
  return { ok: true, value: status.stdout.length === 0, executor: required.executor };
}

export function abortRebase(root: string): GitActionResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const aborted = run("git", ["rebase", "--abort"], root);
  if (!aborted.ok) return { ok: false, error: error("io", "io_failure", "GIT_REBASE_ABORT_FAILED", "Could not abort the interrupted rebase.", "Resolve the rebase state manually before retrying merge synchronization.", undefined, aborted.stderr), executor: required.executor };
  return { ok: true, executor: required.executor };
}

export function rebaseOnto(root: string, targetOid: string): GitActionResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  if (!isValidGitObjectId(targetOid)) return { ok: false, error: invalidGitObjectIdError(targetOid), executor: required.executor };
  const result = run("git", ["rebase", targetOid], root);
  if (!result.ok) return { ok: false, error: error("io", "io_failure", "GIT_DETACHED_REBASE_FAILED", "Could not rebase the detached downstream commit onto the pinned base commit.", "Resolve the rebase conflict or local Git failure, then retry merge synchronization.", { targetOid }, result.stderr), executor: required.executor };
  return { ok: true, executor: required.executor };
}

export function updateBranchRefCas(root: string, branch: string, newOid: string, expectedOldOid: string): GitActionResult {
  const required = requireGitExecutor();
  if (!required.ok) return { ok: false, error: required.error as GitOperationError, executor: required.executor };
  const branchError = validateRef("branch", branch);
  if (branchError) return { ok: false, error: branchError, executor: required.executor };
  if (!isValidGitObjectId(newOid) || !isValidGitObjectId(expectedOldOid)) return { ok: false, error: invalidGitObjectIdError(!isValidGitObjectId(newOid) ? newOid : expectedOldOid), executor: required.executor };
  const ref = `refs/heads/${branch}`;
  const result = run("git", ["update-ref", ref, newOid, expectedOldOid], root);
  if (!result.ok) return { ok: false, error: error("workflow_state", "invalid_phase", "LOCAL_BRANCH_CAS_FAILED", `Local branch ${branch} moved before its staged rebase result could be installed.`, "Do not overwrite the branch. Inspect the local ref change, then reset or repair workflow state before retrying.", { branch, ref, newOid, expectedOldOid }, result.stderr), executor: required.executor };
  return { ok: true, oid: newOid, executor: required.executor };
}
