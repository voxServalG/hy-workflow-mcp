import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch, computeImplementationDigest, computeImplementationManifestHash, computePlanHash, computeVerifyHash, currentBranch, type PlanDoc } from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { requireRuntimeConfig } from "../config.js";
import { commitScope, push, createPr, inspectScopedWorktree, resolveHeadCommit, resolveOriginRepository, parseCommitRecovery, type CommitRecoveryRecord } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

function markdownFenceFor(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return "`".repeat(longest + 1);
}

export function buildCommitBody(args: { body: string; plan: PlanDoc; verifyHash: string }): string {
  const planDocJson = JSON.stringify(args.plan, null, 2);
  const fence = markdownFenceFor(planDocJson);

  return [
    args.body,
    "",
    "---",
    "",
    "**Scope**",
    `- Changes: ${args.plan.scope.changes.join(", ") || "none"}`,
    `- New files: ${args.plan.scope.new_files.join(", ") || "none"}`,
    `- Delete: ${args.plan.scope.delete.join(", ") || "none"}`,
    "",
    "**Boundary**",
    `- Entry points: ${args.plan.boundary.entry_points.length} checks`,
    `- No new deps: ${args.plan.boundary.no_new_external}`,
    "",
    "**Verify**",
    `- smoke: ${args.plan.verify.smoke.length} checks, tests: ${args.plan.verify.tests.length} checks`,
    `- hash: \`${args.verifyHash}\``,
    "",
    "**PlanDoc audit**",
    `- planHash: \`${computePlanHash(args.plan) ?? "none"}\``,
    `- verifyHash: \`${args.verifyHash}\``,
    "",
    "<details>",
    "<summary>Raw PlanDoc JSON</summary>",
    "",
    `${fence}json`,
    planDocJson,
    fence,
    "",
    "</details>",
  ].join("\n");
}

