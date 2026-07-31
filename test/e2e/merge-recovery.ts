import { chdir, cwd } from "node:process";
import { handleMerge } from "../../src/tools/merge.js";
import { acquireMergeLock, readState, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";
import type { MergeReceipt } from "../../src/merge-recovery.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import {
  createGitGhHarness,
  type GitGhHarness,
  type GitFaultOperation,
} from "../helpers/git-gh-harness.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function planFor(harness: GitGhHarness): PlanDoc {
  return {
    task: "recover one exact pull request merge after an unknown remote outcome",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "verified source commit -> pull request -> configured base branch -> downstream branch synchronization",
      entry_points: ["npx tsc --noEmit", "npm run test:e2e"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "N/A", setup: [] },
      smoke: [{ command: "npx tsc --noEmit", expected_exit: 0, description: "compile" }],
      tests: [{ command: "npm run test:e2e", expected_exit: 0, description: "merge recovery" }],
    },
    risks: [
      "Scenario: the remote merge succeeds before the client times out or local checkout fails; impact: a retry may misclassify MERGED as identity drift or repeat side effects; mitigation: reconcile exact PR identity and fresh remote Git ancestry.",
    ],
    discussion: "Recover the exact verified commit through read-only Git evidence. Pushing directly to the base branch was rejected because it would bypass pull request policy.",
    branch: harness.sourceBranch,
    verify_hash: null,
    pr_number: harness.prNumber,
  };
}

function seedMergeState(harness: GitGhHarness): void {
  const implementationDigest = `merge-recovery-${harness.verifiedOid}`;
  const state: WorkflowState = {
    version: "1",
    phase: "merge",
    branch: harness.sourceBranch,
    prNumber: harness.prNumber,
    plan: planFor(harness),
    approval: {
      time: new Date().toISOString(),
      note: "approved",
      commitRecovery: {
        version: 1,
        commitOid: harness.verifiedOid,
        implementationDigest,
        branch: harness.sourceBranch,
        baseBranch: harness.baseBranch,
        repository: harness.repository,
      },
    } as WorkflowState["approval"],
    verifiedImplementationDigest: implementationDigest,
  };
  writeState(state);
}

function seedPendingReceipt(harness: GitGhHarness, mutationAttempted: boolean): void {
  const state = readState();
  const candidates = [...harness.downstreamBranches].sort();
  const receipt: MergeReceipt = {
    version: 1,
    identity: {
      repository: harness.repository,
      prNumber: harness.prNumber,
      baseBranch: harness.baseBranch,
      headBranch: harness.sourceBranch,
      verifiedOid: harness.verifiedOid,
    },
    preparedBaseOid: harness.baseOid,
    mutationAttempted,
    remote: { outcome: "pending", evidence: "none", baseOid: null, confirmedAt: null },
    downstream: {
      syncBaseOid: null,
      candidates,
      progress: candidates.map(branch => {
        const oid = harness.remoteOid(branch);
        assert(oid, `attempted receipt fixture is missing remote branch ${branch}`);
        return { branch, preparedLocalOid: oid, expectedRemoteOid: oid, state: "pending", resultOid: null };
      }),
    },
  };
  state.mergeReceipt = receipt;
  writeState(state);
}

function seedAttemptedReceipt(harness: GitGhHarness): void {
  seedPendingReceipt(harness, true);
}

function assertMergeStopped(result: any, label: string): void {
  assert(result.ok === false, `${label} should stop: ${JSON.stringify(result)}`);
  assert(result.phase === "merge" && result.next === "merge", `${label} should preserve merge phase: ${JSON.stringify(result)}`);
  assert(readState().phase === "merge", `${label} should not persist a terminal state`);
}

function assertMergeDone(result: any, label: string): void {
  assert(result.ok === true && result.next === "done", `${label} should complete: ${JSON.stringify(result)}`);
  assert(readState().phase === "done", `${label} should persist done phase`);
}

