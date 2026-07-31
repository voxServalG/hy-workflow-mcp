import { readState, writeState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

/** Recovery tool: reset workflow state to plan from any phase. */
export async function handleReset(): Promise<ToolResult> {
  const state = readState();

  state.phase = "plan";
  state.stage = "plan.before_plan";
  state.branch = null;
  state.prNumber = null;
  state.plan = null;
  state.approval = null;
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
    display: {
      title: "Workflow reset",
      body: "Workflow state was reset to plan phase.",
    },
    hint: "Start a new task with hy_plan only when the user requests a repository change.",
    allowedTools: ["hy_plan", "hy_status"],
    nextAction: { tool: "hy_read_docs", arguments: { stage: "before_plan" }, phase: "plan", stage: "before_plan", automatic: false },
    control: { automatic: false, stop: true, reason: "completed" },
    userAction: null,
    message: "Reset to plan phase. Run hy_plan to start a new task.",
  });
}
