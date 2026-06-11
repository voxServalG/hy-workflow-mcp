import { readState, writeState, transition, assertPhase } from "../state.js";
import { mergePr } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleMerge(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "merge");

  if (!state.prNumber) return toolResult("merge", { error: "No active PR", allowedTools: ["hy_status"] });

  const result = mergePr(state.prNumber);
  if (!result.ok) return toolResult("merge", { error: result.error, requires_user: true, stop_here: true, recovery: { tool: "hy_merge", instruction: "Inspect the merge failure, resolve blockers, then retry hy_merge if the approved workflow is still valid." }, allowedTools: ["hy_merge", "hy_status"] });

  const next = transition(state, "chain");
  writeState(next);

  return toolResult("chain", {
    prNumber: state.prNumber,
    display: {
      title: "Pull request merged",
      body: `PR #${state.prNumber} merged.`,
    },
    hint: "Continue to hy_chain. Pass an empty branches list if there are no downstream branches, then call hy_reset to return to plan.",
    allowedTools: ["hy_chain", "hy_status"],
    message: `PR #${state.prNumber} merged. Call hy_chain to rebase downstream branches, then hy_reset.`,
  });
}
