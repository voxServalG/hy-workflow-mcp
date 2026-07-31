import { approvalMatchesPlan, readState, writeState, transition, assertPhase, projectRoot, getBaseBranch, computeImplementationDigest, computePlanHash, currentBranch, type PlanDoc } from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { requireRuntimeConfig } from "../config.js";
import { commitScope, push, createPr, inspectScopedWorktree, resolveHeadCommit, resolveOriginRepository, parseCommitRecovery, checkCi, type CommitRecoveryRecord } from "../git.js";
import { invalidWorkflowStateResult, toolResult as buildToolResult, type ToolResult } from "./_base.js";
import type { ToolResultFields } from "../output/envelope.js";

function machineErrorFacts(error: unknown): unknown {
  if (!error || typeof error !== "object" || Array.isArray(error)) return error;
  const input = error as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(input, "hint")) return error;
  const output = { ...input };
  delete output.hint;
  if (typeof input.message === "string") output.message = input.message;
  return output;
}

function commitResult(next: Parameters<typeof buildToolResult>[0], fields: ToolResultFields): ToolResult {
  return buildToolResult(next, {
    ...fields,
    ...(fields.error === undefined ? {} : { error: machineErrorFacts(fields.error) }),
  });
}

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

  return commitResult("edit", {
    phase: "edit",
    stage: "edit.implementation",
    status: "failed",
    error,
    allowedTools: ["hy_edit", "hy_read_docs", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    recovery: {
      strategy: "repair_and_retry",
      tool: "hy_edit",
    },
    nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
    control: { automatic: true, stop: false, reason: "repair_required" },
    userAction: null,
  });
}

function verificationRecoveryResult(
  state: ReturnType<typeof readState>,
  fields: ToolResultFields,
): ToolResult {
  const next = state.phase === "edit" ? { ...state } : transition(state, "edit");
  next.stage = "edit.implementation";
  writeState(next);

  const automatic = !fields.requires_user && !fields.stop_here;
  return commitResult("edit", {
    ...fields,
    phase: "edit",
    stage: "edit.implementation",
    nextAction: {
      tool: "hy_verify",
      phase: "verify",
      stage: "verify.run",
      automatic,
    },
    control: {
      automatic,
      stop: !automatic,
      reason: automatic ? "repair_required" : "review_required",
    },
    userAction: fields.userAction ?? (automatic
      ? null
      : { kind: "review_failure" }),
  });
}

