import { readState, writeState, transition, assertPhase } from "../state.js";
import { mergePr } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleMerge(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "merge");

  if (!state.prNumber) return toolResult("merge", { error: "No active PR", allowedTools: ["hy_status"] });

  const result = mergePr(state.prNumber);
  if (!result.ok) return toolResult("merge", { error: result.error, recovery: { tool: "hy_merge", instruction: "Inspect the merge failure, resolve blockers, then retry hy_merge only after user confirmation remains valid." }, allowedTools: ["hy_merge", "hy_status"] });

  const next = transition(state, "chain");
  writeState(next);

  return toolResult("chain", {
    prNumber: state.prNumber,
    display: {
      title: "Pull request merged",
      body: `PR #${state.prNumber} merged.`,
    },
    hint: "Call hy_chain if there are downstream branches that need rebasing; otherwise the workflow can stop here.",
    allowedTools: ["hy_chain", "hy_status"],
    message: `PR #${state.prNumber} merged. Call hy_chain to rebase downstream branches.`,
  });
}