async function withHarness(name: string, run: (harness: GitGhHarness) => Promise<void>): Promise<void> {
  const originalCwd = cwd();
  const harness = createGitGhHarness(name);
  try {
    chdir(harness.root);
    seedMergeState(harness);
    await run(harness);
  } finally {
    chdir(originalCwd);
    harness.cleanup();
  }
}

function mergeCalls(harness: GitGhHarness): string[] {
  return harness.ghCalls("pr merge ");
}

function branchPushes(harness: GitGhHarness, branch: string): string[] {
  return harness.gitCalls("push ").filter(call => call.includes(branch));
}

function basePushes(harness: GitGhHarness): string[] {
  return harness.gitCalls("push ").filter(call => {
    const tokens = call.split(/\s+/);
    return tokens.some(token => token === harness.baseBranch || token.endsWith(`refs/heads/${harness.baseBranch}`));
  });
}

function assertAllowedTools(result: any, expected: string[], label: string): void {
  assert(
    JSON.stringify(result.allowedTools) === JSON.stringify(expected),
    `${label} must expose exactly ${JSON.stringify(expected)}: ${JSON.stringify(result.allowedTools)}`,
  );
}

await withHarness("merge-lock-busy", async harness => {
  const lock = acquireMergeLock();
  assert(lock.ok, `merge-lock fixture must acquire the first lock: ${JSON.stringify(lock)}`);
  try {
    const result = await handleMerge();
    assertMergeStopped(result, "concurrent merge lock");
    assert(result.error?.code === "MERGE_LOCK_BUSY" && result.error?.retryable === true, `a held merge lock must fail closed as retryable: ${JSON.stringify(result)}`);
    assertAllowedTools(result, ["hy_merge", "hy_status"], "concurrent merge lock");
    assert(mergeCalls(harness).length === 0, "a held merge lock must stop before a PR merge mutation");
    assert(harness.gitCalls("push ").length === 0, "a held merge lock must stop before any Git push");
  } finally {
    lock.release();
  }
});

await withHarness("merge-state-retry", async harness => {
  harness.failGitOnce("checkout", harness.baseBranch);
  const first = await handleMerge();
  assertMergeStopped(first, "post-merge base checkout failure");
  assert(first.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `post-merge checkout failure must be distinguished from an unknown remote outcome: ${JSON.stringify(first)}`);
  assert(harness.remoteContains(harness.baseBranch, harness.verifiedOid), "remote merge must contain the verified commit before local recovery fails");
  assert(mergeCalls(harness).length === 1, "the first attempt must perform exactly one remote merge");

  const fetchesBeforeRetry = harness.gitCalls("fetch ").length;
  const viewsBeforeRetry = harness.ghCalls("pr view ").length;
  const retry = await handleMerge();
  assertMergeDone(retry, "MERGED-state retry");
  assert(retry.data?.outcome === "merged_now", `confirmed receipt retry must retain its merged_now outcome: ${JSON.stringify(retry.data)}`);
  assert(mergeCalls(harness).length === 1, "MERGED-state retry must not invoke a second remote merge");
  const retryFetches = harness.gitCalls("fetch ").slice(fetchesBeforeRetry);
  assert(
    retryFetches.length === 1 && retryFetches[0].includes(harness.baseBranch),
    `confirmed receipt retry must refresh configured-base ancestry exactly once: ${JSON.stringify(retryFetches)}`,
  );
  assert(harness.ghCalls("pr view ").length === viewsBeforeRetry, "confirmed receipt retry must resume local sync without another GitHub query");
  assert(harness.remoteOid(harness.sourceBranch) === null, "remote source branch deleted by the merge must stay deleted");
  assert(branchPushes(harness, harness.sourceBranch).length === 0, "the completed source branch must not be selected as downstream or recreated");
});

