import {
  acquireMergeLock,
  approvalMatchesPlan,
  assertPhase,
  projectRoot,
  readState,
  transition,
  writeState,
  type WorkflowState,
} from "../state.js";
import {
  abortRebase,
  checkout,
  checkoutDetached,
  executePrMerge,
  fetchRemoteBaseEvidence,
  inspectPullRequestForMerge,
  isAncestorCommit,
  isWorktreeClean,
  listLocalBranches,
  pull,
  pushForceWithLease,
  rebaseOnto,
  resolveMergeIdentity,
  resolveRefOid,
  resolveRemoteBranchOid,
  updateBranchRefCas,
} from "../git.js";
import {
  isAgentBranch,
  reconcileMerge,
  type DownstreamBranchProgress,
  type MergeDecision,
  type MergeIdentity,
  type MergeReceipt,
} from "../merge-recovery.js";
import { invalidWorkflowStateResult, toolResult as buildToolResult, type ToolResult } from "./_base.js";
import type { ToolResultFields } from "../output/envelope.js";

type Executor = unknown;
type MergeStage = "merge.reconcile" | "merge.sync";

type DownstreamSnapshot =
  | { ok: true; progress: DownstreamBranchProgress[]; skipped: string[]; executor?: Executor }
  | { ok: false; error: unknown; branch: string; skipped: string[]; executor?: Executor };


function machineErrorFacts(error: unknown): unknown {
  if (!error || typeof error !== "object" || Array.isArray(error)) return error;
  const input = error as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(input, "hint")) return error;
  const output = { ...input };
  delete output.hint;
  if (typeof input.message === "string") output.message = input.message;
  return output;
}

function mergeResult(next: Parameters<typeof buildToolResult>[0], fields: ToolResultFields): ToolResult {
  return buildToolResult(next, {
    ...fields,
    ...(fields.error === undefined ? {} : { error: machineErrorFacts(fields.error) }),
  });
}
function sameIdentity(left: MergeIdentity, right: MergeIdentity): boolean {
  return left.repository === right.repository
    && left.prNumber === right.prNumber
    && left.baseBranch === right.baseBranch
    && left.headBranch === right.headBranch
    && left.verifiedOid === right.verifiedOid;
}

function immutableDetail(identity: MergeIdentity): Record<string, unknown> {
  const immutable = {
    repository: identity.repository,
    prNumber: identity.prNumber,
    baseBranch: identity.baseBranch,
    headBranch: identity.headBranch,
    verifiedOid: identity.verifiedOid,
  };
  return { ...immutable, identity: immutable };
}

function causeText(cause: unknown): string | undefined {
  if (cause === undefined || cause === null || cause === "") return undefined;
  if (typeof cause === "string") return cause;
  try { return JSON.stringify(cause); }
  catch { return String(cause); }
}

function mergeError(
  code: string,
  message: string,
  identity: MergeIdentity,
  retryable: boolean,
  detail: Record<string, unknown> = {},
  cause?: unknown,
): Record<string, unknown> {
  return {
    type: retryable ? "io" : "workflow_state",
    subtype: code === "MERGE_LOCK_BUSY" ? "lock_busy" : retryable ? "io_failure" : "invalid_phase",
    code,
    message,
    detail: { ...immutableDetail(identity), ...detail },
    ...(causeText(cause) ? { cause: causeText(cause) } : {}),
    retryable,
  };
}

function receiptStageForError(code: string): "merge.reconcile" | "merge.sync" {
  return code === "POST_MERGE_SYNC_INCOMPLETE" || code === "LOCAL_BRANCH_CAS_FAILED" || code === "GIT_FORCE_WITH_LEASE_FAILED"
    ? "merge.sync"
    : "merge.reconcile";
}

function mergeStageForState(state: WorkflowState): MergeStage {
  if (state.stage === "merge.sync") return "merge.sync";
  return state.mergeReceipt && state.mergeReceipt.remote.outcome !== "pending"
    ? "merge.sync"
    : "merge.reconcile";
}

