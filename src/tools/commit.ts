import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch } from "../state.js";
import { commitScope, push, createPr } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleCommit(args: { title: string; body: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "commit");

  if (!state.plan) return toolResult("commit", { error: "No plan", allowedTools: ["hy_status"] });
  if (!state.verifyHash) return toolResult("commit", { error: "Missing verifyHash", hint: "Run hy_verify successfully before hy_commit.", allowedTools: ["hy_verify", "hy_status"] });
  if (!state.branch) return toolResult("commit", { error: "No active branch", allowedTools: ["hy_status"] });

  const root = projectRoot();

  // Build enhanced PR body with plan context
  const body = [
    args.body,
    "",
    "---",
    "",
    "**Scope**",
    `- Changes: ${state.plan.scope.changes.join(", ") || "none"}`,
    `- New files: ${state.plan.scope.new_files.join(", ") || "none"}`,
    `- Delete: ${state.plan.scope.delete.join(", ") || "none"}`,
    "",
    "**Boundary**",
    `- Entry points: ${state.plan.boundary.entry_points.length} checks`,
    `- No new deps: ${state.plan.boundary.no_new_external}`,
    "",
    "**Verify**",
    `- smoke: ${state.plan.verify.smoke.length} checks, tests: ${state.plan.verify.tests.length} checks`,
    `- hash: \`${state.verifyHash}\``,
  ].join("\n");

  const c = commitScope(root, state.plan.scope, args.title, body);
  if (!c.ok) return toolResult("commit", { error: c.error, recovery: { tool: "hy_commit", instruction: "Fix the commit error, then retry hy_commit without changing files unless necessary." }, allowedTools: ["hy_commit", "hy_status"] });

  const p = push(root, state.branch);
  if (!p.ok) return toolResult("commit", { error: p.error, recovery: { tool: "hy_commit", instruction: "Resolve the push failure, then retry or manually recover the already-created local commit if needed." }, allowedTools: ["hy_commit", "hy_status"] });

  const pr = createPr(root, args.title, body, getBaseBranch(root), state.branch);
  if (!pr.ok) return toolResult("commit", { error: pr.error, recovery: { tool: "hy_commit", instruction: "Resolve the PR creation failure. If the branch is already pushed, create the PR without recommitting only with user approval." }, allowedTools: ["hy_commit", "hy_status"] });

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
    stop_here: true,
    hint: "Show the PR URL to the user. The default workflow stops after hy_commit; only continue to hy_ci if the user asks.",
    allowedTools: ["hy_ci", "hy_status"],
    blockedTools: ["hy_merge", "hy_chain"],
    message: `PR #${pr.prNumber} created. Waiting for CI...`,
  });
}
