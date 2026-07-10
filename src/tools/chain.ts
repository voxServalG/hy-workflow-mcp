import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch } from "../state.js";
import { checkout, pull, rebaseDev, pushForce } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

function chainFailure(step: string, branch: string, error: unknown, done: string[], executor?: unknown): ToolResult {
  return toolResult("chain", {
    error: typeof error === "string" ? `${step} failed for ${branch}: ${error}` : error,
    data: { executor },
    done,
    requires_user: true,
    stop_here: true,
    recovery: { tool: "hy_chain", instruction: "Resolve the git failure, then rerun hy_chain for the remaining downstream branches." },
    allowedTools: ["hy_chain", "hy_status"],
    blockedTools: ["hy_reset"],
  });
}

export async function handleChain(args: { branches: string[] }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "chain");

  const root = projectRoot();
  const results: string[] = [];

  const base = getBaseBranch(root);

  const baseCheckout = checkout(root, base);
  if (!baseCheckout.ok) return chainFailure("checkout", base, baseCheckout.error, results, baseCheckout.executor);

  const pullBase = pull(root);
  if (!pullBase.ok) return chainFailure("pull", base, pullBase.error, results, pullBase.executor);

  for (const br of args.branches) {
    const branchCheckout = checkout(root, br);
    if (!branchCheckout.ok) return chainFailure("checkout", br, branchCheckout.error, results, branchCheckout.executor);

    const r = rebaseDev(root);
    if (!r.ok) return chainFailure("rebase", br, r.error, results, r.executor);

    const pushed = pushForce(root, br);
    if (!pushed.ok) return chainFailure("push", br, pushed.error, results, pushed.executor);

    results.push(`${br}: rebased + pushed`);
  }

  const finalCheckout = checkout(root, base);
  if (!finalCheckout.ok) return chainFailure("checkout", base, finalCheckout.error, results, finalCheckout.executor);

  const next = transition(state, "done");
  writeState(next);

  return toolResult("done", {
    done: results,
    data: { executor: finalCheckout.executor },
    display: {
      title: "Workflow complete",
      body: `Rebased ${results.length} downstream branches.`,
    },
    hint: "Workflow is complete. No further hy-workflow tool is required unless starting a new task.",
    allowedTools: ["hy_status"],
    message: `Rebased ${results.length} branches. Workflow complete. All downstream branches synced.`,
  });
}