function stopFailure(
  identity: MergeIdentity,
  code: string,
  message: string,
  retryable: boolean,
  detail: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
  cause?: unknown,
  stageOverride?: MergeStage,
): ToolResult {
  const tool = retryable ? "hy_merge" : "hy_reset";
  const stage = stageOverride ?? receiptStageForError(code);
  return mergeResult("merge", {
    error: mergeError(code, message, identity, retryable, detail, cause),
    data,
    requires_user: true,
    stop_here: true,
    stage,
    status: retryable ? "pending" : "blocked",
    recovery: retryable
      ? { strategy: "wait_and_retry", tool: "hy_merge" }
      : { strategy: "reset", tool: "hy_reset" },
    allowedTools: retryable ? ["hy_merge", "hy_status"] : ["hy_reset", "hy_status"],
    nextAction: { tool, phase: "merge", stage, automatic: false },
    control: { automatic: false, stop: true, reason: retryable ? "wait_required" : "review_required" },
    userAction: retryable
      ? { kind: "wait" }
      : { kind: "review_failure" },
  });
}

function decisionStop(
  identity: MergeIdentity,
  decision: Extract<MergeDecision, { kind: "blocked" }>,
  executor?: Executor,
  extra: Record<string, unknown> = {},
): ToolResult {
  const code = decision.code === "GITHUB_EVIDENCE_UNAVAILABLE" || decision.code === "GIT_INTEGRATION_EVIDENCE_UNAVAILABLE"
    ? "PR_MERGE_OUTCOME_UNCONFIRMED"
    : decision.code;
  const message = code === "PR_MERGE_OUTCOME_UNCONFIRMED"
    ? "The pull request merge outcome could not be confirmed."
    : "Merge reconciliation failed closed.";
  return stopFailure(
    identity,
    code,
    message,
    decision.retryable,
    { decision: decision.code, ...decision.detail, ...extra },
    { decision: decision.code, executor, ...extra },
  );
}

function progressData(receipt: MergeReceipt): { completed: string[]; remaining: string[] } {
  return {
    completed: receipt.downstream.progress.filter(item => item.state === "pushed").map(item => item.branch),
    remaining: receipt.downstream.progress.filter(item => item.state !== "pushed").map(item => item.branch),
  };
}

function persistReceipt(state: WorkflowState, receipt: MergeReceipt): void {
  state.mergeReceipt = receipt;
  state.stage = receipt.remote.outcome === "pending" ? "merge.reconcile" : "merge.sync";
  writeState(state);
}

function preparedReceipt(identity: MergeIdentity, preparedBaseOid: string, progress: DownstreamBranchProgress[]): MergeReceipt {
  const ordered = [...progress].sort((left, right) => left.branch < right.branch ? -1 : left.branch > right.branch ? 1 : 0);
  return {
    version: 1,
    identity,
    preparedBaseOid,
    mutationAttempted: false,
    remote: { outcome: "pending", evidence: "none", baseOid: null, confirmedAt: null },
    downstream: { syncBaseOid: null, candidates: ordered.map(item => item.branch), progress: ordered },
  };
}

function confirmReceipt(
  receipt: MergeReceipt,
  decision: Extract<MergeDecision, { kind: "already_merged" | "already_integrated" }>,
  mutationExecuted: boolean,
): MergeReceipt {
  const outcome = decision.kind === "already_integrated"
    ? "already_integrated"
    : mutationExecuted ? "merged_now" : "already_merged";
  return {
    ...receipt,
    remote: { outcome, evidence: decision.evidence, baseOid: decision.baseOid, confirmedAt: new Date().toISOString() },
  };
}

