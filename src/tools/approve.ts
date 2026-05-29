import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { Approval } from "../state.js";

export async function handleApprove(args: { approved: boolean; note?: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "plan", "approve");

  if (!args.approved) {
    // User rejected → back to plan
    const next = transition(state, "plan");
    next.approval = { time: new Date().toISOString(), note: args.note ?? "Rejected by user" };
    writeState(next);
    return { next: "plan", approved: false, note: args.note };
  }

  // User approved
  const approval: Approval = { time: new Date().toISOString(), note: args.note ?? "Approved" };
  const next = transition(state, "branch");
  next.approval = approval;
  writeState(next);

  return { next: "branch", approved: true, plan: state.plan?.task };
}