await withHarness("confirmed-receipt-base-rewrite", async harness => {
  harness.failGitOnce("checkout", harness.baseBranch);
  const first = await handleMerge();
  assertMergeStopped(first, "confirmed receipt before remote base rewrite");
  assert(first.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `fixture must persist a completed receipt before rewrite: ${JSON.stringify(first)}`);
  assert(harness.remoteContains(harness.baseBranch, harness.verifiedOid), "fixture must first confirm the verified commit in remote base");
  assert(mergeCalls(harness).length === 1, "fixture must perform exactly one initial merge mutation");
  const pushesBeforeRetry = new Map(harness.downstreamBranches.map(branch => [branch, branchPushes(harness, branch).length]));

  harness.forceRemoteBranch(harness.baseBranch, harness.baseOid);
  assert(!harness.remoteContains(harness.baseBranch, harness.verifiedOid), "remote rewrite fixture must remove verified commit ancestry");
  const retry = await handleMerge();
  assertMergeStopped(retry, "confirmed receipt after remote base rewrite");
  assert(retry.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `base rewrite must remain a local-sync recovery failure: ${JSON.stringify(retry)}`);
  assert(retry.error?.detail?.operation === "sync base ancestry", `base rewrite must identify the failed ancestry postcondition: ${JSON.stringify(retry.error?.detail)}`);
  assert(retry.error?.retryable === true, "base rewrite recovery must remain retryable");
  assertAllowedTools(retry, ["hy_merge", "hy_status"], "confirmed receipt base rewrite");
  assert(mergeCalls(harness).length === 1, "base rewrite retry must never repeat the merge mutation");
  for (const branch of harness.downstreamBranches) {
    assert(branchPushes(harness, branch).length === pushesBeforeRetry.get(branch), `base rewrite retry must not push downstream branch ${branch}`);
  }
});

await withHarness("legacy-git-ancestry-recovery", async harness => {
  const downstreamBefore = new Map(harness.downstreamBranches.map(branch => [branch, harness.remoteOid(branch)]));
  const unrelatedBranch = "feat/unrelated-legacy-history";
  const unrelated = harness.createUnrelatedAgentBranch(unrelatedBranch);
  harness.integrateRemote();
  harness.setGhCapability("unavailable");
  const result = await handleMerge();
  assertMergeDone(result, "legacy gh-unavailable Git ancestry recovery");
  assert(result.data?.evidence === "git" && result.data?.outcome === "already_integrated", `Git fallback must expose actual evidence and outcome: ${JSON.stringify(result.data)}`);
  assert(mergeCalls(harness).length === 0, "legacy Git ancestry recovery must not invoke a merge mutation");
  assert(harness.gitCalls("fetch ").some(call => call.includes(harness.baseBranch)), "gh-unavailable recovery must fetch the configured remote base in the current attempt");
  assert(basePushes(harness).length === 0, "read-only Git fallback must never push the configured base");
  for (const branch of harness.downstreamBranches) {
    const local = harness.localOid(branch);
    const remote = harness.remoteOid(branch);
    assert(!result.data?.skipped?.includes(branch), `legacy Git ancestry recovery must stage safe downstream branch ${branch}`);
    assert(branchPushes(harness, branch).length === 1, `legacy Git ancestry recovery must push safe downstream branch ${branch} once`);
    assert(remote !== downstreamBefore.get(branch), `legacy Git ancestry recovery must advance remote OID for ${branch}`);
    assert(local === remote, `legacy Git ancestry recovery must leave local and remote ${branch} aligned`);
  }
  assert(result.data?.skipped?.includes(unrelatedBranch), "legacy recovery must report unrelated history as skipped");
  assert(branchPushes(harness, unrelatedBranch).length === 0, "legacy recovery must not push unrelated history");
  assert(harness.remoteOid(unrelatedBranch) === unrelated.remoteOid, "legacy recovery must preserve unrelated remote history");
});