function snapshotDownstream(
  root: string,
  identity: MergeIdentity,
  preparedBaseOid: string,
  requirePreparedBase: boolean,
): DownstreamSnapshot {
  const listed = listLocalBranches(root);
  if (!listed.ok) return { ok: false, error: listed.error, branch: "", skipped: [], executor: listed.executor };
  const branches = listed.branches
    .filter(branch => branch !== identity.baseBranch && branch !== identity.headBranch && isAgentBranch(branch))
    .sort();
  const progress: DownstreamBranchProgress[] = [];
  const skipped: string[] = [];
  for (const branch of branches) {
    const local = resolveRefOid(root, `refs/heads/${branch}`);
    if (!local.ok) return { ok: false, error: local.error, branch, skipped, executor: local.executor };
    const verifiedLineage = isAncestorCommit(root, identity.verifiedOid, local.oid);
    if (!verifiedLineage.ok) return { ok: false, error: verifiedLineage.error, branch, skipped, executor: verifiedLineage.executor };
    if (!verifiedLineage.value) {
      skipped.push(branch);
      continue;
    }
    if (requirePreparedBase) {
      const baseLineage = isAncestorCommit(root, preparedBaseOid, local.oid);
      if (!baseLineage.ok) return { ok: false, error: baseLineage.error, branch, skipped, executor: baseLineage.executor };
      if (!baseLineage.value) {
        return {
          ok: false,
          error: { preparedBaseOid, candidateOid: local.oid, reason: "verified downstream branch is not based on the current prepared base" },
          branch,
          skipped,
          executor: baseLineage.executor,
        };
      }
    }
    const remote = resolveRemoteBranchOid(root, branch);
    if (!remote.ok) {
      if (remote.missing) {
        skipped.push(branch);
        continue;
      }
      return { ok: false, error: remote.error, branch, skipped, executor: remote.executor };
    }
    if (local.oid !== remote.oid) {
      return {
        ok: false,
        error: { expectedLocalOid: local.oid, actualRemoteOid: remote.oid, reason: "local and remote downstream refs diverged" },
        branch,
        skipped,
        executor: remote.executor,
      };
    }
    progress.push({ branch, preparedLocalOid: local.oid, expectedRemoteOid: remote.oid, state: "pending", resultOid: null });
  }
  return { ok: true, progress, skipped, executor: listed.executor };
}

function restoreBase(root: string, baseBranch: string): { abortOk: boolean; restoreBaseOk: boolean } {
  const abort = abortRebase(root);
  const restore = checkout(root, baseBranch);
  return { abortOk: abort.ok, restoreBaseOk: restore.ok };
}

function syncFailure(
  root: string,
  state: WorkflowState,
  receipt: MergeReceipt,
  operation: string,
  branch: string,
  cause: unknown,
  executor?: Executor,
  retryable = true,
  detail: Record<string, unknown> = {},
): ToolResult {
  const restored = restoreBase(root, receipt.identity.baseBranch);
  const progress = progressData(receipt);
  persistReceipt(state, receipt);
  return stopFailure(
    receipt.identity,
    "POST_MERGE_SYNC_INCOMPLETE",
    `Remote integration is confirmed, but ${operation} failed${branch ? ` for ${branch}` : ""}.`,
    retryable,
    { operation, branch, ...progress, ...restored, ...detail },
    { outcome: receipt.remote.outcome, evidence: receipt.remote.evidence, baseOid: receipt.remote.baseOid, ...progress, executor },
    cause,
  );
}

function ensureCleanForSync(root: string, state: WorkflowState, receipt: MergeReceipt): ToolResult | null {
  let clean = isWorktreeClean(root);
  if (clean.ok && clean.value) return null;
  restoreBase(root, receipt.identity.baseBranch);
  clean = isWorktreeClean(root);
  if (clean.ok && clean.value) return null;
  return syncFailure(
    root,
    state,
    receipt,
    "worktree cleanup",
    receipt.identity.baseBranch,
    clean.ok ? "worktree has uncommitted changes" : clean.error,
    clean.executor,
  );
}

type PinResult = { ok: true; oid: string; executor?: Executor } | { ok: false; result: ToolResult };

function baseAncestryFailure(
  root: string,
  state: WorkflowState,
  receipt: MergeReceipt,
  cause: unknown,
  executor?: Executor,
  detail: Record<string, unknown> = {},
): PinResult {
  return {
    ok: false,
    result: syncFailure(root, state, receipt, "sync base ancestry", receipt.identity.baseBranch, cause, executor, true, detail),
  };
}

