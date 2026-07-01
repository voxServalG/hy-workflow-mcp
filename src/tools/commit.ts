import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch, computeImplementationDigest, computeImplementationManifestHash, computePlanHash, computeVerifyHash, currentBranch, type PlanDoc } from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { commitScope, push, createPr } from "../git.js";
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

  const body = buildCommitBody({ body: args.body, plan: state.plan, verifyHash: state.verifyHash });

  const c = commitScope(root, state.plan.scope, args.title, body);
  if (!c.ok) return toolResult("commit", { error: c.error, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Fix the commit error, then retry hy_commit without changing files unless necessary." }, allowedTools: ["hy_commit", "hy_status"] });

  const p = push(root, state.branch);
  if (!p.ok) return toolResult("commit", { error: p.error, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Resolve the push failure, then retry or manually recover the already-created local commit if needed." }, allowedTools: ["hy_commit", "hy_status"] });

  const pr = createPr(root, args.title, body, getBaseBranch(root), state.branch);
  if (!pr.ok) return toolResult("commit", { error: pr.error, requires_user: true, stop_here: true, recovery: { tool: "hy_commit", instruction: "Resolve the PR creation failure. If the branch is already pushed, create the PR without recommitting only with user approval." }, allowedTools: ["hy_commit", "hy_status"] });

  const next = transition(state, "ci");
  next.prNumber = pr.prNumber ?? null;
  next.plan!.pr_number = next.prNumber;
  writeState(next);

  return toolResult("ci", {
    prNumber: pr.prNumber,
    url: pr.url,
    display: {
      title: "Pull request created",
      body: `PR #${pr.prNumber} created.`,
      urls: pr.url ? [pr.url] : [],
    },
    hint: "Show the PR URL briefly, then continue to hy_ci. Do not stop here unless a later tool reports CI or merge problems.",
    allowedTools: ["hy_ci", "hy_status"],
    blockedTools: ["hy_merge", "hy_chain"],
    message: `PR #${pr.prNumber} created. Waiting for CI...`,
  });
}