await withHarness("legacy-merged-recovery", async harness => {
  const downstreamBefore = new Map(harness.downstreamBranches.map(branch => [branch, harness.remoteOid(branch)]));
  harness.integrateRemote();
  const result = await handleMerge();
  assertMergeDone(result, "legacy exact MERGED recovery");
  assert(result.data?.outcome === "already_merged", `an exact GitHub MERGED lifecycle plus Git ancestry must report already_merged: ${JSON.stringify(result.data)}`);
  assert(mergeCalls(harness).length === 0, "legacy MERGED recovery must not invoke a merge mutation");
  assert(harness.gitCalls("fetch ").some(call => call.includes(harness.baseBranch)), "legacy MERGED recovery must bind success to fresh Git ancestry");
  for (const branch of harness.downstreamBranches) {
    const local = harness.localOid(branch);
    const remote = harness.remoteOid(branch);
    assert(!result.data?.skipped?.includes(branch), `legacy MERGED recovery must stage safe downstream branch ${branch}`);
    assert(branchPushes(harness, branch).length === 1, `legacy MERGED recovery must push safe downstream branch ${branch} once`);
    assert(remote !== downstreamBefore.get(branch), `legacy MERGED recovery must advance remote OID for ${branch}`);
    assert(local === remote, `legacy MERGED recovery must leave local and remote ${branch} aligned`);
  }
});

await withHarness("fresh-diverged-downstream-blocked", async harness => {
  const branch = harness.downstreamBranches[0];
  const { remoteOid } = harness.divergeBranch(branch);
  const result = await handleMerge();
  assertMergeStopped(result, "fresh diverged downstream snapshot");
  assert(result.error?.code === "DOWNSTREAM_SNAPSHOT_FAILED", `fresh divergence must fail before the merge mutation: ${JSON.stringify(result)}`);
  assert(mergeCalls(harness).length === 0, "fresh divergence must stop before any merge mutation");
  assert(!harness.remoteContains(harness.baseBranch, harness.verifiedOid), "fresh divergence must leave verified source absent from base");
  assert(branchPushes(harness, branch).length === 0, "an unsafe diverged downstream branch must never be force-pushed");
  assert(harness.remoteOid(branch) === remoteOid, "an unsafe diverged downstream remote OID must remain unchanged");
});

await withHarness("legacy-integrated-diverged-downstream-blocked", async harness => {
  const branch = harness.downstreamBranches[0];
  const { remoteOid } = harness.divergeBranch(branch);
  harness.integrateRemote();
  harness.setGhCapability("unavailable");
  const result = await handleMerge();
  assertMergeStopped(result, "legacy integrated diverged downstream snapshot");
  assert(result.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `confirmed legacy integration must retain a local-sync error: ${JSON.stringify(result)}`);
  assert(result.error?.detail?.operation === "downstream snapshot", `legacy divergence must identify the failed operation: ${JSON.stringify(result.error?.detail)}`);
  assert(mergeCalls(harness).length === 0, "legacy integrated divergence must not invoke a merge mutation");
  assert(branchPushes(harness, branch).length === 0, "legacy integrated divergence must not push the unsafe branch");
  assert(harness.remoteOid(branch) === remoteOid, "legacy integrated divergence must preserve the remote OID");
});

await withHarness("unrelated-downstream-skipped", async harness => {
  const branch = "feat/unrelated-history";
  const { remoteOid } = harness.createUnrelatedAgentBranch(branch);
  const result = await handleMerge();
  assertMergeDone(result, "unrelated downstream skip");
  assert(result.data?.skipped?.includes(branch), "a branch outside prepared-base ancestry must be reported as skipped");
  assert(branchPushes(harness, branch).length === 0, "a downstream branch with unknown lineage must never be force-pushed");
  assert(harness.remoteOid(branch) === remoteOid, "a downstream branch with unknown lineage must preserve its remote OID");
});