function refreshSyncBaseEvidence(root: string, state: WorkflowState, receipt: MergeReceipt): PinResult {
  const fresh = fetchRemoteBaseEvidence(root, receipt.identity);
  if (fresh.evidence.status !== "available") {
    return baseAncestryFailure(root, state, receipt, fresh.evidence.reason, fresh.executor, { gitStatus: fresh.evidence.status });
  }
  if (!fresh.evidence.containsVerifiedOid) {
    return baseAncestryFailure(root, state, receipt, "the fresh remote base does not contain the verified commit", fresh.executor, {
      remoteBaseOid: fresh.evidence.baseOid,
      verifiedOid: receipt.identity.verifiedOid,
    });
  }
  if (!receipt.remote.baseOid) return baseAncestryFailure(root, state, receipt, "the confirmed receipt has no remote base OID", fresh.executor);
  const confirmed = isAncestorCommit(root, receipt.remote.baseOid, fresh.evidence.baseOid);
  if (!confirmed.ok || !confirmed.value) {
    return baseAncestryFailure(root, state, receipt, confirmed.ok ? "the fresh remote base does not contain the confirmed base" : confirmed.error, confirmed.executor, {
      confirmedBaseOid: receipt.remote.baseOid,
      remoteBaseOid: fresh.evidence.baseOid,
    });
  }
  const pin = receipt.downstream.syncBaseOid;
  if (pin !== null && fresh.evidence.baseOid !== pin) {
    return baseAncestryFailure(root, state, receipt, "the remote base moved after synchronization was pinned", fresh.executor, {
      syncBaseOid: pin,
      remoteBaseOid: fresh.evidence.baseOid,
    });
  }
  return { ok: true, oid: fresh.evidence.baseOid, executor: fresh.executor };
}

function validatePinnedBase(root: string, state: WorkflowState, receipt: MergeReceipt): PinResult {
  const pin = receipt.downstream.syncBaseOid;
  if (!pin || !receipt.remote.baseOid) return baseAncestryFailure(root, state, receipt, "the confirmed receipt has no pinned base OID");
  const local = resolveRefOid(root, `refs/heads/${receipt.identity.baseBranch}`);
  if (!local.ok) return baseAncestryFailure(root, state, receipt, local.error, local.executor);
  const remote = resolveRemoteBranchOid(root, receipt.identity.baseBranch);
  if (!remote.ok) return baseAncestryFailure(root, state, receipt, remote.error, remote.executor);
  if (local.oid !== pin || remote.oid !== pin) {
    return baseAncestryFailure(root, state, receipt, "the base ref moved after synchronization was pinned", remote.executor, {
      syncBaseOid: pin,
      localBaseOid: local.oid,
      remoteBaseOid: remote.oid,
    });
  }
  const verified = isAncestorCommit(root, receipt.identity.verifiedOid, pin);
  if (!verified.ok || !verified.value) {
    return baseAncestryFailure(root, state, receipt, verified.ok ? "the pinned base no longer contains the verified commit" : verified.error, verified.executor, { syncBaseOid: pin });
  }
  const confirmed = isAncestorCommit(root, receipt.remote.baseOid, pin);
  if (!confirmed.ok || !confirmed.value) {
    return baseAncestryFailure(root, state, receipt, confirmed.ok ? "the pinned base no longer contains the confirmed base" : confirmed.error, confirmed.executor, { syncBaseOid: pin, confirmedBaseOid: receipt.remote.baseOid });
  }
  return { ok: true, oid: pin, executor: remote.executor };
}

