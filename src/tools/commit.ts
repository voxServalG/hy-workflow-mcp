import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch, computePlanHash, type PlanDoc } from "../state.js";
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
