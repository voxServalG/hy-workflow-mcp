import * as fs from "node:fs";
import * as path from "node:path";
import { assertPhase, projectRoot, readState, scopePath, transition, writeState, type PendingPlanAmendment, type PlanDoc } from "../state.js";
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

function applyAmendment(plan: PlanDoc, amendment: PendingPlanAmendment): PlanDoc {
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

function writeScopeLock(plan: PlanDoc, branch: string | null): void {
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

  if (args.approved !== "approve") {
    return toolResult(state.phase, {
      error: "Plan amendment not approved.",
      requires_user: true,
      stop_here: true,
      hint: "Show pendingAmendment to the user. Call hy_amend_plan only after the user explicitly approves.",
      allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
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

  const normalizedAmendment = normalizePlanScopeAmendment(state.pendingAmendment.scope);
  if (!normalizedAmendment.ok) {
    return toolResult(state.phase, {
      error: `Pending plan amendment has invalid shape: ${normalizedAmendment.errors.join("; ")}`,
      requires_user: true,
      stop_here: true,
      hint: "Run hy_verify again to regenerate a valid pending amendment, or return to hy_plan for a larger scope change.",
      allowedTools: ["hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
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
      blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
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
      blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    });
  }

  const next = transition(state, "edit");
  next.plan = amendedPlan;
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
    allowedTools: ["hy_verify", "hy_edit", "hy_status"],
    blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    message: "Plan amended. Rerun hy_verify.",
  });
}