function pinSyncBase(root: string, state: WorkflowState, receipt: MergeReceipt): PinResult {
  const base = receipt.identity.baseBranch;
  const checkedOut = checkout(root, base);
  if (!checkedOut.ok) return { ok: false, result: syncFailure(root, state, receipt, "checkout", base, checkedOut.error, checkedOut.executor) };
  const pulled = pull(root);
  if (!pulled.ok) return { ok: false, result: syncFailure(root, state, receipt, "pull", base, pulled.error, pulled.executor) };
  const local = resolveRefOid(root, `refs/heads/${base}`);
  if (!local.ok) return baseAncestryFailure(root, state, receipt, local.error, local.executor);
  const remote = resolveRemoteBranchOid(root, base);
  if (!remote.ok) return baseAncestryFailure(root, state, receipt, remote.error, remote.executor);
  if (receipt.downstream.syncBaseOid === null) {
    if (local.oid !== remote.oid) {
      return baseAncestryFailure(root, state, receipt, "local and remote base refs do not identify one pinned commit", remote.executor, { localBaseOid: local.oid, remoteBaseOid: remote.oid });
    }
    receipt.downstream.syncBaseOid = local.oid;
    persistReceipt(state, receipt);
  }
  return validatePinnedBase(root, state, receipt);
}

function validatePreparedProgress(root: string, state: WorkflowState, receipt: MergeReceipt, item: DownstreamBranchProgress): ToolResult | null {
  const local = resolveRefOid(root, `refs/heads/${item.branch}`);
  if (!local.ok || local.oid !== item.preparedLocalOid) {
    return syncFailure(root, state, receipt, "local OID precondition", item.branch, local.ok ? { expected: item.preparedLocalOid, actual: local.oid } : local.error, local.executor, false);
  }
  const remote = resolveRemoteBranchOid(root, item.branch);
  if (!remote.ok || remote.oid !== item.expectedRemoteOid) {
    return syncFailure(root, state, receipt, "remote lease precondition", item.branch, remote.ok ? { expected: item.expectedRemoteOid, actual: remote.oid } : remote.error, remote.executor, false);
  }
  const verified = isAncestorCommit(root, receipt.identity.verifiedOid, local.oid);
  if (!verified.ok || !verified.value) {
    return syncFailure(root, state, receipt, "downstream verified ancestry", item.branch, verified.ok ? "verified commit is not an ancestor" : verified.error, verified.executor, false);
  }
  return null;
}

function syncRebasingItem(root: string, state: WorkflowState, receipt: MergeReceipt, item: DownstreamBranchProgress, pin: string): ToolResult | null {
  const prepared = validatePreparedProgress(root, state, receipt, item);
  if (prepared) return prepared;
  abortRebase(root);
  const detached = checkoutDetached(root, item.preparedLocalOid);
  if (!detached.ok) return syncFailure(root, state, receipt, "detached staging checkout", item.branch, detached.error, detached.executor);
  const rebased = rebaseOnto(root, pin);
  if (!rebased.ok) return syncFailure(root, state, receipt, "detached staging rebase", item.branch, rebased.error, rebased.executor);
  const result = resolveRefOid(root, "HEAD");
  if (!result.ok) return syncFailure(root, state, receipt, "resolve staged rebase OID", item.branch, result.error, result.executor);
  const basedOnPin = isAncestorCommit(root, pin, result.oid);
  if (!basedOnPin.ok || !basedOnPin.value) {
    return syncFailure(root, state, receipt, "staged rebase ancestry", item.branch, basedOnPin.ok ? "staged result does not contain the pinned base" : basedOnPin.error, basedOnPin.executor, false);
  }
  item.state = "rebased";
  item.resultOid = result.oid;
  persistReceipt(state, receipt);
  return null;
}

