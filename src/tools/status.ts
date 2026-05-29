import { readState } from "../state.js";
import type { ToolResult } from "./_base.js";

export async function handleStatus(): Promise<ToolResult> {
  const state = readState();
  return {
    phase: state.phase,
    branch: state.branch,
    prNumber: state.prNumber,
    plan: state.plan?.task ?? null,
    approved: state.approval !== null,
    verified: state.verifyHash !== null,
    next: state.phase,
  };
}
