import { readState, writeState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleReset(): Promise<ToolResult> {
  const state = readState();

  state.phase = "plan";
  state.branch = null;
  state.prNumber = null;
  state.plan = null;
  state.approval = null;
  state.verifyHash = null;
  state.verifiedImplementationDigest = null;
  state.verifiedManifestHash = null;
  state.pendingAmendment = null;
  state.implementationManifest = null;
  state.documentReads = null;
  state.syncDocs = null;

  writeState(state);

  return toolResult("plan", {
    display: {
      title: "Workflow reset",
      body: "Workflow state was reset to plan phase.",
    },
    hint: "Start a new task with hy_plan only when the user requests a repository change.",
    allowedTools: ["hy_plan", "hy_status"],
    message: "Reset to plan phase. Run hy_plan to start a new task.",
  });
}