await withHarness("missing-downstream-remote-skipped", async harness => {
  const branch = harness.downstreamBranches[0];
  harness.deleteRemoteBranch(branch);
  assert(harness.remoteOid(branch) === null, "missing-remote fixture must delete the downstream remote ref");
  const result = await handleMerge();
  assertMergeDone(result, "missing downstream remote skip");
  assert(result.data?.skipped?.includes(branch), "a local downstream without a remote snapshot must be reported as skipped");
  assert(branchPushes(harness, branch).length === 0, "a missing downstream remote must never be recreated by push");
  assert(mergeCalls(harness).length === 1, "skipping a missing downstream remote must not prevent the single PR merge mutation");
  assert(harness.remoteOid(branch) === null, "a skipped missing downstream remote must remain absent");
});

await withHarness("pending-receipt-remote-base-advanced", async harness => {
  seedPendingReceipt(harness, false);
  const advanced = harness.advanceRemoteBase();
  assert(advanced !== harness.baseOid, "remote base advance must produce a new commit");
  assert(harness.remoteOid(harness.baseBranch) === advanced, "remote base must point at the independently advanced commit");
  assert(!harness.remoteContains(harness.baseBranch, harness.verifiedOid), "independently advanced base must not contain the verified source commit");

  const result = await handleMerge();
  assertMergeStopped(result, "pending receipt after remote base advance");
  assert(result.error?.code === "DOWNSTREAM_SNAPSHOT_FAILED", `stale prepared-base receipt must fail before merge mutation: ${JSON.stringify(result)}`);
  assert(mergeCalls(harness).length === 0, "stale prepared-base receipt must stop before any PR merge mutation");
  const receipt = readState().mergeReceipt;
  assert(receipt && receipt.mutationAttempted === false, "stale prepared-base failure must preserve the unattempted pending receipt");
});

await withHarness("post-rebase-pre-receipt-retry", async harness => {
  const branch = harness.downstreamBranches[0];
  const prepared = harness.localOid(branch);
  assert(prepared && prepared === harness.remoteOid(branch), "crash fixture must start from an aligned prepared downstream OID");
  harness.failGitOnce("rev-parse", "HEAD");
  const first = await handleMerge();
  assertMergeStopped(first, "post-rebase pre-receipt interruption");
  assert(first.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `post-rebase interruption must preserve confirmed remote state: ${JSON.stringify(first)}`);
  assert(harness.remoteContains(harness.baseBranch, harness.verifiedOid), "post-rebase interruption must occur after remote integration");
  assert(harness.localOid(branch) === prepared, "detached rebase interruption must not move the real local branch ref");
  assert(harness.remoteOid(branch) === prepared, "detached rebase interruption must not move the remote branch ref");

  const retry = await handleMerge();
  assertMergeDone(retry, "post-rebase pre-receipt retry");
  assert(mergeCalls(harness).length === 1, "post-rebase retry must not repeat the remote merge");
  assert(branchPushes(harness, branch).length === 1, "post-rebase retry must push the branch exactly once");
  assert(harness.localOid(branch) === harness.remoteOid(branch), "post-rebase retry must align real local and remote branch refs");
});

await withHarness("attempted-receipt-merged-recovery", async harness => {
  seedAttemptedReceipt(harness);
  harness.integrateRemote();
  const result = await handleMerge();
  assertMergeDone(result, "attempted receipt exact MERGED recovery");
  assert(result.data?.outcome === "already_merged", `attempted receipt must reconcile an exact MERGED lifecycle without another mutation: ${JSON.stringify(result.data)}`);
  assert(mergeCalls(harness).length === 0, "attempted receipt recovery must never repeat the merge mutation");
  assert(harness.gitCalls("fetch ").some(call => call.includes(harness.baseBranch)), "attempted receipt recovery must use one fresh ancestry observation");
});

