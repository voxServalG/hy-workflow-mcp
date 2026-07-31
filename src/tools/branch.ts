import { approvalMatchesPlan, readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { createBranch, invalidTopicError, isSafeBranchTopic } from "../git.js";
import { invalidWorkflowStateResult, toolResult, type ToolResult } from "./_base.js";

export async function handleBranch(args: { category: string; topic: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "approve", "branch");
  const currentStage = state.stage ?? (state.phase === "approve" ? "approve.decision" : "branch.create");

  if (!state.plan) {
    return invalidWorkflowStateResult(
      state,
      "PLAN_MISSING",
      "Workflow state does not contain the PlanDoc required to create a branch.",
      "Reset the invalid workflow state, then create and approve a new PlanDoc before retrying hy_branch.",
    );
  }
  if (!approvalMatchesPlan(state.approval, state.plan)) {
    return invalidWorkflowStateResult(
      state,
      "APPROVAL_PLAN_MISMATCH",
      "The persisted approval does not match the current PlanDoc.",
      "Reset the invalid workflow state before creating a new approved PlanDoc.",
    );
  }

  const validCategories = ["refactor", "feat", "chore", "docs", "ci", "fix", "test"];
  if (!validCategories.includes(args.category)) {
    return toolResult(state.phase, { phase: state.phase, stage: currentStage, error: `Invalid category. Use: ${validCategories.join(", ")}`, allowedTools: ["hy_branch", "hy_status"] });
  }
  if (!isSafeBranchTopic(args.topic)) {
    return toolResult(state.phase, { phase: state.phase, stage: currentStage, error: invalidTopicError(args.topic), allowedTools: ["hy_branch", "hy_status"] });
  }

  const root = projectRoot();
  const attemptState = state.phase === "approve" ? transition(state, "branch") : { ...state };
  attemptState.stage = "branch.create";
  if (state.phase === "approve") writeState(attemptState);
  const result = createBranch(root, args.category, args.topic);
  if (!result.ok) {
    return toolResult(attemptState.phase, {
      phase: attemptState.phase,
      stage: attemptState.stage,
      error: result.error ? {
        type: result.error.type,
        subtype: result.error.subtype,
        code: result.error.code,
        message: result.error.message,
        detail: result.error.detail,
        cause: result.error.cause,
        retryable: result.error.retryable,
      } : undefined,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_branch", "hy_status"],
      blockedTools: ["hy_edit", "hy_verify", "hy_commit", "hy_merge"],
      recovery: {
        strategy: "repair_and_retry",
        tool: "hy_branch",
        arguments: { category: args.category, topic: args.topic },
      },
      userAction: { kind: "fix_configuration" },
    });
  }

  const next = transition(attemptState, "edit");
  next.stage = "edit.scope";
  next.branch = result.branch;
  next.plan!.branch = result.branch;
  writeState(next);

  return toolResult("edit", {
    branch: result.branch,
    stage: "edit.scope",
    status: "passed",
    allowedTools: ["hy_edit", "hy_status"],
    blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.scope", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
