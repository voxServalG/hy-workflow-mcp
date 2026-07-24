import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch } from "../state.js";
import { mergePr, checkout, pull, rebaseDev, pushForce, listLocalBranches } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

const AGENT_BRANCH_PREFIXES = ["fix/", "feat/", "chore/", "docs/", "refactor/", "test/"];

function chainFailure(step: string, branch: string, error: unknown, done: string[], executor?: unknown): ToolResult {
  return toolResult("merge", {
    error: typeof error === "string" ? `${step} failed for ${branch}: ${error}` : error,
    data: { executor },
    done,
    requires_user: true,
    stop_here: true,
    recovery: { tool: "hy_merge", instruction: "Resolve the git failure, then manually rebase the remaining downstream branches." },
    allowedTools: ["hy_merge", "hy_status"],
  });
}

export async function handleMerge(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "merge");

  if (!state.prNumber) return toolResult("merge", { error: "No active PR", allowedTools: ["hy_status"] });

  const root = projectRoot();
  const result = mergePr(root, state.prNumber);
  if (!result.ok) return toolResult("merge", { error: result.error, data: { executor: result.executor }, requires_user: true, stop_here: true, recovery: { tool: "hy_merge", instruction: "Inspect the merge failure, resolve blockers, then retry hy_merge if the approved workflow is still valid." }, allowedTools: ["hy_merge", "hy_status"] });

  // ── Auto-rebase downstream Agent branches (absorbed from chain.ts) ──
  const rebased: string[] = [];
  const base = getBaseBranch(root);

  const baseCheckout = checkout(root, base);
  if (!baseCheckout.ok) return chainFailure("checkout", base, baseCheckout.error, rebased, baseCheckout.executor);

  const pullBase = pull(root);
  if (!pullBase.ok) return chainFailure("pull", base, pullBase.error, rebased, pullBase.executor);

  const allBranches = listLocalBranches(root);
  const downstream = allBranches.filter(br => br !== base && AGENT_BRANCH_PREFIXES.some(p => br.startsWith(p)));
  for (const br of downstream) {
    const branchCheckout = checkout(root, br);
    if (!branchCheckout.ok) return chainFailure("checkout", br, branchCheckout.error, rebased, branchCheckout.executor);

    const r = rebaseDev(root);
    if (!r.ok) return chainFailure("rebase", br, r.error, rebased, r.executor);

    const pushed = pushForce(root, br);
    if (!pushed.ok) return chainFailure("push", br, pushed.error, rebased, pushed.executor);

    rebased.push(`${br}: rebased + pushed`);
  }

  if (rebased.length) {
    const finalCheckout = checkout(root, base);
    if (!finalCheckout.ok) return chainFailure("checkout", base, finalCheckout.error, rebased, finalCheckout.executor);
  }

  const next = transition(state, "done");
  writeState(next);

  return toolResult("done", {
    prNumber: state.prNumber,
    done: rebased,
    data: { executor: result.executor },
    display: {
      title: "Pull request merged and downstream branches synced",
      body: rebased.length
        ? `PR #${state.prNumber} merged. Rebased ${rebased.length} downstream branches.`
        : `PR #${state.prNumber} merged.`,
    },
    hint: "Workflow is complete. No further hy-workflow tool is required unless starting a new task with hy_plan.",
    allowedTools: ["hy_plan", "hy_status"],
    message: `PR #${state.prNumber} merged. ${rebased.length ? `Rebased ${rebased.length} downstream branches. ` : ""}Workflow complete.`,
  });
}