function installAndPushItem(root: string, state: WorkflowState, receipt: MergeReceipt, item: DownstreamBranchProgress): ToolResult | null {
  const resultOid = item.resultOid;
  if (!resultOid) return syncFailure(root, state, receipt, "receipt validation", item.branch, "rebased progress is missing resultOid", undefined, false);
  const local = resolveRefOid(root, `refs/heads/${item.branch}`);
  if (!local.ok) return syncFailure(root, state, receipt, "compare-and-swap precondition", item.branch, local.error, local.executor, false);
  if (local.oid === item.preparedLocalOid) {
    const installed = updateBranchRefCas(root, item.branch, resultOid, item.preparedLocalOid);
    if (!installed.ok) return syncFailure(root, state, receipt, "compare-and-swap", item.branch, installed.error, installed.executor, false);
  } else if (local.oid !== resultOid) {
    return syncFailure(root, state, receipt, "compare-and-swap precondition", item.branch, { expectedOldOid: item.preparedLocalOid, expectedResultOid: resultOid, actual: local.oid }, local.executor, false);
  }

  const pinned = validatePinnedBase(root, state, receipt);
  if (!pinned.ok) return pinned.result;
  const remote = resolveRemoteBranchOid(root, item.branch);
  if (remote.ok && remote.oid === resultOid) {
    item.state = "pushed";
    persistReceipt(state, receipt);
    return null;
  }
  if (!remote.ok || remote.oid !== item.expectedRemoteOid) {
    return syncFailure(root, state, receipt, "remote lease precondition", item.branch, remote.ok ? { expected: item.expectedRemoteOid, actual: remote.oid } : remote.error, remote.executor, false);
  }
  const pushed = pushForceWithLease(root, item.branch, item.expectedRemoteOid, resultOid);
  if (!pushed.ok) return syncFailure(root, state, receipt, "push with lease", item.branch, pushed.error, pushed.executor);
  item.state = "pushed";
  persistReceipt(state, receipt);
  return null;
}

function finalizeLocalSync(root: string, state: WorkflowState, receipt: MergeReceipt, skipped: string[], executor?: Executor): ToolResult {
  const freshBase = refreshSyncBaseEvidence(root, state, receipt);
  if (!freshBase.ok) return freshBase.result;
  executor = freshBase.executor ?? executor;
  const dirty = ensureCleanForSync(root, state, receipt);
  if (dirty) return dirty;
  const pinned = pinSyncBase(root, state, receipt);
  if (!pinned.ok) return pinned.result;

  for (const item of receipt.downstream.progress) {
    if (item.state === "pushed") continue;
    const stableBase = validatePinnedBase(root, state, receipt);
    if (!stableBase.ok) return stableBase.result;
    if (item.state === "pending") {
      const prepared = validatePreparedProgress(root, state, receipt, item);
      if (prepared) return prepared;
      item.state = "rebasing";
      persistReceipt(state, receipt);
    }
    if (item.state === "rebasing") {
      const staged = syncRebasingItem(root, state, receipt, item, stableBase.oid);
      if (staged) return staged;
    }
    const pushed = installAndPushItem(root, state, receipt, item);
    if (pushed) return pushed;
  }

  const finalBase = validatePinnedBase(root, state, receipt);
  if (!finalBase.ok) return finalBase.result;
  const restored = checkout(root, receipt.identity.baseBranch);
  if (!restored.ok) return syncFailure(root, state, receipt, "final checkout", receipt.identity.baseBranch, restored.error, restored.executor);
  const progress = progressData(receipt);
  const next = transition(state, "done");
  next.stage = "done.completed";
  next.mergeReceipt = receipt;
  writeState(next);
  return mergeResult("done", {
    stage: "done.completed",
    status: "completed",
    prNumber: receipt.identity.prNumber,
    done: progress.completed.map(branch => `${branch}: rebased + pushed`),
    data: {
      outcome: receipt.remote.outcome,
      evidence: receipt.remote.evidence,
      baseOid: receipt.remote.baseOid,
      syncBaseOid: receipt.downstream.syncBaseOid,
      ...progress,
      skipped,
      executor: executor ?? pinned.executor,
    },
    allowedTools: ["hy_reset", "hy_status"],
    nextAction: { tool: "hy_reset", phase: "done", stage: "done.completed", automatic: true },
    control: { automatic: true, stop: false, reason: "completed" },
    userAction: null,
  });
}

function snapshotFailure(
  identity: MergeIdentity,
  snapshot: Extract<DownstreamSnapshot, { ok: false }>,
  integration: boolean,
  executor?: Executor,
  decision?: Exclude<MergeDecision, { kind: "blocked" | "merge_allowed" }>,
): ToolResult {
  const code = integration ? "POST_MERGE_SYNC_INCOMPLETE" : "DOWNSTREAM_SNAPSHOT_FAILED";
  const message = integration
    ? "Remote integration is confirmed, but the downstream snapshot is unsafe."
    : "A safe downstream snapshot could not be prepared before the merge mutation.";
  return stopFailure(
    identity,
    code,
    message,
    true,
    { operation: "downstream snapshot", branch: snapshot.branch, skipped: snapshot.skipped },
    {
      ...(decision ? { outcome: decision.kind, evidence: decision.evidence, baseOid: decision.baseOid } : {}),
      executor: snapshot.executor ?? executor,
    },
    snapshot.error,
  );
}

