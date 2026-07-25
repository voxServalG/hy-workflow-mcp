import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch, computeImplementationDigest, computePlanHash, currentBranch, type PlanDoc } from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { requireRuntimeConfig } from "../config.js";
import { commitScope, push, createPr, inspectScopedWorktree, resolveHeadCommit, resolveOriginRepository, parseCommitRecovery, checkCi, type CommitRecoveryRecord } from "../git.js";
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

function evidenceDriftResult(state: ReturnType<typeof readState>, error: unknown): ToolResult {
  const next = transition(state, "edit");
  next.verifiedImplementationDigest = null;
  next.implementationManifest = null;
  next.documentReads = next.documentReads ? { ...next.documentReads, afterEdit: null } : null;
  next.syncDocs = null;
  writeState(next);

  return toolResult("edit", {
    phase: "edit",
    error,
    display: {
      title: "Verified implementation changed — returned to edit",
      body: "The approved plan, branch, and scope were preserved. Verification and post-edit document evidence were cleared.",
    },
    hint: "Call hy_edit, then hy_read_docs(after_edit), hy_sync_docs, and the appropriate sync or async verify path before hy_commit.",
    allowedTools: ["hy_edit", "hy_read_docs", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    recovery: {
      tool: "hy_edit",
      instruction: "Re-enter edit, refresh after_edit and sync_docs evidence, then rerun verification.",
    },
  });
}

export async function handleCommit(args: { title: string; body: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "commit");

  if (!state.plan) return toolResult("commit", { error: "No plan", allowedTools: ["hy_status"] });
  if (!state.verifiedImplementationDigest) return toolResult("commit", { error: "Missing verified implementation digest", hint: "Run hy_verify for short suites or hy_exam_plan and hy_exam_submit for long suites before hy_commit.", allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"] });
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
      blockedTools: ["hy_merge"],
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
        hint: "Fix the git manifest error, then rerun the appropriate sync or async verify path before hy_commit.",
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
    });
  }

  if (!state.approval) {
    return toolResult("commit", {
      error: "Missing approval state",
      hint: "Reset the invalid workflow state before committing.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_merge"],
    });
  }

  // ── Recovery parse (before digest — skip integrity when worktree is clean after prior commit) ──
  const rawRecovery = (state.approval as typeof state.approval & { commitRecovery?: unknown }).commitRecovery;
  const parsedRecovery = parseCommitRecovery(rawRecovery);
  const sameDigestRecovery: CommitRecoveryRecord | null = parsedRecovery?.implementationDigest === state.verifiedImplementationDigest ? parsedRecovery : null;

  // ── Implementation integrity (skipped on matching recovery — clean worktree after prior commit) ──
  if (!sameDigestRecovery) {
    const currentDigest = computeImplementationDigest(root, currentManifest);
    if (!state.verifiedImplementationDigest || currentDigest !== state.verifiedImplementationDigest) {
      return evidenceDriftResult(state, {
        type: "verification", subtype: "check_failed", code: "IMPLEMENTATION_DIGEST_MISMATCH",
        message: "Implementation content changed after hy_verify.",
        hint: "Re-enter edit, refresh after_edit and sync_docs evidence, then rerun verification.",
        detail: { expected: state.verifiedImplementationDigest, actual: currentDigest },
      });
    }
  }

  // ── Config and recovery identity (runs after digest) ──
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
      blockedTools: ["hy_merge"],
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
      blockedTools: ["hy_merge"],
    });
  }
  const repository = origin.repository;

  if (sameDigestRecovery && (
    sameDigestRecovery.branch !== state.branch
    || sameDigestRecovery.baseBranch !== baseBranch
    || sameDigestRecovery.repository !== repository
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
            branch: sameDigestRecovery.branch,
            baseBranch: sameDigestRecovery.baseBranch,
            repository: sameDigestRecovery.repository,
          },
          actual: { branch: state.branch, baseBranch, repository },
          implementationDigest: state.verifiedImplementationDigest,
        },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
    });
  }
  const matchingRecovery: CommitRecoveryRecord | null = sameDigestRecovery
    && sameDigestRecovery.branch === state.branch
    && sameDigestRecovery.baseBranch === baseBranch
    && sameDigestRecovery.repository === repository
    ? sameDigestRecovery
    : null;

  const digest = state.verifiedImplementationDigest ?? "none";
  const body = buildCommitBody({ body: args.body, plan: state.plan, verifyHash: digest });

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
        blockedTools: ["hy_merge"],
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
        allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
        blockedTools: ["hy_merge"],
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
        detail: { implementationDigest: state.verifiedImplementationDigest, branch: state.branch, baseBranch, repository, recovery: rawRecovery ?? null },
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
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
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
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
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
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
        hint: "Do not push. Fix the Git manifest error, then rerun the appropriate sync or async verify path before hy_commit.",
      },
      data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash } },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
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
      allowedTools: ["hy_read_docs", "hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
    });
  }

  let activeState = state;
  if (!noScopedChanges) {
    const commitRecovery: CommitRecoveryRecord = {
      version: 1,
      commitOid: commitHash,
      implementationDigest: state.verifiedImplementationDigest ?? "",
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
        blockedTools: ["hy_merge"],
      });
    }
  }

  const p = push(root, state.branch, commitHash, repository);
  if (!p.ok) return toolResult("commit", { error: p.error, data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash } }, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Resolve the push failure, then retry hy_commit; it will reuse the same verified commit instead of creating an empty commit." }, allowedTools: ["hy_commit", "hy_status"] });

  const pr = createPr(root, args.title, body, baseBranch, state.branch, commitHash, repository);
  if (!pr.ok) return toolResult("commit", { error: pr.error, data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor, createPr: pr.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash }, push: { sha: p.hash } }, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Resolve the PR lookup or creation failure, then retry hy_commit. The retry will reuse the verified commit and must not create a duplicate PR." }, allowedTools: ["hy_commit", "hy_status"] });

  activeState.prNumber = pr.prNumber ?? null;
  activeState.plan!.pr_number = activeState.prNumber;
  writeState(activeState);
  const action = pr.reused ? "reused" : "created";

  // ── CI polling (absorbed from ci.ts) ──────────────────────
  const FAILURE_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
  const DEFAULT_TIMEOUT_SECONDS = 600;
  const DEFAULT_INTERVAL_SECONDS = 10;
  const MAX_TIMEOUT_SECONDS = 1800;
  const timeoutSeconds = Math.min(Math.max(DEFAULT_TIMEOUT_SECONDS, 0), MAX_TIMEOUT_SECONDS);
  const intervalSeconds = Math.min(Math.max(DEFAULT_INTERVAL_SECONDS, 2), timeoutSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  let ciResult = checkCi(root, activeState.prNumber);
  while (ciResult.ok && !ciResult.allGreen && !ciResult.noChecks && !ciResult.noEffectiveChecks) {
    const checks = ciResult.checks || [];
    const failedNames = checks.filter((c: any) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c: any) => c.name);
    if (failedNames.length || Date.now() >= deadline) break;
    await sleep(Math.min(intervalSeconds * 1000, Math.max(deadline - Date.now(), 0)));
    ciResult = checkCi(root, activeState.prNumber);
  }

  if (!ciResult.ok) {
    return toolResult("commit", {
      prNumber: activeState.prNumber,
      url: pr.url,
      reused: Boolean(pr.reused),
      error: ciResult.error,
      data: { executor: { commit: c.executor, push: p.executor, createPr: pr.executor, ci: ciResult.executor }, checks: ciResult.checks },
      requires_user: true,
      stop_here: true,
      display: { title: "CI query failed", body: `PR #${activeState.prNumber} was created but CI status could not be read.` },
      hint: "Retry hy_commit to re-check CI status; it will not create a duplicate commit or PR.",
      allowedTools: ["hy_commit", "hy_status"],
      message: `PR #${activeState.prNumber} ${action}. CI query failed — retry hy_commit.`,
    });
  }

  if (ciResult.noChecks || ciResult.noEffectiveChecks) {
    const reason = ciResult.noChecks
      ? "No CI checks were reported"
      : ciResult.requiredCheckAmbiguous
        ? "Multiple provenance-verified Verify checks were reported"
        : ciResult.requiredCheckMissing
          ? "No Verify check from the bound hy-workflow Actions run was reported"
          : "The required Verify check was skipped or neutral";
    return toolResult("commit", {
      prNumber: activeState.prNumber,
      url: pr.url,
      reused: Boolean(pr.reused),
      allGreen: false,
      noChecks: Boolean(ciResult.noChecks),
      noEffectiveChecks: Boolean(ciResult.noEffectiveChecks),
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "CI_CHECKS_REQUIRED",
        message: `${reason} for PR #${activeState.prNumber}; merge is blocked.`,
        hint: "Ensure exactly one .github/workflows/hy-workflow.yml Actions run for the verified PR commit reports Verify as SUCCESS, then retry hy_commit.",
        retryable: true,
      },
      display: { title: "CI checks required", body: `${reason} for PR #${activeState.prNumber}.` },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_commit", "hy_status"],
      blockedTools: ["hy_merge"],
      recovery: { tool: "hy_commit", instruction: "Ensure the required Verify check completes successfully, then rerun hy_commit." },
      message: `${reason}. Merge remains blocked — retry hy_commit.`,
    });
  }

  if (!ciResult.allGreen) {
    const checks = ciResult.checks || [];
    const failedNames = checks.filter((c: any) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c: any) => c.name);

    if (!failedNames.length) {
      return toolResult("commit", {
        prNumber: activeState.prNumber,
        url: pr.url,
        reused: Boolean(pr.reused),
        allGreen: false,
        pending: true,
        checks,
        timeoutSeconds,
        display: { title: "CI still pending", body: `PR #${activeState.prNumber} checks are still running.` },
        requires_user: true,
        stop_here: true,
        hint: "CI is still pending after bounded polling. Retry hy_commit later; it will resume polling without creating duplicate commits.",
        allowedTools: ["hy_commit", "hy_status"],
        blockedTools: ["hy_merge"],
        recovery: { tool: "hy_commit", instruction: "Wait for pending CI checks, then rerun hy_commit to continue polling." },
        message: `CI is still pending after ${timeoutSeconds}s. Retry hy_commit after checks complete.`,
      });
    }

    const editState = transition(activeState, "edit");
    writeState(editState);

    return toolResult("edit", {
      prNumber: activeState.prNumber,
      url: pr.url,
      allGreen: false,
      checks,
      failedChecks: failedNames,
      data: { executor: { commit: c.executor, push: p.executor, createPr: pr.executor, ci: ciResult.executor } },
      requires_user: true,
      stop_here: true,
      display: { title: "CI not all green", body: `Failed checks: ${failedNames.join(", ")}. Returned to edit phase.` },
      hint: "CI is not green. Read failed checks before editing. After fixes, run hy_verify, then hy_commit again.",
      allowedTools: ["hy_edit", "hy_verify", "hy_status"],
      blockedTools: ["hy_merge"],
      recovery: { tool: "hy_edit", instruction: "Fix CI failures locally, rerun hy_verify, then hy_commit." },
      message: `CI not all green. Failed: ${failedNames.join(", ")}. Fix issues and re-run hy_commit.`,
    });
  }

  // CI all green — advance to merge
  const next = transition(activeState, "merge");
  writeState(next);

  return toolResult("merge", {
    prNumber: activeState.prNumber,
    url: pr.url,
    reused: Boolean(pr.reused),
    allGreen: true,
    data: { executor: { commit: c.executor, push: p.executor, createPr: pr.executor, ci: ciResult.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash }, push: { sha: p.hash }, checks: ciResult.checks, prAction: action },
    display: {
      title: "CI passed — ready to merge",
      body: `PR #${activeState.prNumber}: the required Verify check and all effective CI checks passed.`,
    },
    hint: "Continue to hy_merge. The approved workflow does not stop after CI success.",
    allowedTools: ["hy_merge", "hy_status"],
    message: `PR #${activeState.prNumber} ${action}. Required Verify and all effective CI checks passed. Ready to merge.`,
  });
}