await withHarness("remote-success-timeout", async harness => {
  harness.setGhMergeExit("remote-success-error");
  harness.setGhViewMode("unavailable-after-merge");
  const result = await handleMerge();
  assertMergeDone(result, "remote-success transport timeout reconciliation");
  assert(result.data?.evidence === "git" && result.data?.outcome === "already_integrated", `timeout reconciliation must expose Git integration evidence: ${JSON.stringify(result.data)}`);
  assert(mergeCalls(harness).length === 1, "a transport timeout after remote success must not cause a second merge");
  assert(harness.remoteContains(harness.baseBranch, harness.verifiedOid), "Git ancestry must prove the timed-out merge reached the remote base");
  assert(harness.gitCalls("fetch ").some(call => call.includes(harness.baseBranch)), "timeout reconciliation must use fresh remote Git evidence when the PR query is unavailable");
  assert(basePushes(harness).length === 0, "timeout fallback must never push the configured base");
});

for (const [operation, target] of [
  ["pull", "main"],
  ["rebase", ""],
  ["push", "feat/downstream-a"],
] as Array<[GitFaultOperation, string]>) {
  await withHarness(`local-${operation}-retry`, async harness => {
    harness.failGitOnce(operation, target);
    const first = await handleMerge();
    assertMergeStopped(first, `one-shot ${operation} failure`);
    assert(first.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `${operation} failure after remote confirmation must use POST_MERGE_SYNC_INCOMPLETE: ${JSON.stringify(first)}`);
    assert(harness.remoteContains(harness.baseBranch, harness.verifiedOid), `${operation} failure must happen after the remote merge`);
    const retry = await handleMerge();
    assertMergeDone(retry, `${operation} retry`);
    assert(mergeCalls(harness).length === 1, `${operation} retry must not repeat the remote merge`);
  });
}

await withHarness("partial-chain-progress", async harness => {
  const [completedBranch, interruptedBranch] = harness.downstreamBranches;
  const interruptedPrepared = harness.localOid(interruptedBranch);
  assert(interruptedPrepared, "partial-chain fixture must resolve the interrupted prepared OID");
  harness.failGitOnce("checkout", interruptedPrepared);
  const first = await handleMerge();
  assertMergeStopped(first, "partial downstream checkout failure");
  assert(first.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `partial downstream interruption must expose sync recovery, not merge uncertainty: ${JSON.stringify(first)}`);
  assert(branchPushes(harness, completedBranch).length === 1, "the first downstream branch must be pushed before the injected interruption");
  assert(branchPushes(harness, interruptedBranch).length === 0, "the interrupted downstream branch must not be pushed early");

  const retry = await handleMerge();
  assertMergeDone(retry, "partial downstream retry");
  assert(mergeCalls(harness).length === 1, "partial downstream retry must not repeat the remote merge");
  assert(branchPushes(harness, completedBranch).length === 1, "a downstream branch recorded complete must not be pushed again");
  assert(branchPushes(harness, interruptedBranch).length === 1, "the remaining downstream branch must be completed exactly once");
  assert(branchPushes(harness, harness.sourceBranch).length === 0, "partial recovery must never recreate the merged source branch");
});

await withHarness("identity-mismatch", async harness => {
  harness.setPrIdentity({ baseBranch: "release" });
  const result = await handleMerge();
  assertMergeStopped(result, "PR base identity mismatch");
  assert(result.error?.code === "PR_IDENTITY_MISMATCH", `base mismatch should retain the stable identity error: ${JSON.stringify(result)}`);
  assert(result.error?.retryable === false, "PR identity mismatch must be explicitly non-retryable");
  assertAllowedTools(result, ["hy_reset", "hy_status"], "PR identity mismatch");
  assert(result.recovery?.tool === "hy_reset", `PR identity mismatch must direct recovery to hy_reset: ${JSON.stringify(result.recovery)}`);
  assert(mergeCalls(harness).length === 0, "identity mismatch must stop before merge mutation");
});

