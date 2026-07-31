import { computePlanHash, createPlanApproval, documentReadHealth, planDecisionId, pendingApprovalMatchesPlan, readState, writeState, transition, assertPhase } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

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

export async function handleApprove(args: { approved: string; decisionId?: string; note?: string; auditDecision?: string }): Promise<ToolResult> {
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
        retryable: true,
      },
      stage: currentStage,
      status: "failed",
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

  const expectedDecisionId = planDecisionId(state.plan);
  if (expectedDecisionId && args.decisionId !== expectedDecisionId) {
    return toolResult("approve", {
      approved: false,
      decisionId: expectedDecisionId,
      error: {
        type: "validation",
        subtype: "stale_decision",
        code: "APPROVAL_DECISION_ID_MISMATCH",
        message: "Approval decision identity does not match the current PlanDoc.",
        detail: {
          expectedDecisionId,
          actualDecisionId: typeof args.decisionId === "string" ? args.decisionId : null,
        },
        retryable: true,
      },
      stage: currentStage,
      status: "failed",
      allowedTools: ["hy_approve", "hy_status"],
      blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
      nextAction: { tool: null, phase: "approve", stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "approval_required" },
      userAction: {
        kind: "approval",
        decisionId: expectedDecisionId,
        options: ["approve", "reject", "revise"],
      },
    });
  }

  if (decision === "approve") {
    if (!state.plan) {
      return toolResult("approve", {
        approved: false,
        error: {
          type: "workflow_state",
          subtype: "approval_missing",
          code: "APPROVAL_PLAN_MISSING",
          message: "Workflow state reached approval without an active PlanDoc.",
        },
        stage: currentStage,
        status: "blocked",
        allowedTools: ["hy_reset", "hy_status"],
        blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
        nextAction: { tool: "hy_reset", phase: "approve", stage: currentStage, automatic: false },
        control: { automatic: false, stop: true, reason: "repair_required" },
        userAction: { kind: "review_failure" },
      });
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
        decisionId: expectedDecisionId ?? `plan:${planHash}`,
        planHash,
      };
      state.stage = "approve.before_approve";
      writeState(state);
      return toolResult("approve", {
        approved: false,
        approvalPending: true,
        error: "before_approve document audit is required before hy_approve can accept user approval.",
        documentReadHealth: health,
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
    stage: "plan.compose",
    status: "ready",
    allowedTools: ["hy_plan", "hy_status"],
    blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
    nextAction: { tool: null, phase: "plan", stage: "plan.compose", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: { kind: "provide_information" },
  });
}