function handleMergeLocked(root: string, state: WorkflowState, identity: MergeIdentity, executor?: Executor): ToolResult {
  let receipt = state.mergeReceipt ?? null;
  if (receipt && !sameIdentity(receipt.identity, identity)) {
    return stopFailure(
      identity,
      "PR_IDENTITY_MISMATCH",
      "The persisted merge receipt does not match the active verified pull request identity.",
      false,
      { receiptIdentity: receipt.identity },
      { executor },
      undefined,
      mergeStageForState(state),
    );
  }
  if (receipt && receipt.remote.outcome !== "pending") return finalizeLocalSync(root, state, receipt, [], executor);

  const gitBefore = fetchRemoteBaseEvidence(root, identity);
  const prBefore = inspectPullRequestForMerge(root, identity);
  let activeExecutor = prBefore.executor ?? gitBefore.executor ?? executor;
  let decision = reconcileMerge({
    expected: identity,
    pullRequest: prBefore.evidence,
    git: gitBefore.evidence,
    mutationAttempted: receipt?.mutationAttempted ?? false,
  });
  if (decision.kind === "blocked") return decisionStop(identity, decision, activeExecutor);

  let skipped: string[] = [];
  if (!receipt && decision.kind !== "merge_allowed") {
    const snapshot = snapshotDownstream(root, identity, decision.baseOid, false);
    if (!snapshot.ok) return snapshotFailure(identity, snapshot, true, activeExecutor, decision);
    skipped = snapshot.skipped;
    receipt = confirmReceipt(preparedReceipt(identity, decision.baseOid, snapshot.progress), decision, false);
    persistReceipt(state, receipt);
    return finalizeLocalSync(root, state, receipt, skipped, snapshot.executor ?? activeExecutor);
  }

  if (decision.kind !== "merge_allowed") {
    if (!receipt) throw new Error("merge receipt is missing after remote integration reconciliation");
    receipt = confirmReceipt(receipt, decision, false);
    persistReceipt(state, receipt);
    return finalizeLocalSync(root, state, receipt, skipped, activeExecutor);
  }

  const currentSnapshot = snapshotDownstream(root, identity, decision.preparedBaseOid, true);
  if (!currentSnapshot.ok) return snapshotFailure(identity, currentSnapshot, false, activeExecutor);
  skipped = currentSnapshot.skipped;
  const currentReceipt = preparedReceipt(identity, decision.preparedBaseOid, currentSnapshot.progress);
  if (!receipt
    || receipt.preparedBaseOid !== currentReceipt.preparedBaseOid
    || JSON.stringify(receipt.downstream.progress) !== JSON.stringify(currentReceipt.downstream.progress)) {
    receipt = currentReceipt;
    persistReceipt(state, receipt);
  }
  const clean = isWorktreeClean(root);
  if (!clean.ok || !clean.value) {
    return stopFailure(
      identity,
      "MERGE_WORKTREE_NOT_CLEAN",
      "The worktree must be clean before the pull request merge mutation.",
      true,
      {},
      { executor: clean.executor ?? activeExecutor },
      clean.ok ? "worktree has uncommitted changes" : clean.error,
    );
  }

  receipt.mutationAttempted = true;
  persistReceipt(state, receipt);
  let mutationError: unknown;
  try {
    const mutation = executePrMerge(root, identity);
    activeExecutor = mutation.executor ?? activeExecutor;
    if (!mutation.ok) mutationError = mutation.error;
  } catch (caught) {
    mutationError = caught;
  }

  const gitAfter = fetchRemoteBaseEvidence(root, identity);
  const prAfter = inspectPullRequestForMerge(root, identity);
  activeExecutor = prAfter.executor ?? gitAfter.executor ?? activeExecutor;
  decision = reconcileMerge({ expected: identity, pullRequest: prAfter.evidence, git: gitAfter.evidence, mutationAttempted: true });
  if (decision.kind === "blocked") return decisionStop(identity, decision, activeExecutor, { mutationError: causeText(mutationError) });
  if (decision.kind === "merge_allowed") {
    return decisionStop(identity, {
      kind: "blocked",
      code: "PR_MERGE_OUTCOME_UNCONFIRMED",
      retryable: true,
      detail: { reason: "the pull request remained open after the recorded mutation" },
    }, activeExecutor, { mutationError: causeText(mutationError) });
  }
  receipt = confirmReceipt(receipt, decision, true);
  persistReceipt(state, receipt);
  return finalizeLocalSync(root, state, receipt, skipped, activeExecutor);
}

