import { readState, writeState, transition, assertPhase } from "../state.js";
import { checkCi } from "../git.js";
import type { ToolResult } from "./_base.js";

export async function handleCi(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "ci", "edit"); // edit = fix, ci = re-check

  if (!state.prNumber) return { next: "ci", error: "No active PR" };

  const result = checkCi(state.prNumber);
  if (!result.ok) return { next: "ci", error: result.error, checks: result.checks };

  if (!result.allGreen) {
    return {
      next: "edit",
      allGreen: false,
      checks: result.checks,
      message: "CI checks not all green. Fix issues, push, and re-run hy_ci.",
    };
  }

  const next = transition(state, "merge");
  writeState(next);

  return {
    next: "merge",
    allGreen: true,
    checks: result.checks,
    message: "All CI checks passed. Ready to merge.",
  };
}
