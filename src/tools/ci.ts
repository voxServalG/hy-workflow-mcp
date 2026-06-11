import { readState, writeState, transition, assertPhase } from "../state.js";
import { checkCi } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleCi(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "ci", "edit"); // edit = fix, ci = re-check

  if (!state.prNumber) return toolResult("ci", { phase: state.phase, error: "No active PR", allowedTools: ["hy_status"] });

  const result = checkCi(state.prNumber);
  if (!result.ok) return toolResult("ci", { error: result.error, checks: result.checks, recovery: { tool: "hy_ci", instruction: "Inspect the CI query error and retry hy_ci after the GitHub/API issue is resolved." }, allowedTools: ["hy_ci", "hy_status"] });

  if (!result.allGreen) {
    const failedNames = (result.checks || []).filter((c: any) => c.status !== "pass").map((c: any) => c.name);

    const next = transition(state, "edit");
    writeState(next);

    return toolResult("edit", {
      allGreen: false,
      checks: result.checks,
      failedChecks: failedNames,
      hint: "CI is not green. Read failed checks before editing. After fixes, run hy_verify, hy_commit, then hy_ci again.",
      allowedTools: ["hy_edit", "hy_verify", "hy_status"],
      blockedTools: ["hy_merge", "hy_chain"],
      recovery: {
        tool: "hy_edit",
        instruction: "Fix CI failures locally, rerun hy_verify, create a new commit with hy_commit, then rerun hy_ci.",
      },
      message: `CI not all green. Failed: ${failedNames.join(", ")}. Fix issues, push, and re-run hy_ci.`,
    });
  }

  const next = transition(state, "merge");
  writeState(next);

  return toolResult("merge", {
    allGreen: true,
    checks: result.checks,
    requires_user: true,
    stop_here: true,
    display: {
      title: "CI passed. Merge confirmation required.",
      body: `All CI checks passed for PR #${state.prNumber}. Confirm before merging.`,
    },
    hint: "Show CI status to the user. Do not call hy_merge until the user explicitly confirms merge.",
    allowedTools: ["hy_merge", "hy_status"],
    blockedTools: ["hy_chain"],
    message: "All CI checks passed. Ready to merge.",
  });
}