export async function handleCommit(args: { title: string; body: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "commit");

  if (!state.plan) return toolResult("commit", { error: "No plan", allowedTools: ["hy_status"] });
  if (!state.verifyHash) return toolResult("commit", { error: "Missing verifyHash", hint: "Run hy_verify successfully before hy_commit.", allowedTools: ["hy_verify", "hy_status"] });
  if (!state.branch) return toolResult("commit", { error: "No active branch", allowedTools: ["hy_status"] });

  const root = projectRoot();
  const actualBranch = currentBranch(root);
  if (actualBranch !== state.branch) {
    return toolResult("commit", {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_BRANCH_MISMATCH",
        message: `Current git branch is ${actualBranch || "unknown"}, but workflow state expects ${state.branch}.`,
        hint: "Switch back to the workflow branch or reset the workflow state before committing.",
        detail: { expected: state.branch, actual: actualBranch },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  let currentManifest;
  try {
    currentManifest = buildImplementationManifest(root);
  } catch (e: any) {
    return toolResult("commit", {
      error: {
        type: "scope",
        subtype: "scope_drift",
        code: "IMPLEMENTATION_MANIFEST_UNAVAILABLE",
        message: e?.message ?? String(e),
        hint: "Fix the git manifest error, then rerun hy_verify before hy_commit.",
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const currentManifestHash = computeImplementationManifestHash(currentManifest);
  const expectedManifestHash = state.verifiedManifestHash ?? computeImplementationManifestHash(state.implementationManifest);
  if (!expectedManifestHash || currentManifestHash !== expectedManifestHash) {
    return toolResult("commit", {
      error: {
        type: "scope",
        subtype: "scope_drift",
        code: "IMPLEMENTATION_MANIFEST_MISMATCH",
        message: "Implementation file set changed after hy_verify.",
        hint: "Run hy_read_docs(after_edit), hy_sync_docs, and hy_verify again before hy_commit.",
        detail: { expected: expectedManifestHash, actual: currentManifestHash },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_read_docs", "hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const currentDigest = computeImplementationDigest(root, currentManifest);
  if (!state.verifiedImplementationDigest || currentDigest !== state.verifiedImplementationDigest) {
    return toolResult("commit", {
      error: {
        type: "verification",
        subtype: "check_failed",
        code: "IMPLEMENTATION_DIGEST_MISMATCH",
        message: "Implementation content changed after hy_verify.",
        hint: "Run hy_read_docs(after_edit), hy_sync_docs, and hy_verify again before hy_commit.",
        detail: { expected: state.verifiedImplementationDigest, actual: currentDigest },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_read_docs", "hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const expectedVerifyHash = computeVerifyHash(state);
  if (state.verifyHash !== expectedVerifyHash) {
    return toolResult("commit", {
      error: {
        type: "verification",
        subtype: "check_failed",
        code: "VERIFY_HASH_STALE",
        message: "verifyHash no longer matches the verified plan and implementation snapshot.",
        hint: "Rerun hy_verify before hy_commit.",
        detail: { expected: expectedVerifyHash, actual: state.verifyHash },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  if (!state.approval) {
    return toolResult("commit", {
      error: "Missing approval state",
      hint: "Reset the invalid workflow state before committing.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  let baseBranch: string;
  try {
    requireRuntimeConfig(root);
    baseBranch = getBaseBranch(root);
  } catch (caught: any) {
    return toolResult("commit", {
      error: caught,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }
  const origin = resolveOriginRepository(root);
  if (!origin.ok) {
    return toolResult("commit", {
      error: origin.error,
      data: { executor: { origin: origin.executor } },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_commit", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }
  const repository = origin.repository;

  const body = buildCommitBody({ body: args.body, plan: state.plan, verifyHash: state.verifyHash });

  const rawRecovery = (state.approval as typeof state.approval & { commitRecovery?: unknown }).commitRecovery;
  const parsedRecovery = parseCommitRecovery(rawRecovery);
  const sameVerificationRecovery: CommitRecoveryRecord | null = parsedRecovery?.verifyHash === state.verifyHash ? parsedRecovery : null;
  if (sameVerificationRecovery && (
    sameVerificationRecovery.branch !== state.branch
    || sameVerificationRecovery.baseBranch !== baseBranch
    || sameVerificationRecovery.repository !== repository
  )) {
    return toolResult("commit", {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "COMMIT_RECOVERY_IDENTITY_MISMATCH",
        message: "The branch, base branch, or origin repository changed after this verified commit recovery identity was recorded.",
        hint: "Do not create another commit from the old verification. Restore the recorded Git identity or rerun the edit, document, and verify gates.",
        detail: {
          expected: {
            branch: sameVerificationRecovery.branch,
            baseBranch: sameVerificationRecovery.baseBranch,
            repository: sameVerificationRecovery.repository,
          },
          actual: { branch: state.branch, baseBranch, repository },
          verifyHash: state.verifyHash,
        },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }
  const matchingRecovery: CommitRecoveryRecord | null = sameVerificationRecovery
    && sameVerificationRecovery.branch === state.branch
    && sameVerificationRecovery.baseBranch === baseBranch
    && sameVerificationRecovery.repository === repository
    ? sameVerificationRecovery
    : null;

  let c: ReturnType<typeof commitScope>;
  let noScopedChanges: boolean;
  if (matchingRecovery) {
    const inspectedScope = inspectScopedWorktree(root, state.plan.scope);
    if (!inspectedScope.ok) {
      return toolResult("commit", {
        error: inspectedScope.error,
        data: { executor: { commit: inspectedScope.executor }, stagedPaths: inspectedScope.changedPaths },
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_commit", "hy_status"],
        blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
      });
    }
    if (inspectedScope.changedPaths.length) {
      return toolResult("commit", {
        error: {
          type: "workflow_state",
          subtype: "invalid_phase",
          code: "COMMIT_RECOVERY_WORKTREE_CHANGED",
          message: "Scoped worktree changes exist after a verified commit recovery identity was recorded.",
          hint: "Do not create another commit from the old verification. Restore the recorded commit or rerun the edit, document, and verify gates.",
          detail: { expectedCommitOid: matchingRecovery.commitOid, changedPaths: inspectedScope.changedPaths },
        },
        data: { executor: { commit: inspectedScope.executor }, stagedPaths: inspectedScope.changedPaths },
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_verify", "hy_status"],
        blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
      });
    }
    c = {
      ok: false,
      error: { code: "NO_SCOPED_CHANGES" },
      executor: inspectedScope.executor,
      stagedPaths: [],
    };
    noScopedChanges = true;
  } else {
    c = commitScope(root, state.plan.scope, args.title, body);
    noScopedChanges = !c.ok && (c.error as any)?.code === "NO_SCOPED_CHANGES";
  }
  if (!c.ok && !noScopedChanges) return toolResult("commit", { error: c.error, data: { executor: { commit: c.executor }, stagedPaths: c.stagedPaths }, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Fix the commit error, then retry hy_commit without changing files unless necessary." }, allowedTools: ["hy_commit", "hy_status"] });
  if (noScopedChanges && !matchingRecovery) {
    return toolResult("commit", {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "COMMIT_RECOVERY_STATE_MISSING",
        message: "No scoped worktree changes remain, but no matching verified commit recovery record exists.",
        hint: "Do not create an empty commit or guess from HEAD. Return to edit/verify so a real verified commit can be recorded.",
        detail: { verifyHash: state.verifyHash, branch: state.branch, baseBranch, repository, recovery: rawRecovery ?? null },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const resolvedHead = resolveHeadCommit(root);
  if (!resolvedHead.ok || !resolvedHead.hash) {
    return toolResult("commit", {
      error: resolvedHead.error ?? {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_HEAD_UNAVAILABLE",
        message: "Could not resolve the verified commit after the commit step.",
        hint: "Repair the workflow branch, then retry hy_commit.",
      },
      data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor }, stagedPaths: c.stagedPaths },
      requires_user: true,
      stop_here: true,
      recovery: { tool: "hy_commit", instruction: "Repair the workflow branch and retry hy_commit without creating an empty commit." },
      allowedTools: ["hy_commit", "hy_status"],
    });
  }
  if (c.ok && c.hash !== resolvedHead.hash) {
    return toolResult("commit", {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_COMMIT_OID_MISMATCH",
        message: "The commit result no longer matches the current workflow HEAD.",
        hint: "Do not push. Inspect the workflow branch, then rerun verification and hy_commit.",
        detail: { committed: c.hash, current: resolvedHead.hash },
      },
      data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor }, stagedPaths: c.stagedPaths },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }
  if (noScopedChanges && matchingRecovery && resolvedHead.hash !== matchingRecovery.commitOid) {
    return toolResult("commit", {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_RECOVERY_OID_MISMATCH",
        message: "The current clean HEAD does not match the verified commit recorded before the earlier push or PR failure.",
        hint: "Do not push the moved HEAD. Restore the recorded commit or rerun the edit, document, and verify gates.",
        detail: { expected: matchingRecovery.commitOid, actual: resolvedHead.hash },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const commitHash = resolvedHead.hash;
  const commitAction = noScopedChanges ? "recovered_verified_head" : "created";
  let postCommitManifest;
  try {
    postCommitManifest = buildImplementationManifest(root);
  } catch (e: any) {
    return toolResult("commit", {
      error: {
        type: "scope",
        subtype: "scope_drift",
        code: "IMPLEMENTATION_MANIFEST_UNAVAILABLE_AFTER_COMMIT",
        message: e?.message ?? String(e),
        hint: "Do not push. Fix the Git manifest error, then rerun hy_verify before hy_commit.",
      },
      data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash } },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }
  const beforePaths = [...currentManifest.changed].sort();
  const afterPaths = [...postCommitManifest.changed].sort();
  const postCommitDigest = computeImplementationDigest(root, postCommitManifest);
  if (JSON.stringify(beforePaths) !== JSON.stringify(afterPaths) || postCommitDigest !== state.verifiedImplementationDigest) {
    return toolResult("commit", {
      error: {
        type: "verification",
        subtype: "check_failed",
        code: "IMPLEMENTATION_CHANGED_AFTER_COMMIT",
        message: "Implementation paths or content changed during the commit step.",
        hint: "Do not push. Review the concurrent change, then rerun hy_read_docs(after_edit), hy_sync_docs, hy_verify, and hy_commit.",
        detail: { expectedPaths: beforePaths, actualPaths: afterPaths, expectedDigest: state.verifiedImplementationDigest, actualDigest: postCommitDigest },
      },
      data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash } },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_read_docs", "hy_verify", "hy_status"],
      blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    });
  }

  let activeState = state;
  if (!noScopedChanges) {
    const commitRecovery: CommitRecoveryRecord = {
      version: 1,
      commitOid: commitHash,
      verifyHash: state.verifyHash,
      branch: state.branch,
      baseBranch,
      repository,
    };
    activeState = {
      ...state,
      approval: { ...state.approval, commitRecovery } as typeof state.approval,
    };
    try {
      writeState(activeState);
    } catch (caught: any) {
      return toolResult("commit", {
        error: {
          type: "io",
          subtype: "io_failure",
          code: "COMMIT_RECOVERY_PERSIST_FAILED",
          message: "The verified commit was created but its recovery identity could not be persisted before push.",
          hint: "Do not push. Repair the user state directory, then rerun the edit/verify/commit flow.",
          cause: caught?.message ?? String(caught),
        },
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_status"],
        blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
      });
    }
  }

  const p = push(root, state.branch, commitHash, repository);
  if (!p.ok) return toolResult("commit", { error: p.error, data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash } }, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Resolve the push failure, then retry hy_commit; it will reuse the same verified commit instead of creating an empty commit." }, allowedTools: ["hy_commit", "hy_status"] });

  const pr = createPr(root, args.title, body, baseBranch, state.branch, commitHash, repository);
  if (!pr.ok) return toolResult("commit", { error: pr.error, data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor, createPr: pr.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash }, push: { sha: p.hash } }, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Resolve the PR lookup or creation failure, then retry hy_commit. The retry will reuse the verified commit and must not create a duplicate PR." }, allowedTools: ["hy_commit", "hy_status"] });

  const next = transition(activeState, "ci");
  next.prNumber = pr.prNumber ?? null;
  next.plan!.pr_number = next.prNumber;
  writeState(next);
  const action = pr.reused ? "reused" : "created";

  return toolResult("ci", {
    prNumber: pr.prNumber,
    url: pr.url,
    reused: Boolean(pr.reused),
    data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor, createPr: pr.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash }, push: { sha: p.hash }, prAction: action, repository: pr.repository, headRefOid: pr.headRefOid },
    display: {
      title: pr.reused ? "Pull request reused" : "Pull request created",
      body: `PR #${pr.prNumber} ${action}.`,
      urls: pr.url ? [pr.url] : [],
    },
    hint: "Show the PR URL briefly, then continue to hy_ci. Do not stop here unless a later tool reports CI or merge problems.",
    allowedTools: ["hy_ci", "hy_status"],
    blockedTools: ["hy_merge", "hy_chain"],
    message: `PR #${pr.prNumber} ${action}. Waiting for CI...`,
  });
}
