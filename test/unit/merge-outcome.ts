import {
  parseGitIntegrationEvidence,
  parseMergeReceipt,
  parsePullRequestSnapshot,
  reconcileMerge,
  type GitIntegrationEvidence,
  type MergeIdentity,
  type MergeReceipt,
  type PullRequestEvidence,
  type PullRequestLifecycleState,
} from "../../src/merge-recovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const OID = "1".repeat(40);
const BASE_OID = "2".repeat(40);
const OTHER_OID = "3".repeat(40);
const identity: MergeIdentity = {
  repository: "github.com/o/r",
  prNumber: 216,
  baseBranch: "dev",
  headBranch: "feat/retry-safe-merge",
  verifiedOid: OID,
};

function pr(state: PullRequestLifecycleState, overrides: Record<string, unknown> = {}): PullRequestEvidence {
  return {
    status: "available",
    snapshot: {
      identity: {
        repository: identity.repository,
        prNumber: identity.prNumber,
        baseBranch: identity.baseBranch,
        headBranch: identity.headBranch,
        headOid: identity.verifiedOid,
        isCrossRepository: false,
        ...overrides,
      },
      lifecycle: { state },
    },
  };
}

function git(containsVerifiedOid: boolean, overrides: Partial<GitIntegrationEvidence> = {}): GitIntegrationEvidence {
  return {
    status: "available",
    repository: identity.repository,
    baseBranch: identity.baseBranch,
    verifiedOid: identity.verifiedOid,
    baseOid: BASE_OID,
    containsVerifiedOid,
    head: { status: "present", oid: OID },
    ...overrides,
  } as GitIntegrationEvidence;
}

function decide(pullRequest: PullRequestEvidence, evidence: GitIntegrationEvidence, mutationAttempted = false) {
  return reconcileMerge({ expected: identity, pullRequest, git: evidence, mutationAttempted });
}

for (const state of ["OPEN", "MERGED", "CLOSED"] as const) {
  const snapshot = (pr(state) as Extract<PullRequestEvidence, { status: "available" }>).snapshot;
  assert(parsePullRequestSnapshot(snapshot)?.lifecycle.state === state, `strict PR parser should accept ${state}`);
}
assert(parsePullRequestSnapshot({ ...(pr("OPEN") as any).snapshot, extra: true }) === null, "PR parser must reject unknown top-level fields");
assert(parsePullRequestSnapshot({ ...(pr("OPEN") as any).snapshot, lifecycle: { state: "UNKNOWN" } }) === null, "PR parser must reject unknown lifecycle states");
const polluted = Object.create({ identity: (pr("OPEN") as any).snapshot.identity });
polluted.lifecycle = { state: "OPEN" };
assert(parsePullRequestSnapshot(polluted) === null, "PR parser must reject objects with a polluted prototype");

assert(decide(pr("OPEN"), git(false)).kind === "merge_allowed", "an exact open PR absent from base should allow one merge mutation");
const missingOpenHead = decide(pr("OPEN"), git(false, { head: { status: "missing" } } as Partial<GitIntegrationEvidence>));
assert(missingOpenHead.kind === "blocked" && missingOpenHead.code === "PR_MERGE_OUTCOME_UNCONFIRMED", "an OPEN PR with a missing remote head must not mutate");
const movedOpenHead = decide(pr("OPEN"), git(false, { head: { status: "present", oid: OTHER_OID } } as Partial<GitIntegrationEvidence>));
assert(movedOpenHead.kind === "blocked" && movedOpenHead.code === "PR_HEAD_OID_MISMATCH", "an OPEN PR with a moved remote head must fail before mutation");
const attempted = decide(pr("OPEN"), git(false), true);
assert(attempted.kind === "blocked" && attempted.code === "PR_MERGE_OUTCOME_UNCONFIRMED", "an attempted but unconfirmed merge must not allow another mutation");
assert(decide(pr("MERGED"), git(true)).kind === "already_merged", "a merged PR whose verified OID is in base should reconcile");
assert(decide({ status: "unavailable", reason: "gh missing" }, git(true)).kind === "already_integrated", "Git ancestry should recover completion without gh");

