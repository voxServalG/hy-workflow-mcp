const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_SELECTOR = /^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UNSAFE_REF_CHARS = /[\x00-\x20~^:?*\[\\;$`"'|&<>]/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const AGENT_BRANCH_PREFIXES = ["fix/", "feat/", "chore/", "docs/", "refactor/", "test/", "ci/"] as const;

export type PullRequestLifecycleState = "OPEN" | "MERGED" | "CLOSED";

export type MergeIdentity = {
  repository: string;
  prNumber: number;
  baseBranch: string;
  headBranch: string;
  verifiedOid: string;
};

export type PullRequestSnapshot = {
  identity: {
    repository: string;
    prNumber: number;
    baseBranch: string;
    headBranch: string;
    headOid: string;
    isCrossRepository: boolean;
  };
  lifecycle: {
    state: PullRequestLifecycleState;
  };
};

export type PullRequestEvidence =
  | { status: "available"; snapshot: PullRequestSnapshot }
  | { status: "unavailable"; reason: string };

export type RemoteHeadEvidence =
  | { status: "present"; oid: string }
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

export type GitIntegrationEvidence =
  | {
      status: "available";
      repository: string;
      baseBranch: string;
      verifiedOid: string;
      baseOid: string;
      containsVerifiedOid: boolean;
      head: RemoteHeadEvidence;
    }
  | {
      status: "unavailable";
      repository: string;
      baseBranch: string;
      verifiedOid: string;
      reason: string;
      head: RemoteHeadEvidence;
    };

export type MergeBlockCode =
  | "MERGE_INPUT_INVALID"
  | "PR_IDENTITY_MISMATCH"
  | "PR_HEAD_OID_MISMATCH"
  | "GIT_EVIDENCE_IDENTITY_MISMATCH"
  | "GIT_EVIDENCE_OID_MISMATCH"
  | "GIT_INTEGRATION_EVIDENCE_UNAVAILABLE"
  | "GITHUB_EVIDENCE_UNAVAILABLE"
  | "PR_OPEN_COMMIT_IN_BASE"
  | "PR_MERGED_COMMIT_NOT_REACHABLE"
  | "PR_CLOSED_UNMERGED"
  | "PR_CLOSED_COMMIT_IN_BASE"
  | "PR_MERGE_OUTCOME_UNCONFIRMED";

export type MergeDecision =
  | {
      kind: "merge_allowed";
      evidence: "github+git";
      preparedBaseOid: string;
    }
  | {
      kind: "already_merged";
      evidence: "github+git";
      baseOid: string;
    }
  | {
      kind: "already_integrated";
      evidence: "git";
      baseOid: string;
    }
  | {
      kind: "blocked";
      code: MergeBlockCode;
      retryable: boolean;
      detail: Record<string, unknown>;
    };

export type MergeRemoteOutcome = "pending" | "merged_now" | "already_merged" | "already_integrated";
export type MergeReceiptEvidence = "none" | "github+git" | "git";
export type DownstreamProgressState = "pending" | "rebasing" | "rebased" | "pushed";

export type DownstreamBranchProgress = {
  branch: string;
  preparedLocalOid: string;
  expectedRemoteOid: string;
  state: DownstreamProgressState;
  resultOid: string | null;
};

export type MergeReceipt = {
  version: 1;
  identity: MergeIdentity;
  preparedBaseOid: string;
  mutationAttempted: boolean;
  remote: {
    outcome: MergeRemoteOutcome;
    evidence: MergeReceiptEvidence;
    baseOid: string | null;
    confirmedAt: string | null;
  };
  downstream: {
    syncBaseOid: string | null;
    candidates: string[];
    progress: DownstreamBranchProgress[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isValidGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

function isValidRepository(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY_SELECTOR.test(value);
}

function isSafeGitRefName(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 200 || value.trim() !== value) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{") || UNSAFE_REF_CHARS.test(value)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  return value.split("/").every(part => Boolean(part) && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isAgentBranch(value: unknown): value is string {
  return isSafeGitRefName(value) && AGENT_BRANCH_PREFIXES.some(prefix => value.startsWith(prefix));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
}

function parseMergeIdentity(value: unknown): MergeIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ["repository", "prNumber", "baseBranch", "headBranch", "verifiedOid"])) return null;
  if (
    !isValidRepository(value.repository)
    || !isPositiveInteger(value.prNumber)
    || !isSafeGitRefName(value.baseBranch)
    || !isSafeGitRefName(value.headBranch)
    || value.baseBranch === value.headBranch
    || !isValidGitObjectId(value.verifiedOid)
  ) return null;
  return {
    repository: value.repository,
    prNumber: value.prNumber,
    baseBranch: value.baseBranch,
    headBranch: value.headBranch,
    verifiedOid: value.verifiedOid,
  };
}

export function parsePullRequestSnapshot(value: unknown): PullRequestSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ["identity", "lifecycle"])) return null;
  if (!isRecord(value.identity) || !hasExactKeys(value.identity, ["repository", "prNumber", "baseBranch", "headBranch", "headOid", "isCrossRepository"])) return null;
  if (!isRecord(value.lifecycle) || !hasExactKeys(value.lifecycle, ["state"])) return null;
  const state = value.lifecycle.state;
  if (
    !isValidRepository(value.identity.repository)
    || !isPositiveInteger(value.identity.prNumber)
    || !isSafeGitRefName(value.identity.baseBranch)
    || !isSafeGitRefName(value.identity.headBranch)
    || !isValidGitObjectId(value.identity.headOid)
    || typeof value.identity.isCrossRepository !== "boolean"
    || (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED")
  ) return null;
  return {
    identity: {
      repository: value.identity.repository,
      prNumber: value.identity.prNumber,
      baseBranch: value.identity.baseBranch,
      headBranch: value.identity.headBranch,
      headOid: value.identity.headOid,
      isCrossRepository: value.identity.isCrossRepository,
    },
    lifecycle: { state },
  };
}

function parseRemoteHeadEvidence(value: unknown): RemoteHeadEvidence | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "present") {
    if (!hasExactKeys(value, ["status", "oid"]) || !isValidGitObjectId(value.oid)) return null;
    return { status: "present", oid: value.oid };
  }
  if (value.status === "missing") {
    return hasExactKeys(value, ["status"]) ? { status: "missing" } : null;
  }
  if (value.status === "unavailable") {
    if (!hasExactKeys(value, ["status", "reason"]) || !isNonEmptyString(value.reason)) return null;
    return { status: "unavailable", reason: value.reason };
  }
  return null;
}

export function parseGitIntegrationEvidence(value: unknown): GitIntegrationEvidence | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  const commonValid = isValidRepository(value.repository)
    && isSafeGitRefName(value.baseBranch)
    && isValidGitObjectId(value.verifiedOid);
  const head = parseRemoteHeadEvidence(value.head);
  if (!commonValid || !head) return null;
  if (value.status === "available") {
    if (!hasExactKeys(value, ["status", "repository", "baseBranch", "verifiedOid", "baseOid", "containsVerifiedOid", "head"])) return null;
    if (!isValidGitObjectId(value.baseOid) || typeof value.containsVerifiedOid !== "boolean") return null;
    return {
      status: "available",
      repository: value.repository as string,
      baseBranch: value.baseBranch as string,
      verifiedOid: value.verifiedOid as string,
      baseOid: value.baseOid,
      containsVerifiedOid: value.containsVerifiedOid,
      head,
    };
  }
  if (value.status === "unavailable") {
    if (!hasExactKeys(value, ["status", "repository", "baseBranch", "verifiedOid", "reason", "head"]) || !isNonEmptyString(value.reason)) return null;
    return {
      status: "unavailable",
      repository: value.repository as string,
      baseBranch: value.baseBranch as string,
      verifiedOid: value.verifiedOid as string,
      reason: value.reason,
      head,
    };
  }
  return null;
}

function blocked(code: MergeBlockCode, retryable: boolean, detail: Record<string, unknown>): MergeDecision {
  return { kind: "blocked", code, retryable, detail };
}

export function reconcileMerge(input: {
  expected: MergeIdentity;
  pullRequest: PullRequestEvidence;
  git: GitIntegrationEvidence;
  mutationAttempted: boolean;
}): MergeDecision {
  const expected = parseMergeIdentity(input.expected);
  if (!expected || typeof input.mutationAttempted !== "boolean") {
    return blocked("MERGE_INPUT_INVALID", false, { reason: "invalid expected identity or mutationAttempted flag" });
  }

  const git = parseGitIntegrationEvidence(input.git);
  if (!git) return blocked("MERGE_INPUT_INVALID", false, { reason: "invalid Git integration evidence" });
  if (git.repository !== expected.repository || git.baseBranch !== expected.baseBranch) {
    return blocked("GIT_EVIDENCE_IDENTITY_MISMATCH", false, {
      expected: { repository: expected.repository, baseBranch: expected.baseBranch },
      actual: { repository: git.repository, baseBranch: git.baseBranch },
    });
  }
  if (git.verifiedOid !== expected.verifiedOid) {
    return blocked("GIT_EVIDENCE_OID_MISMATCH", false, { expected: expected.verifiedOid, actual: git.verifiedOid });
  }

  if (!isRecord(input.pullRequest) || (input.pullRequest.status !== "available" && input.pullRequest.status !== "unavailable")) {
    return blocked("MERGE_INPUT_INVALID", false, { reason: "invalid pull request evidence" });
  }

  if (input.pullRequest.status === "unavailable") {
    if (!isNonEmptyString(input.pullRequest.reason)) return blocked("MERGE_INPUT_INVALID", false, { reason: "invalid pull request unavailability reason" });
    if (git.status === "available" && git.containsVerifiedOid) {
      return { kind: "already_integrated", evidence: "git", baseOid: git.baseOid };
    }
    if (input.mutationAttempted) {
      return blocked("PR_MERGE_OUTCOME_UNCONFIRMED", true, {
        pullRequestReason: input.pullRequest.reason,
        gitStatus: git.status,
        containsVerifiedOid: git.status === "available" ? git.containsVerifiedOid : null,
      });
    }
    return blocked("GITHUB_EVIDENCE_UNAVAILABLE", true, {
      pullRequestReason: input.pullRequest.reason,
      gitStatus: git.status,
      containsVerifiedOid: git.status === "available" ? git.containsVerifiedOid : null,
    });
  }

  const snapshot = parsePullRequestSnapshot(input.pullRequest.snapshot);
  if (!snapshot) return blocked("MERGE_INPUT_INVALID", false, { reason: "invalid pull request snapshot" });
  const actual = snapshot.identity;
  if (
    actual.repository !== expected.repository
    || actual.prNumber !== expected.prNumber
    || actual.baseBranch !== expected.baseBranch
    || actual.headBranch !== expected.headBranch
    || actual.isCrossRepository
  ) {
    return blocked("PR_IDENTITY_MISMATCH", false, {
      expected: {
        repository: expected.repository,
        prNumber: expected.prNumber,
        baseBranch: expected.baseBranch,
        headBranch: expected.headBranch,
        isCrossRepository: false,
      },
      actual,
    });
  }
  if (actual.headOid !== expected.verifiedOid) {
    return blocked("PR_HEAD_OID_MISMATCH", false, { expected: expected.verifiedOid, actual: actual.headOid });
  }

  const lifecycle = snapshot.lifecycle.state;
  if (lifecycle === "CLOSED") {
    return blocked(
      git.status === "available" && git.containsVerifiedOid ? "PR_CLOSED_COMMIT_IN_BASE" : "PR_CLOSED_UNMERGED",
      false,
      { gitStatus: git.status, containsVerifiedOid: git.status === "available" ? git.containsVerifiedOid : null },
    );
  }
  if (git.status === "unavailable") {
    return blocked("GIT_INTEGRATION_EVIDENCE_UNAVAILABLE", true, { lifecycle, reason: git.reason });
  }
  if (lifecycle === "MERGED") {
    return git.containsVerifiedOid
      ? { kind: "already_merged", evidence: "github+git", baseOid: git.baseOid }
      : blocked("PR_MERGED_COMMIT_NOT_REACHABLE", true, { baseOid: git.baseOid, verifiedOid: expected.verifiedOid });
  }
  if (git.containsVerifiedOid) {
    return blocked("PR_OPEN_COMMIT_IN_BASE", true, { baseOid: git.baseOid, verifiedOid: expected.verifiedOid });
  }
  if (git.head.status === "present" && git.head.oid !== expected.verifiedOid) {
    return blocked("PR_HEAD_OID_MISMATCH", false, { source: "git_remote_head", expected: expected.verifiedOid, actual: git.head.oid });
  }
  if (git.head.status !== "present") {
    return blocked("PR_MERGE_OUTCOME_UNCONFIRMED", true, { lifecycle, baseOid: git.baseOid, remoteHead: git.head });
  }
  if (input.mutationAttempted) {
    return blocked("PR_MERGE_OUTCOME_UNCONFIRMED", true, { lifecycle, baseOid: git.baseOid, verifiedOid: expected.verifiedOid });
  }
  return { kind: "merge_allowed", evidence: "github+git", preparedBaseOid: git.baseOid };
}

function parseDownstreamProgress(value: unknown): DownstreamBranchProgress | null {
  if (!isRecord(value) || !hasExactKeys(value, ["branch", "preparedLocalOid", "expectedRemoteOid", "state", "resultOid"])) return null;
  if (!isAgentBranch(value.branch)) return null;
  if (!isValidGitObjectId(value.preparedLocalOid) || !isValidGitObjectId(value.expectedRemoteOid)) return null;
  if (value.preparedLocalOid !== value.expectedRemoteOid) return null;
  if (value.state !== "pending" && value.state !== "rebasing" && value.state !== "rebased" && value.state !== "pushed") return null;
  if (value.state === "pending" || value.state === "rebasing" ? value.resultOid !== null : !isValidGitObjectId(value.resultOid)) return null;
  return {
    branch: value.branch,
    preparedLocalOid: value.preparedLocalOid,
    expectedRemoteOid: value.expectedRemoteOid,
    state: value.state,
    resultOid: value.resultOid as string | null,
  };
}

export function parseMergeReceipt(value: unknown): MergeReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "identity", "preparedBaseOid", "mutationAttempted", "remote", "downstream"])) return null;
  if (value.version !== 1 || !isValidGitObjectId(value.preparedBaseOid) || typeof value.mutationAttempted !== "boolean") return null;
  const identity = parseMergeIdentity(value.identity);
  if (!identity || !isRecord(value.remote) || !hasExactKeys(value.remote, ["outcome", "evidence", "baseOid", "confirmedAt"])) return null;
  if (!isRecord(value.downstream) || !hasExactKeys(value.downstream, ["syncBaseOid", "candidates", "progress"])) return null;
  if (value.downstream.syncBaseOid !== null && !isValidGitObjectId(value.downstream.syncBaseOid)) return null;

  const outcome = value.remote.outcome;
  const evidence = value.remote.evidence;
  const completed = outcome === "merged_now" || outcome === "already_merged" || outcome === "already_integrated";
  if (outcome !== "pending" && !completed) return null;
  if (evidence !== "none" && evidence !== "github+git" && evidence !== "git") return null;
  if (completed ? !isValidGitObjectId(value.remote.baseOid) : value.remote.baseOid !== null) return null;
  if (completed ? !(typeof value.remote.confirmedAt === "string" && ISO_TIMESTAMP.test(value.remote.confirmedAt) && !Number.isNaN(Date.parse(value.remote.confirmedAt))) : value.remote.confirmedAt !== null) return null;
  if (outcome === "pending" && evidence !== "none") return null;
  if (outcome === "pending" && value.downstream.syncBaseOid !== null) return null;
  if ((outcome === "merged_now" || outcome === "already_merged") && evidence !== "github+git") return null;
  if (outcome === "already_integrated" && evidence !== "git") return null;
  if (outcome === "merged_now" && !value.mutationAttempted) return null;

  if (!Array.isArray(value.downstream.candidates) || !Array.isArray(value.downstream.progress)) return null;
  const candidates = value.downstream.candidates;
  if (!candidates.every(isSafeGitRefName)) return null;
  if (new Set(candidates).size !== candidates.length || candidates.some(branch => branch === identity.baseBranch || branch === identity.headBranch)) return null;
  if (JSON.stringify(candidates) !== JSON.stringify([...candidates].sort())) return null;
  const progress = value.downstream.progress.map(parseDownstreamProgress);
  if (progress.some(item => item === null) || progress.length !== candidates.length) return null;
  const parsedProgress = progress as DownstreamBranchProgress[];
  if (!parsedProgress.every((item, index) => item.branch === candidates[index])) return null;
  if (!completed && parsedProgress.some(item => item.state !== "pending")) return null;
  if (parsedProgress.some(item => item.state !== "pending") && value.downstream.syncBaseOid === null) return null;

  return {
    version: 1,
    identity,
    preparedBaseOid: value.preparedBaseOid,
    mutationAttempted: value.mutationAttempted,
    remote: {
      outcome,
      evidence,
      baseOid: value.remote.baseOid as string | null,
      confirmedAt: value.remote.confirmedAt as string | null,
    },
    downstream: {
      syncBaseOid: value.downstream.syncBaseOid as string | null,
      candidates: [...candidates],
      progress: parsedProgress,
    },
  };
}
