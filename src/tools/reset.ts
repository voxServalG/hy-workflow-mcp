import { createInitialWorkflowState, readState, writeState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

/** Recovery tool: reset workflow state to plan from any phase. */
export async function handleReset(): Promise<ToolResult> {
  let state;
  try {
    state = readState();
  } catch {
    state = createInitialWorkflowState();
  }

  state.phase = "plan";
  state.stage = "plan.before_plan";
  state.branch = null;
  state.prNumber = null;
  state.plan = null;
  state.approval = null;
  state.pendingApproval = null;
  state.verifiedImplementationDigest = null;
  state.pendingAmendment = null;
  state.implementationManifest = null;
  state.documentReads = null;
  state.syncDocs = null;
  state.mergeReceipt = null;

  writeState(state);

  return toolResult("plan", {
    stage: "plan.before_plan",
    status: "completed",
    allowedTools: ["hy_read_docs", "hy_plan", "hy_status"],
    nextAction: {
      tool: null,
      phase: "plan",
      stage: "plan.before_plan",
      automatic: false,
    },
    control: { automatic: false, stop: true, reason: "completed" },
    userAction: null,
  });
}
