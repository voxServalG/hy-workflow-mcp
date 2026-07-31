import { readState, writeState, transition, assertPhase, type WorkflowState } from "../state.js";
import { DEFAULT_STAGE_BY_PHASE } from "../runtime/state-machine.js";
import { toolResult as buildToolResult, structuredFailureResult } from "../output/envelope.js";
import type { ToolResult } from "../output/envelope.js";

export type { ToolResult } from "../output/envelope.js";
export { buildToolResult as toolResult, structuredFailureResult };

export { readState, writeState, transition, assertPhase };

export function invalidWorkflowStateResult(
  state: WorkflowState,
  code: string,
  message: string,
  hint: string,
): ToolResult {
  const stage = state.stage ?? DEFAULT_STAGE_BY_PHASE[state.phase];
  return buildToolResult(state.phase, {
    phase: state.phase,
    stage,
    error: {
      type: "workflow_state",
      subtype: "invalid_phase",
      code,
      message,
      hint,
    },
    hint,
    allowedTools: ["hy_reset", "hy_status"],
    blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_amend_plan", "hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
    recovery: { strategy: "reset", tool: "hy_reset", instruction: hint },
    nextAction: { tool: "hy_reset", phase: state.phase, stage, automatic: false },
    control: { automatic: false, stop: true, reason: "review_required" },
    userAction: { kind: "review_failure", instruction: hint },
  });
}
