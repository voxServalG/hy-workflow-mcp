import * as fs from "node:fs";
import * as path from "node:path";
import { assertPhase, createPlanApproval, projectRoot, readState, scopePath, transition, writeState, type PendingPlanAmendment, type PlanDoc } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { normalizePlanScopeAmendment, validateAmendmentPaths, validatePlanScopePaths } from "../plan_validation.js";

type AmendPlanArgs = {
  approved: string;
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

  const decision = typeof args.approved === "string" ? args.approved.trim().toLowerCase() : "";
  if (decision !== "approve" && decision !== "reject" && decision !== "revise") {
    return toolResult(state.phase, {
      error: {
        type: "validation",
        subtype: "invalid_arguments",
        code: "AMENDMENT_DECISION_INVALID",
        message: "Amendment decision must be approve, reject, or revise.",
        hint: "Map the users existing decision to one enum value and retry without asking for approval again.",
        retryable: true,
      },
      requires_user: false,
      stop_here: false,
      stage: "verify.amendment",
      status: "failed",
      hint: "Retry hy_amend_plan with an explicit decision. The pending amendment and original approval are unchanged.",
      allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      nextAction: { tool: "hy_amend_plan", phase: state.phase, stage: "verify.amendment", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }

  if (!state.plan) {
    return toolResult(state.phase, { error: "No active plan to amend.", allowedTools: ["hy_status"] });
  }
  if (!state.pendingAmendment) {
    return toolResult(state.phase, {
      error: "No pending plan amendment. Run hy_verify first.",
      allowedTools: ["hy_verify", "hy_status"],
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
      message: "Plan amendment was not applied. Restore the implementation to the original approved scope or prepare a revised plan.",
      hint: "Keep the original approval and PlanDoc. Remove the scope drift, then rerun the after_edit audit and verification.",
      allowedTools: ["hy_edit", "hy_status"],
      nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
      control: { automatic: true, stop: false, reason: "automatic" },
      userAction: null,
    });
  }

  const normalizedAmendment = normalizePlanScopeAmendment(state.pendingAmendment.scope);
  if (!normalizedAmendment.ok) {
    return toolResult(state.phase, {
      error: `Pending plan amendment has invalid shape: ${normalizedAmendment.errors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      hint: "Run hy_verify again to regenerate a valid pending amendment, or return to hy_plan for a larger scope change.",
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
      error: `Pending plan amendment contains invalid paths: ${amendmentPathErrors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      hint: "Reject this automatic amendment and create a new PlanDoc if the change needs paths outside the approved project scope.",
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  const amendedPlan = applyAmendment(state.plan, amendment);
  const amendedScopeErrors = validatePlanScopePaths(projectRoot(), amendedPlan, "amendment");
  if (amendedScopeErrors.length) {
    return toolResult(state.phase, {
      error: `Amended PlanDoc scope is invalid: ${amendedScopeErrors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      hint: "Reject this automatic amendment and create a new PlanDoc if the approved scope would become empty or invalid.",
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  const next = transition(state, "edit");
  next.plan = amendedPlan;
  next.approval = createPlanApproval(amendedPlan, args.note ?? "", state.approval);
  next.pendingAmendment = null;
  next.verifyHash = null;
  writeState(next);
  writeScopeLock(amendedPlan, state.branch);

  return toolResult("edit", {
    amended: true,
    plan: amendedPlan,
    appliedAmendment: amendment,
    display: {
      title: "Plan amended",
      body: "Pending plan amendment was applied. Rerun hy_verify before committing.",
    },
    hint: "Rerun hy_verify. Do not call hy_commit until verification passes after the amended plan.",
    decisionId: next.approval.decisionId,
    stage: "edit.implementation",
    status: "passed",
    allowedTools: ["hy_verify", "hy_edit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    nextAction: { tool: "hy_verify", phase: "edit", stage: "verify.run", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
    message: "Plan amended. Rerun hy_verify.",
  });
}