await withHarness("receipt-identity-mismatch", async harness => {
  seedAttemptedReceipt(harness);
  const state = readState();
  assert(state.mergeReceipt, "receipt mismatch fixture must persist a receipt");
  state.mergeReceipt.identity = { ...state.mergeReceipt.identity, prNumber: harness.prNumber + 1 };
  writeState(state);
  const result = await handleMerge();
  assertMergeStopped(result, "persisted receipt identity mismatch");
  assert(result.error?.code === "PR_IDENTITY_MISMATCH" && result.error?.retryable === false, `receipt mismatch must be a stable non-retryable identity error: ${JSON.stringify(result)}`);
  assertAllowedTools(result, ["hy_reset", "hy_status"], "receipt identity mismatch");
  assert(result.recovery?.tool === "hy_reset", `receipt mismatch must direct recovery to hy_reset: ${JSON.stringify(result.recovery)}`);
  assert(mergeCalls(harness).length === 0, "receipt identity mismatch must stop before merge mutation");
});

await withHarness("oid-mismatch", async harness => {
  harness.setPrIdentity({ headOid: "0".repeat(40) });
  const result = await handleMerge();
  assertMergeStopped(result, "PR head OID mismatch");
  assert(result.error?.code === "PR_HEAD_OID_MISMATCH", `OID mismatch should retain the stable error: ${JSON.stringify(result)}`);
  assert(mergeCalls(harness).length === 0, "OID mismatch must stop before merge mutation");
});

await withHarness("closed-unmerged", async harness => {
  harness.setPrState("CLOSED");
  const result = await handleMerge();
  assertMergeStopped(result, "closed unmerged PR");
  assert(!harness.remoteContains(harness.baseBranch, harness.verifiedOid), "closed PR fixture must remain absent from the remote base");
  assert(mergeCalls(harness).length === 0, "closed unmerged PR must not be merged on retry");
});

await withHarness("ancestor-negative", async harness => {
  seedAttemptedReceipt(harness);
  harness.setGhCapability("unavailable");
  const result = await handleMerge();
  assertMergeStopped(result, "gh-unavailable negative ancestry");
  assert(result.error?.code === "PR_MERGE_OUTCOME_UNCONFIRMED", `negative ancestry must expose the stable unknown-outcome error: ${JSON.stringify(result)}`);
  assert(result.error?.retryable === true, "negative ancestry must remain explicitly retryable");
  assertAllowedTools(result, ["hy_merge", "hy_status"], "negative ancestry");
  assert(result.recovery?.tool === "hy_merge", `negative ancestry must direct recovery to hy_merge: ${JSON.stringify(result.recovery)}`);
  assert(harness.gitCalls("fetch ").some(call => call.includes(harness.baseBranch)), "negative ancestry must be based on a fresh base fetch");
  assert(!harness.remoteContains(harness.baseBranch, harness.verifiedOid), "negative ancestry fixture must not contain the verified commit");
  assert(mergeCalls(harness).length === 0, "negative ancestry must not fall back to pushing or merging the base");
  assert(basePushes(harness).length === 0, "negative ancestry fallback must never push the configured base");
});

await withHarness("fetch-failure", async harness => {
  seedAttemptedReceipt(harness);
  harness.setGhCapability("unavailable");
  harness.failGitOnce("fetch", harness.baseBranch);
  const result = await handleMerge();
  assertMergeStopped(result, "gh-unavailable fetch failure");
  assert(result.error?.code === "PR_MERGE_OUTCOME_UNCONFIRMED", `fetch failure must expose the stable unknown-outcome error: ${JSON.stringify(result)}`);
  assert(harness.gitCalls("fetch ").length === 1, "fresh evidence fetch should be attempted exactly once before failing closed");
  assert(mergeCalls(harness).length === 0, "fetch failure must not attempt a merge mutation");
  assert(basePushes(harness).length === 0, "fetch failure fallback must never push the configured base");
});

console.log("merge-recovery: unknown remote outcomes, local interruptions, idempotent retry, identity, and fresh Git ancestry contracts pass");
