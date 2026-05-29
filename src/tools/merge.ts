import { readState, writeState, transition, assertPhase } from "../state.js";
import { mergePr } from "../git.js";
import type { ToolResult } from "./_base.js";

export async function handleMerge(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "merge");

  if (!state.prNumber) return { next: "merge", error: "No active PR" };

  const result = mergePr(state.prNumber);
  if (!result.ok) return { next: "merge", error: result.error };

  const next = transition(state, "chain");
  writeState(next);

  return { next: "chain", prNumber: state.prNumber, message: `PR #${state.prNumber} merged.` };
}
