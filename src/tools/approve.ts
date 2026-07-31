import { computePlanHash, createPlanApproval, documentReadHealth, planDecisionId, pendingApprovalMatchesPlan, readState, writeState, transition, assertPhase } from "../state.js";
import { invalidWorkflowStateResult, toolResult, type ToolResult } from "./_base.js";

type ApprovalDecision = "approve" | "reject" | "revise";
type ApprovalAuditDecision = "continue" | "replan";

function normalizeDecision(value: unknown): ApprovalDecision | null {
  if (typeof value !== "string") return null;
  const decision = value.trim().toLowerCase();
  return decision === "approve" || decision === "reject" || decision === "revise" ? decision : null;
}

function normalizeAuditDecision(value: unknown): ApprovalAuditDecision | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return null;
  const decision = value.trim().toLowerCase();
  return decision === "continue" || decision === "replan" ? decision : null;
}

export async function handleApprove(args: { approved: string; note?: string; auditDecision?: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "approve");
  const currentStage = state.stage ?? "approve.decision";

  const input = typeof args.approved === "string" ? args.approved.trim() : "";
  const decision = normalizeDecision(args.approved);
  const auditDecision = normalizeAuditDecision(args.auditDecision);

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
      stage: currentStage,
      status: "failed",
      hint: "Retry hy_approve with approved set to approve, reject, or revise. The current PlanDoc and any existing approval are unchanged.",
      requires_user: false,
      stop_here: true,
      allowedTools: ["hy_approve", "hy_status"],
      nextAction: { tool: null, phase: "approve", stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "repair_required" },
      userAction: null,
    });
  }

  if (args.auditDecision !== undefined && !auditDecision) {
    return toolResult("approve", {
      approved: false,
      error: {
        type: "validation",
        subtype: "invalid_arguments",
        code: "APPROVAL_AUDIT_DECISION_INVALID",
        message: "Approval audit decision must be continue or replan.",
        hint: "Use continue only when document drift does not materially change intent, scope, verification, or risk; otherwise use replan.",
        retryable: true,
      },
      stage: state.stage ?? "approve.decision",
      status: "failed",
      allowedTools: ["hy_approve", "hy_status"],
      nextAction: { tool: null, phase: "approve", stage: state.stage ?? "approve.decision", automatic: false },
      control: { automatic: false, stop: true, reason: "repair_required" },
      userAction: null,
    });
  }

  if (decision === "approve") {
    if (!state.plan) {
      return invalidWorkflowStateResult(
        state,
        "APPROVAL_PLAN_MISSING",
        "Workflow state reached approval without an active PlanDoc.",
        "Reset the impossible workflow state, then create and approve a new PlanDoc.",
      );
    }
    const health = documentReadHealth(state);
    if (!health.okForApprove) {
      if (auditDecision) {
        return toolResult("approve", {
          approved: false,
          error: {
            type: "validation",
            subtype: "invalid_arguments",
            code: "APPROVAL_AUDIT_NOT_READY",
            message: "auditDecision is valid only after the before_approve audit is current.",
            hint: "Submit the users approval without auditDecision first; the tool will preserve it and route the automatic audit.",
            retryable: true,
          },
          stage: currentStage,
          status: "failed",
          allowedTools: ["hy_approve", "hy_status"],
          nextAction: { tool: null, phase: "approve", stage: currentStage, automatic: false },
          control: { automatic: false, stop: true, reason: "repair_required" },
          userAction: null,
        });
      }
      const planHash = computePlanHash(state.plan)!;
      state.pendingApproval = {
        time: new Date().toISOString(),
        note: args.note ?? "",
        decisionId: `plan:${planHash}`,
        planHash,
      };
      state.stage = "approve.before_approve";
      writeState(state);
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
        nextAction: { tool: "hy_read_docs", arguments: { stage: "before_approve" }, phase: "approve", stage: "approve.before_approve", automatic: true },
        control: { automatic: true, stop: false, reason: "automatic" },
        userAction: null,
      });
    }

    const changedSinceBaseline = state.documentReads?.beforeApprove?.changedSinceBaseline === true;
    if (changedSinceBaseline && !auditDecision) {
      return toolResult("approve", {
        approved: false,
        approvalPending: true,
        error: {
          type: "workflow_state",
          subtype: "evidence_stale",
          code: "APPROVAL_AUDIT_DECISION_REQUIRED",
          message: "before_approve found document drift and requires an agent audit decision.",
          hint: "Call hy_approve with auditDecision=continue only if the PlanDoc remains materially unchanged; otherwise use auditDecision=replan. Do not ask the user to approve the same PlanDoc again.",
        },
        stage: "approve.before_approve",
        status: "pending",
        allowedTools: ["hy_approve", "hy_status"],
        blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
        nextAction: { tool: null, phase: "approve", stage: "approve.before_approve", automatic: false },
        control: { automatic: false, stop: true, reason: "review_required" },
        userAction: null,
      });
    }

    if (auditDecision === "replan") {
      const task = state.plan.task;
      const next = transition(state, "plan");
      next.plan = null;
      next.approval = null;
      next.pendingApproval = null;
      next.documentReads = null;
      next.syncDocs = null;
      next.pendingAmendment = null;
      next.implementationManifest = null;
      next.verifyHash = null;
      next.verifiedImplementationDigest = null;
      next.verifiedManifestHash = null;
      writeState(next);
      return toolResult("plan", {
        approved: false,
        auditDecision: "replan",
        stage: "plan.before_plan",
        status: "ready",
        display: {
          title: "Plan facts changed materially",
          body: "The saved user approval was not applied to changed intent. Refresh the document baseline and construct a new PlanDoc.",
        },
        hint: "Automatically refresh before_plan for the same task, then build and display a new PlanDoc. Only the new PlanDoc requires a new user approval.",
        allowedTools: ["hy_read_docs", "hy_status"],
        blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
        nextAction: { tool: "hy_read_docs", arguments: { stage: "before_plan", task }, phase: "plan", stage: "plan.before_plan", automatic: true },
        control: { automatic: true, stop: false, reason: "automatic" },
        userAction: null,
      });
    }

    const pendingNote = pendingApprovalMatchesPlan(state.pendingApproval, state.plan)
      ? state.pendingApproval?.note ?? ""
      : "";
    const approval = createPlanApproval(state.plan, args.note ?? pendingNote, state.approval);
    const next = transition(state, "branch");
    next.approval = approval;
    next.pendingApproval = null;
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
      nextAction: { tool: null, phase: "branch", stage: "branch.create", automatic: false },
      control: { automatic: false, stop: true, reason: "information_required" },
      userAction: null,
    });
  }

  // Rejection/revision is explicit. Unknown text above never mutates state.
  const next = transition(state, "plan");
  next.approval = null;
  next.pendingApproval = null;
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
    nextAction: { tool: null, phase: "plan", stage: "plan.compose", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: { kind: "provide_information", instruction: "Provide the requested plan changes before replanning." },
  });
}