export async function handleCommit(args: { title: string; body: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "commit");
  const requestedCommitArguments = { title: args.title, body: args.body };
  const currentStage = state.stage ?? "commit.prepare";

  if (!state.plan) {
    return invalidWorkflowStateResult(
      state,
      "COMMIT_PLAN_MISSING",
      "Workflow state reached commit without an active PlanDoc.",
    );
  }
  if (!state.verifiedImplementationDigest) return verificationRecoveryResult(state, { error: "Missing verified implementation digest", allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"] });
  if (!state.branch) {
    return invalidWorkflowStateResult(
      state,
      "COMMIT_BRANCH_MISSING",
      "Workflow state reached commit without an active branch.",
    );
  }

  const root = projectRoot();
  const actualBranch = currentBranch(root);
  if (actualBranch !== state.branch) {
    return commitResult("commit", {
      stage: currentStage,
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_BRANCH_MISMATCH",
        message: `Current git branch is ${actualBranch || "unknown"}, but workflow state expects ${state.branch}.`,
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
    return verificationRecoveryResult(state, {
      error: {
        type: "scope",
        subtype: "scope_drift",
        code: "IMPLEMENTATION_MANIFEST_UNAVAILABLE",
        message: e?.message ?? String(e),
      },
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_status"],
      blockedTools: ["hy_merge"],
    });
  }

  if (!approvalMatchesPlan(state.approval, state.plan)) {
    return invalidWorkflowStateResult(
      state,
      "APPROVAL_PLAN_MISMATCH",
      "The persisted approval does not match the current PlanDoc.",
    );
  }

  if (state.commitIntent && (
    state.commitIntent.title !== requestedCommitArguments.title
    || state.commitIntent.body !== requestedCommitArguments.body
  )) {
    const persistedCommitArguments = { title: state.commitIntent.title, body: state.commitIntent.body };
    return commitResult("commit", {
      stage: currentStage,
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "COMMIT_ARGUMENTS_MISMATCH",
        message: "Commit title or body differs from the intent already bound to this verified implementation.",
        detail: { expected: persistedCommitArguments, actual: requestedCommitArguments },
        retryable: true,
      },
      allowedTools: ["hy_commit", "hy_status"],
      blockedTools: ["hy_merge"],
      recovery: { strategy: "retry", tool: "hy_commit", arguments: persistedCommitArguments },
      nextAction: { tool: "hy_commit", arguments: persistedCommitArguments, phase: "commit", stage: currentStage, automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
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
    return commitResult("commit", {
      stage: currentStage,
      error: caught,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_merge"],
    });
  }
  const origin = resolveOriginRepository(root);
  if (!origin.ok) {
    return commitResult("commit", {
      stage: currentStage,
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
    return verificationRecoveryResult(state, {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "COMMIT_RECOVERY_IDENTITY_MISMATCH",
        message: "The branch, base branch, or origin repository changed after this verified commit recovery identity was recorded.",
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

  if (!state.commitIntent) {
    const commitIntent = {
      ...requestedCommitArguments,
      planHash: computePlanHash(state.plan)!,
      implementationDigest: state.verifiedImplementationDigest,
    };
    state.commitIntent = commitIntent;
    try {
      writeState(state);
    } catch (caught: any) {
      return commitResult("commit", {
        stage: currentStage,
        error: {
          type: "io",
          subtype: "io_failure",
          code: "COMMIT_INTENT_PERSIST_FAILED",
          message: "Commit title and body could not be persisted before Git or GitHub mutation.",
          cause: caught?.message ?? String(caught),
          retryable: true,
        },
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_commit", "hy_status"],
        blockedTools: ["hy_merge"],
        recovery: { strategy: "retry", tool: "hy_commit", arguments: requestedCommitArguments },
        nextAction: { tool: "hy_commit", arguments: requestedCommitArguments, phase: "commit", stage: currentStage, automatic: false },
        control: { automatic: false, stop: true, reason: "review_required" },
        userAction: null,
      });
    }
  }
  const commitArguments = { title: state.commitIntent.title, body: state.commitIntent.body };

  const digest = state.verifiedImplementationDigest ?? "none";
  const body = buildCommitBody({ body: commitArguments.body, plan: state.plan, verifyHash: digest });
  state.stage = "commit.publish";
  writeState(state);

  let c: ReturnType<typeof commitScope>;
  let noScopedChanges: boolean;
  if (matchingRecovery) {
    const inspectedScope = inspectScopedWorktree(root, state.plan.scope);
    if (!inspectedScope.ok) {
      return commitResult("commit", {
        stage: "commit.publish",
        error: inspectedScope.error,
        data: { executor: { commit: inspectedScope.executor }, stagedPaths: inspectedScope.changedPaths },
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_commit", "hy_status"],
        blockedTools: ["hy_merge"],
      });
    }
    if (inspectedScope.changedPaths.length) {
      return verificationRecoveryResult(state, {
        error: {
          type: "workflow_state",
          subtype: "invalid_phase",
          code: "COMMIT_RECOVERY_WORKTREE_CHANGED",
          message: "Scoped worktree changes exist after a verified commit recovery identity was recorded.",
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
    c = commitScope(root, state.plan.scope, commitArguments.title, body);
    noScopedChanges = !c.ok && (c.error as any)?.code === "NO_SCOPED_CHANGES";
  }
  if (!c.ok && !noScopedChanges) return commitResult("commit", { stage: "commit.publish", error: c.error, data: { executor: { commit: c.executor }, stagedPaths: c.stagedPaths }, requires_user: true, stop_here: true, recovery: { strategy: "repair_and_retry", tool: "hy_commit", arguments: commitArguments }, allowedTools: ["hy_commit", "hy_status"] });
  if (noScopedChanges && !matchingRecovery) {
    return verificationRecoveryResult(state, {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "COMMIT_RECOVERY_STATE_MISSING",
        message: "No scoped worktree changes remain, but no matching verified commit recovery record exists.",
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
    return commitResult("commit", {
      stage: "commit.publish",
      error: resolvedHead.error ?? {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_HEAD_UNAVAILABLE",
        message: "Could not resolve the verified commit after the commit step.",
      },
      data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor }, stagedPaths: c.stagedPaths },
      requires_user: true,
      stop_here: true,
      recovery: { strategy: "repair_and_retry", tool: "hy_commit", arguments: commitArguments },
      allowedTools: ["hy_commit", "hy_status"],
    });
  }
  if (c.ok && c.hash !== resolvedHead.hash) {
    return verificationRecoveryResult(state, {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_COMMIT_OID_MISMATCH",
        message: "The commit result no longer matches the current workflow HEAD.",
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
    return verificationRecoveryResult(state, {
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "GIT_RECOVERY_OID_MISMATCH",
        message: "The current clean HEAD does not match the verified commit recorded before the earlier push or PR failure.",
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
    return verificationRecoveryResult(state, {
      error: {
        type: "scope",
        subtype: "scope_drift",
        code: "IMPLEMENTATION_MANIFEST_UNAVAILABLE_AFTER_COMMIT",
        message: e?.message ?? String(e),
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
    return verificationRecoveryResult(state, {
      error: {
        type: "verification",
        subtype: "check_failed",
        code: "IMPLEMENTATION_CHANGED_AFTER_COMMIT",
        message: "Implementation paths or content changed during the commit step.",
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
      stage: "commit.publish",
      approval: { ...state.approval, commitRecovery } as typeof state.approval,
    };
    try {
      writeState(activeState);
    } catch (caught: any) {
      return commitResult("commit", {
        stage: "commit.publish",
        error: {
          type: "io",
          subtype: "io_failure",
          code: "COMMIT_RECOVERY_PERSIST_FAILED",
          message: "The verified commit was created but its recovery identity could not be persisted before push.",
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
  if (!p.ok) return commitResult("commit", { stage: "commit.publish", error: p.error, data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash } }, requires_user: true, stop_here: true, recovery: { strategy: "repair_and_retry", tool: "hy_commit", arguments: commitArguments }, allowedTools: ["hy_commit", "hy_status"] });

  const pr = createPr(root, commitArguments.title, body, baseBranch, state.branch, commitHash, repository);
  if (!pr.ok) return commitResult("commit", { stage: "commit.publish", error: pr.error, data: { executor: { commit: c.executor, resolveHead: resolvedHead.executor, push: p.executor, createPr: pr.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash }, push: { sha: p.hash } }, requires_user: true, stop_here: true, recovery: { strategy: "repair_and_retry", tool: "hy_commit", arguments: commitArguments }, allowedTools: ["hy_commit", "hy_status"] });

  activeState.prNumber = pr.prNumber ?? null;
  activeState.plan!.pr_number = activeState.prNumber;
  activeState.stage = "commit.ci";
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
    return commitResult("commit", {
      prNumber: activeState.prNumber,
      url: pr.url,
      reused: Boolean(pr.reused),
      error: ciResult.error,
      data: { executor: { commit: c.executor, push: p.executor, createPr: pr.executor, ci: ciResult.executor }, checks: ciResult.checks },
      requires_user: true,
      stop_here: true,
      stage: "commit.ci",
      status: "pending",
      allowedTools: ["hy_commit", "hy_status"],
      nextAction: { tool: "hy_commit", arguments: commitArguments, phase: "commit", stage: "commit.ci", automatic: false },
      control: { automatic: false, stop: true, reason: "wait_required" },
      userAction: { kind: "wait" },
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
    return commitResult("commit", {
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
        retryable: true,
      },
      requires_user: true,
      stop_here: true,
      stage: "commit.ci",
      status: "blocked",
      allowedTools: ["hy_commit", "hy_status"],
      blockedTools: ["hy_merge"],
      recovery: { strategy: "external_action", tool: "hy_commit", arguments: commitArguments },
      nextAction: { tool: "hy_commit", arguments: commitArguments, phase: "commit", stage: "commit.ci", automatic: false },
      control: { automatic: false, stop: true, reason: "external_action_required" },
      userAction: { kind: "external_action" },
    });
  }

  if (!ciResult.allGreen) {
    const checks = ciResult.checks || [];
    const failedNames = checks.filter((c: any) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c: any) => c.name);

    if (!failedNames.length) {
      return commitResult("commit", {
        prNumber: activeState.prNumber,
        url: pr.url,
        reused: Boolean(pr.reused),
        allGreen: false,
        pending: true,
        checks,
        timeoutSeconds,
        requires_user: true,
        stop_here: true,
        stage: "commit.ci",
        status: "pending",
        allowedTools: ["hy_commit", "hy_status"],
        blockedTools: ["hy_merge"],
        recovery: { strategy: "wait_and_retry", tool: "hy_commit", arguments: commitArguments },
        nextAction: { tool: "hy_commit", arguments: commitArguments, phase: "commit", stage: "commit.ci", automatic: false },
        control: { automatic: false, stop: true, reason: "wait_required" },
        userAction: { kind: "wait" },
      });
    }

    const editState = transition(activeState, "edit");
    writeState(editState);

    return commitResult("edit", {
      prNumber: activeState.prNumber,
      url: pr.url,
      allGreen: false,
      checks,
      failedChecks: failedNames,
      data: { executor: { commit: c.executor, push: p.executor, createPr: pr.executor, ci: ciResult.executor } },
      requires_user: true,
      stop_here: true,
      stage: "edit.implementation",
      status: "failed",
      allowedTools: ["hy_edit", "hy_verify", "hy_status"],
      blockedTools: ["hy_merge"],
      recovery: { strategy: "repair_and_retry", tool: "hy_edit" },
      nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }

  // CI all green — advance to merge
  const next = transition(activeState, "merge");
  next.stage = "merge.reconcile";
  writeState(next);

  return commitResult("merge", {
    stage: "merge.reconcile",
    status: "passed",
    prNumber: activeState.prNumber,
    url: pr.url,
    reused: Boolean(pr.reused),
    allGreen: true,
    data: { executor: { commit: c.executor, push: p.executor, createPr: pr.executor, ci: ciResult.executor }, stagedPaths: c.stagedPaths, commit: { action: commitAction, sha: commitHash }, push: { sha: p.hash }, checks: ciResult.checks, prAction: action },
    allowedTools: ["hy_merge", "hy_status"],
    nextAction: { tool: "hy_merge", phase: "merge", stage: "merge.reconcile", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
