import * as fs from "node:fs";
import * as path from "node:path";
import { amendmentDecisionId, approvalMatchesPlan, assertPhase, createPlanApproval, projectRoot, readState, scopePath, transition, writeState, type PendingPlanAmendment, type PlanDoc } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { normalizePlanScopeAmendment, validateAmendmentPaths, validatePlanScopePaths } from "../plan_validation.js";

type AmendPlanArgs = {
  approved: string;
  decisionId?: string;
  note?: string;
};

function mergeList(current: string[], add: string[], remove: string[]): string[] {
  const removeSet = new Set(remove);
  const result = current.filter(item => !removeSet.has(item));
  for (const item of add) {
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

export function applyAmendment(plan: PlanDoc, amendment: PendingPlanAmendment): PlanDoc {
  return {
    ...plan,
    scope: {
      changes: mergeList(plan.scope.changes, amendment.scope.changes.add, amendment.scope.changes.remove),
      new_files: mergeList(plan.scope.new_files, amendment.scope.new_files.add, amendment.scope.new_files.remove),
      delete: mergeList(plan.scope.delete, amendment.scope.delete.add, amendment.scope.delete.remove),
    },
    verify_hash: null,
  };
}

export function isNonMaterialScopeNarrowing(plan: PlanDoc, amendment: PendingPlanAmendment): boolean {
  const mutableTargets = new Set([...plan.scope.changes, ...plan.scope.new_files]);
  const approvedDeleteTargets = new Set(plan.scope.delete);
  // Pure removals are narrowing. Reclassifying an already-approved mutable
  // target between changes and new_files is normalization. Deletion has a
  // different risk level: a target may enter delete only if deletion was
  // already approved for that exact path.
  return amendment.scope.changes.add.every(file => mutableTargets.has(file))
    && amendment.scope.new_files.add.every(file => mutableTargets.has(file))
    && amendment.scope.delete.add.every(file => approvedDeleteTargets.has(file));
}

export function writeScopeLock(plan: PlanDoc, branch: string | null): void {
  const scopeJson = {
    task: plan.task,
    scope: plan.scope,
    boundary: plan.boundary,
    rubrics: plan.verify,
    branch,
  };
  const target = scopePath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(scopeJson, null, 2) + "\n", "utf-8");
}

export async function handleAmendPlan(args: AmendPlanArgs): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "verify", "edit");
  const currentStage = state.stage ?? (state.phase === "verify" ? "verify.amendment" : "edit.implementation");

  const decision = typeof args.approved === "string" ? args.approved.trim().toLowerCase() : "";
  if (decision !== "approve" && decision !== "reject" && decision !== "revise") {
    return toolResult(state.phase, {
      error: {
        type: "validation",
        subtype: "invalid_arguments",
        code: "AMENDMENT_DECISION_INVALID",
        message: "Amendment decision must be approve, reject, or revise.",
        retryable: true,
      },
      requires_user: false,
      stop_here: true,
      stage: currentStage,
      status: "failed",
      allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      nextAction: { tool: null, phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "repair_required" },
      userAction: null,
    });
  }

  if (!state.plan) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      status: "blocked",
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "AMENDMENT_PLAN_MISSING",
        message: "Workflow state reached amendment review without an active PlanDoc.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_amend_plan", "hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }
  if (!approvalMatchesPlan(state.approval, state.plan)) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      error: {
        type: "workflow_state",
        subtype: "approval_missing",
        code: "AMENDMENT_APPROVAL_PLAN_MISMATCH",
        message: "The original PlanDoc approval is missing or no longer matches; an amendment cannot create a replacement approval.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_amend_plan", "hy_verify", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }
  if (!state.pendingAmendment) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      error: "No pending plan amendment. Run hy_verify first.",
      allowedTools: ["hy_verify", "hy_status"],
    });
  }

  const expectedDecisionId = amendmentDecisionId(state.plan, state.pendingAmendment)!;
  if (args.decisionId !== expectedDecisionId) {
    return toolResult(state.phase, {
      amended: false,
      decisionId: expectedDecisionId,
      error: {
        type: "validation",
        subtype: "stale_decision",
        code: "AMENDMENT_DECISION_ID_MISMATCH",
        message: "Amendment decision identity does not match the current pending amendment.",
        detail: {
          expectedDecisionId,
          actualDecisionId: typeof args.decisionId === "string" ? args.decisionId : null,
        },
        retryable: true,
      },
      stage: currentStage,
      status: "failed",
      allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      nextAction: { tool: null, phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "approval_required" },
      userAction: {
        kind: "approval",
        decisionId: expectedDecisionId,
        options: ["approve", "reject", "revise"],
      },
    });
  }

  if (decision === "reject" || decision === "revise") {
    const next = state.phase === "verify" ? transition(state, "edit") : { ...state };
    next.pendingAmendment = null;
    next.verifyHash = null;
    next.verifiedImplementationDigest = null;
    next.verifiedManifestHash = null;
    writeState(next);
    return toolResult("edit", {
      amended: false,
      decision,
      stage: "edit.implementation",
      status: "ready",
      allowedTools: ["hy_edit", "hy_status"],
      nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
      control: { automatic: true, stop: false, reason: "automatic" },
      userAction: null,
    });
  }

  const normalizedAmendment = normalizePlanScopeAmendment(state.pendingAmendment.scope);
  if (!normalizedAmendment.ok) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      error: `Pending plan amendment has invalid shape: ${normalizedAmendment.errors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  const amendment: PendingPlanAmendment = {
    ...state.pendingAmendment,
    scope: normalizedAmendment.scope,
  };
  const amendmentPathErrors = validateAmendmentPaths(projectRoot(), amendment.scope);
  if (amendmentPathErrors.length) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      error: `Pending plan amendment contains invalid paths: ${amendmentPathErrors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  const amendedPlan = applyAmendment(state.plan, amendment);
  const amendedScopeErrors = validatePlanScopePaths(projectRoot(), amendedPlan, "amendment");
  if (amendedScopeErrors.length) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      error: `Amended PlanDoc scope is invalid: ${amendedScopeErrors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  const next = transition(state, "edit");
  next.plan = amendedPlan;
  next.approval = createPlanApproval(amendedPlan, args.note ?? "", state.approval);
  next.pendingAmendment = null;
  next.verifyHash = null;
  next.verifiedImplementationDigest = null;
  next.verifiedManifestHash = null;
  next.implementationManifest = null;
  next.documentReads = next.documentReads ? { ...next.documentReads, afterEdit: null } : next.documentReads;
  next.syncDocs = null;
  next.stage = "edit.implementation";
  writeState(next);
  writeScopeLock(amendedPlan, state.branch);

  return toolResult("edit", {
    amended: true,
    plan: amendedPlan,
    appliedAmendment: amendment,
    decisionId: next.approval.decisionId,
    stage: "edit.implementation",
    status: "passed",
    allowedTools: ["hy_read_docs", "hy_edit", "hy_status"],
    blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    nextAction: { tool: "hy_read_docs", arguments: { stage: "after_edit" }, phase: "edit", stage: "edit.after_edit", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