const ghMissingNotIntegrated = decide({ status: "unavailable", reason: "gh missing" }, git(false));
assert(ghMissingNotIntegrated.kind === "blocked" && ghMissingNotIntegrated.code === "GITHUB_EVIDENCE_UNAVAILABLE", "gh absence without integration proof must fail closed");
const ghLostAfterAttempt = decide({ status: "unavailable", reason: "query failed" }, git(false), true);
assert(ghLostAfterAttempt.kind === "blocked" && ghLostAfterAttempt.code === "PR_MERGE_OUTCOME_UNCONFIRMED", "lost gh after mutation must remain unconfirmed");

const identityMismatch = decide(pr("OPEN", { baseBranch: "main" }), git(false));
assert(identityMismatch.kind === "blocked" && identityMismatch.code === "PR_IDENTITY_MISMATCH", "PR identity mismatch needs its own stable error");
const oidMismatch = decide(pr("OPEN", { headOid: OTHER_OID }), git(false));
assert(oidMismatch.kind === "blocked" && oidMismatch.code === "PR_HEAD_OID_MISMATCH", "PR head OID mismatch needs its own stable error");
const gitIdentityMismatch = decide(pr("OPEN"), git(false, { baseBranch: "main" } as Partial<GitIntegrationEvidence>));
assert(gitIdentityMismatch.kind === "blocked" && gitIdentityMismatch.code === "GIT_EVIDENCE_IDENTITY_MISMATCH", "Git identity evidence must remain bound to the expected base");
const gitOidMismatch = decide(pr("OPEN"), git(false, { verifiedOid: OTHER_OID } as Partial<GitIntegrationEvidence>));
assert(gitOidMismatch.kind === "blocked" && gitOidMismatch.code === "GIT_EVIDENCE_OID_MISMATCH", "Git evidence must remain bound to the verified OID");

const openIntegrated = decide(pr("OPEN"), git(true));
assert(openIntegrated.kind === "blocked" && openIntegrated.code === "PR_OPEN_COMMIT_IN_BASE", "OPEN plus ancestor evidence is contradictory");
const mergedMissing = decide(pr("MERGED"), git(false));
assert(mergedMissing.kind === "blocked" && mergedMissing.code === "PR_MERGED_COMMIT_NOT_REACHABLE", "MERGED without ancestry must fail closed");
const closedMissing = decide(pr("CLOSED"), git(false));
assert(closedMissing.kind === "blocked" && closedMissing.code === "PR_CLOSED_UNMERGED", "CLOSED without ancestry must fail closed");
const closedIntegrated = decide(pr("CLOSED"), git(true));
assert(closedIntegrated.kind === "blocked" && closedIntegrated.code === "PR_CLOSED_COMMIT_IN_BASE", "CLOSED plus ancestry must remain an explicit conflict");

const unavailableGit: GitIntegrationEvidence = {
  status: "unavailable",
  repository: identity.repository,
  baseBranch: identity.baseBranch,
  verifiedOid: identity.verifiedOid,
  reason: "fetch failed",
  head: { status: "unavailable", reason: "lookup failed" },
};
const noGit = decide(pr("MERGED"), unavailableGit);
assert(noGit.kind === "blocked" && noGit.code === "GIT_INTEGRATION_EVIDENCE_UNAVAILABLE", "MERGED still requires fresh base ancestry evidence");
assert(parseGitIntegrationEvidence(unavailableGit)?.status === "unavailable", "strict Git evidence parser should accept a complete unavailable observation");
assert(parseGitIntegrationEvidence({ ...git(true), baseOid: "not-an-oid" }) === null, "Git evidence parser must reject invalid object IDs");

const pendingReceipt: MergeReceipt = {
  version: 1,
  identity,
  preparedBaseOid: BASE_OID,
  mutationAttempted: false,
  remote: { outcome: "pending", evidence: "none", baseOid: null, confirmedAt: null },
  downstream: {
    syncBaseOid: null,
    candidates: ["fix/a", "test/b"],
    progress: [
      { branch: "fix/a", preparedLocalOid: OID, expectedRemoteOid: OID, state: "pending", resultOid: null },
      { branch: "test/b", preparedLocalOid: OTHER_OID, expectedRemoteOid: OTHER_OID, state: "pending", resultOid: null },
    ],
  },
};
assert(parseMergeReceipt(pendingReceipt)?.remote.outcome === "pending", "receipt parser should accept a prepared receipt");