export async function handleMerge(): Promise<ToolResult> {
  const initial = readState();
  assertPhase(initial, "merge");
  const initialStage = mergeStageForState(initial);
  if (!initial.plan) {
    return invalidWorkflowStateResult(
      initial,
      "MERGE_PLAN_MISSING",
      "Workflow state does not contain the PlanDoc required to merge.",
    );
  }
  if (!approvalMatchesPlan(initial.approval, initial.plan)) {
    return invalidWorkflowStateResult(
      initial,
      "APPROVAL_PLAN_MISMATCH",
      "The persisted approval does not match the current PlanDoc.",
    );
  }
  if (!initial.prNumber) {
    return invalidWorkflowStateResult(
      initial,
      "MERGE_PR_MISSING",
      "Workflow state reached merge without an active pull request.",
    );
  }
  const root = projectRoot();
  const resolved = resolveMergeIdentity(root, initial.prNumber);
  if (!resolved.ok) {
    return mergeResult("merge", {
      stage: initialStage,
      error: resolved.error,
      data: { executor: resolved.executor },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_reset", "hy_status"],
    });
  }
  const lock = acquireMergeLock();
  if (!lock.ok) {
    const owner = lock.owner ? { pid: lock.owner.pid, host: lock.owner.host, createdAt: lock.owner.createdAt } : null;
    return stopFailure(
      resolved.identity,
      "MERGE_LOCK_BUSY",
      "Another hy_merge process owns this project's merge lock.",
      true,
      { owner, lockPath: lock.path },
      { executor: resolved.executor },
      lock.cause,
      initialStage,
    );
  }
  try {
    const state = readState();
    assertPhase(state, "merge");
    if (!state.plan || !approvalMatchesPlan(state.approval, state.plan)) {
      return invalidWorkflowStateResult(
        state,
        "APPROVAL_PLAN_MISMATCH",
        "The approval or PlanDoc changed while acquiring the project merge lock.",
      );
    }
    if (!state.prNumber) {
      return invalidWorkflowStateResult(
        state,
        "MERGE_PR_MISSING",
        "The active pull request disappeared from workflow state while acquiring the merge lock.",
      );
    }
    state.stage = state.mergeReceipt && state.mergeReceipt.remote.outcome !== "pending"
      ? "merge.sync"
      : "merge.reconcile";
    writeState(state);
    const lockedIdentity = resolveMergeIdentity(root, state.prNumber);
    if (!lockedIdentity.ok) {
      return mergeResult("merge", {
        stage: mergeStageForState(state),
        error: lockedIdentity.error,
        data: { executor: lockedIdentity.executor ?? resolved.executor },
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_reset", "hy_status"],
      });
    }
    if (!sameIdentity(resolved.identity, lockedIdentity.identity)) {
      return stopFailure(
        resolved.identity,
        "PR_IDENTITY_MISMATCH",
        "The immutable merge identity changed while acquiring the project lock.",
        false,
        { lockedIdentity: lockedIdentity.identity },
        { executor: lockedIdentity.executor ?? resolved.executor },
        undefined,
        mergeStageForState(state),
      );
    }
    return handleMergeLocked(root, state, lockedIdentity.identity, lockedIdentity.executor ?? resolved.executor);
  } finally {
    try { lock.release(); } catch {}
  }
}
