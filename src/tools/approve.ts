import { createPlanApproval, documentReadHealth, planDecisionId, readState, writeState, transition, assertPhase } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

type ApprovalDecision = "approve" | "reject" | "revise";

function normalizeDecision(value: unknown): ApprovalDecision | null {
  if (typeof value !== "string") return null;
  const decision = value.trim().toLowerCase();
  return decision === "approve" || decision === "reject" || decision === "revise" ? decision : null;
}

export async function handleApprove(args: { approved: string; note?: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "approve");

  const input = typeof args.approved === "string" ? args.approved.trim() : "";
  const decision = normalizeDecision(args.approved);

  if (!decision) {
    return toolResult("approve", {
      approved: false,
      error: {
        type: "validation",
        subtype: "invalid_arguments",
        code: "APPROVAL_DECISION_INVALID",
        message: "Approval decision must be approve, reject, or revise.",
        hint: "Map the users existing decision to one enum value and retry hy_approve. Do not ask the user to approve again.",
        retryable: true,
      },
      stage: "approve.decision",
      status: "failed",
      hint: "Retry hy_approve with approved set to approve, reject, or revise. The current PlanDoc and any existing approval are unchanged.",
      requires_user: false,
      stop_here: false,
      allowedTools: ["hy_approve", "hy_status"],
      nextAction: { tool: "hy_approve", phase: "approve", stage: "approve.decision", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }

  if (decision === "approve") {
    if (!state.plan) {
      return toolResult("approve", { error: "No active PlanDoc to approve.", allowedTools: ["hy_status"] });
    }
    const health = documentReadHealth(state);
    if (!health.okForApprove) {
      return toolResult("approve", {
        approved: false,
        approvalPending: true,
        error: "before_approve document audit is required before hy_approve can accept user approval.",
        documentReadHealth: health,
        hint: `${health.gates.beforeApprove.reason} Call hy_read_docs with { stage: "before_approve" } first. This is an automatic agent audit step, not a separate user review gate.`,
        stage: "approve.before_approve",
        status: "running",
        allowedTools: ["hy_read_docs", "hy_status"],
        blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
        nextAction: { tool: "hy_read_docs", arguments: { stage: "before_approve" }, phase: "approve", stage: "before_approve", automatic: true },
        control: { automatic: true, stop: false, reason: "automatic" },
        userAction: null,
      });
    }

    const approval = createPlanApproval(state.plan, args.note ?? "", state.approval);
    const next = transition(state, "branch");
    next.approval = approval;
    writeState(next);
    return toolResult("branch", {
      approved: true,
      plan: state.plan?.task,
      pipeline: [
        { step: "hy_branch",  description: "create branch" },
        { step: "hy_edit",      description: "lock scope" },
        { step: "edit files",   description: "write code" },
        { step: "hy_read_docs", description: "run after_edit document audit" },
        { step: "hy_sync_docs", description: "confirm documentation sync gate" },
        { step: "hy_verify",    description: "run lint + compile + scope + boundary + tests" },
        { step: "hy_commit",  description: "create PR and wait for CI" },
        { step: "hy_merge",   description: "merge PR into baseBranch and synchronize downstream branches" },
        { step: "hy_reset",   description: "reset workflow to plan" },
      ],
      stopAfter: "hy_reset",
      resumeAfter: "任务完成标准为 PR 合并到 baseBranch、下游同步完成并 hy_reset 回到 plan；除工具返回明确的 userAction 或不可自动恢复错误外，不要中途停下。",
      hint: "Proceed through the returned pipeline in order until stopAfter. The users single plan approval covers every automatic step while the PlanDoc hash remains unchanged.",
      decisionId: approval.decisionId,
      stage: "branch.create",
      status: "passed",
      allowedTools: ["hy_branch", "hy_status"],
      blockedTools: ["hy_edit", "hy_verify", "hy_commit", "hy_merge"],
      recovery: {
        tool: "hy_branch",
        instruction: "Create a branch next, then lock scope with hy_edit before editing files.",
      },
      nextAction: { tool: "hy_branch", phase: "branch", stage: "branch.create", automatic: true },
      control: { automatic: true, stop: false, reason: "automatic" },
      userAction: null,
    });
  }

  // Rejection/revision is explicit. Unknown text above never mutates state.
  const next = transition(state, "plan");
  next.approval = null;
  next.verifyHash = null;
  next.verifiedImplementationDigest = null;
  next.verifiedManifestHash = null;
  next.pendingAmendment = null;
  next.implementationManifest = null;
  next.syncDocs = null;
  writeState(next);
  return toolResult("plan", {
    approved: false,
    decision,
    decisionId: planDecisionId(state.plan),
    note: input,
    message: decision === "reject" ? "Plan rejected." : "Plan revision requested.",
    hint: "Do not continue the prior pipeline. Revise the PlanDoc and call hy_plan again only if the user wants to proceed.",
    stage: "plan.compose",
    status: "ready",
    allowedTools: ["hy_plan", "hy_status"],
    blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
    nextAction: { tool: "hy_plan", phase: "plan", stage: "plan.compose", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: { kind: "provide_information", instruction: "Provide the requested plan changes before replanning." },
  });
}