const completedReceipt: MergeReceipt = {
  ...pendingReceipt,
  mutationAttempted: true,
  remote: {
    outcome: "merged_now",
    evidence: "github+git",
    baseOid: BASE_OID,
    confirmedAt: "2026-07-28T13:26:46.000Z",
  },
  downstream: {
    syncBaseOid: BASE_OID,
    candidates: ["fix/a", "test/b"],
    progress: [
      { branch: "fix/a", preparedLocalOid: OID, expectedRemoteOid: OID, state: "pushed", resultOid: OID },
      { branch: "test/b", preparedLocalOid: OTHER_OID, expectedRemoteOid: OTHER_OID, state: "rebased", resultOid: OTHER_OID },
    ],
  },
};
assert(parseMergeReceipt(completedReceipt)?.downstream.progress[0]?.state === "pushed", "receipt parser should preserve completed downstream progress");
const rebasingReceipt: MergeReceipt = {
  ...completedReceipt,
  downstream: {
    syncBaseOid: completedReceipt.downstream.syncBaseOid,
    candidates: completedReceipt.downstream.candidates,
    progress: [
      { ...completedReceipt.downstream.progress[0], state: "rebasing", resultOid: null },
      completedReceipt.downstream.progress[1],
    ],
  },
};
assert(parseMergeReceipt(rebasingReceipt)?.downstream.progress[0]?.state === "rebasing", "receipt parser should preserve a persisted detached-rebase intent");

const invalidReceipts: unknown[] = [
  { ...pendingReceipt, version: 2 },
  { ...pendingReceipt, preparedBaseOid: "bad" },
  { ...pendingReceipt, extra: true },
  { ...pendingReceipt, remote: { ...pendingReceipt.remote, outcome: "merged_now", evidence: "none" } },
  { ...pendingReceipt, remote: { outcome: "already_integrated", evidence: "git", baseOid: BASE_OID, confirmedAt: null } },
  { ...pendingReceipt, downstream: { ...pendingReceipt.downstream, candidates: ["test/b", "fix/a"] } },
  { ...pendingReceipt, downstream: { syncBaseOid: null, candidates: ["fix/a", "fix/a"], progress: pendingReceipt.downstream.progress } },
  { ...pendingReceipt, downstream: { syncBaseOid: null, candidates: [identity.headBranch], progress: [{ branch: identity.headBranch, preparedLocalOid: OID, expectedRemoteOid: OTHER_OID, state: "pending", resultOid: null }] } },
  { ...pendingReceipt, downstream: { syncBaseOid: null, candidates: ["release/not-agent"], progress: [{ branch: "release/not-agent", preparedLocalOid: OID, expectedRemoteOid: OID, state: "pending", resultOid: null }] } },
  { ...pendingReceipt, downstream: { ...pendingReceipt.downstream, progress: [{ ...pendingReceipt.downstream.progress[0], expectedRemoteOid: OTHER_OID }, pendingReceipt.downstream.progress[1]] } },
  { ...pendingReceipt, downstream: { ...pendingReceipt.downstream, progress: [{ ...pendingReceipt.downstream.progress[0], branch: "fix/wrong" }, pendingReceipt.downstream.progress[1]] } },
  { ...pendingReceipt, remote: { outcome: "pending", evidence: "none", baseOid: null, confirmedAt: null }, downstream: completedReceipt.downstream },
  { ...completedReceipt, downstream: { syncBaseOid: BASE_OID, candidates: completedReceipt.downstream.candidates, progress: [{ ...completedReceipt.downstream.progress[0], state: "rebasing", resultOid: OID }, completedReceipt.downstream.progress[1]] } },
  JSON.parse(`{"version":1,"identity":${JSON.stringify(identity)},"preparedBaseOid":"${BASE_OID}","mutationAttempted":false,"remote":{"outcome":"pending","evidence":"none","baseOid":null,"confirmedAt":null},"downstream":{"syncBaseOid":null,"candidates":[],"progress":[]},"__proto__":{"polluted":true}}`),
];
for (const [index, receipt] of invalidReceipts.entries()) {
  assert(parseMergeReceipt(receipt) === null, `receipt parser must reject invalid or malicious case ${index}`);
}
