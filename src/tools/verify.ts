import { amendmentDecisionId, approvalMatchesPlan, computePlanHash, readState, rebindApprovalForNonMaterialNarrowing, supersedeCommitRecoveryAfterVerification, writeState, transition, assertPhase, projectRoot, computeImplementationDigest, documentReadHealth } from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { runAllChecksAsync } from "../checks-async.js";
import { implementationDigest } from "./sync_docs.js";
import { toolResult, type ToolResult } from "./_base.js";
import { applyAmendment, isNonMaterialScopeNarrowing, writeScopeLock } from "./amend_plan.js";
import { validatePlanScopePaths } from "../plan_validation.js";

export async function handleVerify(): Promise<ToolResult> {
  let state = readState();
  assertPhase(state, "edit", "verify");
  const currentStage = state.stage ?? (state.phase === "verify" ? "verify.run" : "edit.implementation");

  if (!state.plan) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      status: "blocked",
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "VERIFY_PLAN_MISSING",
        message: "Workflow state reached verification without an active PlanDoc.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_amend_plan", "hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }
  const plan = state.plan;
  if (!approvalMatchesPlan(state.approval, plan)) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      error: {
        type: "workflow_state",
        subtype: "approval_missing",
        code: "VERIFY_APPROVAL_PLAN_MISMATCH",
        message: "The current PlanDoc is not bound to a valid approval.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }

  const root = projectRoot();
  const scopePathErrors = validatePlanScopePaths(root, plan, "verify");
  if (scopePathErrors.length) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      status: "blocked",
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "VERIFY_SCOPE_INVALID",
        message: `Stored PlanDoc scope contains invalid paths: ${scopePathErrors.join("; ")}`,
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_amend_plan", "hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }
  const currentImplementationDigest = implementationDigest(root, plan, buildImplementationManifest(root));
  const health = documentReadHealth(state, currentImplementationDigest);
  if (!health.okForVerify) {
    const blocked = health.blockedBy;
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: blocked?.reason ?? "after_edit document audit and hy_sync_docs must be current before hy_verify.",
      documentReadHealth: health,
      allowedTools: [blocked?.tool ?? "hy_read_docs", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  state = transition(state, "verify");
  state.stage = "verify.run";
  state.activeExam = null;
  writeState(state);
  const report = await runAllChecksAsync(root, state);

  if (!report.allPassed) {
    if (report.status === "amend_required" && report.suggestedAmendment) {
      if (isNonMaterialScopeNarrowing(plan, report.suggestedAmendment)) {
        const amendedPlan = applyAmendment(plan, report.suggestedAmendment);
        const scopeErrors = validatePlanScopePaths(root, amendedPlan, "amendment");
        if (!scopeErrors.length) {
          const decisionId = amendmentDecisionId(plan, report.suggestedAmendment)!;
          const planHash = computePlanHash(amendedPlan)!;
          const next = transition(state, "verify");
          next.plan = amendedPlan;
          next.approval = rebindApprovalForNonMaterialNarrowing(state.approval, plan, amendedPlan, decisionId);
          next.pendingAmendment = null;
          next.implementationManifest = report.implementationManifest;
          next.verifyHash = null;
          next.verifiedImplementationDigest = null;
          next.verifiedManifestHash = null;
          next.documentReads = next.documentReads ? {
            ...next.documentReads,
            beforeApprove: next.documentReads.beforeApprove ? { ...next.documentReads.beforeApprove, planHash } : next.documentReads.beforeApprove,
            afterEdit: next.documentReads.afterEdit ? { ...next.documentReads.afterEdit, planHash } : next.documentReads.afterEdit,
          } : next.documentReads;
          next.syncDocs = next.syncDocs ? { ...next.syncDocs, planHash } : next.syncDocs;
          writeState(next);
          writeScopeLock(amendedPlan, state.branch);
          return toolResult("verify", {
            phase: "verify",
            amended: true,
            material: false,
            appliedAmendment: report.suggestedAmendment,
            decisionId: next.approval.decisionId,
            stage: "verify.run",
            status: "warning",
            allowedTools: ["hy_verify", "hy_status"],
            blockedTools: ["hy_commit", "hy_merge"],
            nextAction: { tool: "hy_verify", phase: "verify", stage: "verify.run", automatic: true },
            control: { automatic: true, stop: false, reason: "automatic" },
            userAction: null,
          });
        }
      }
      const next = transition(state, "verify");
      next.stage = "verify.amendment";
      next.pendingAmendment = report.suggestedAmendment;
      next.implementationManifest = report.implementationManifest;
      next.verifyHash = null;
      next.verifiedImplementationDigest = null;
      next.verifiedManifestHash = null;
      writeState(next);
      const decisionId = amendmentDecisionId(plan, report.suggestedAmendment)!;

      return toolResult("verify", {
        passed: false,
        allPassed: false,
        status: "amend_required",
        total: report.total,
        checks: report.checks,
        implementationManifest: report.implementationManifest,
        suggestedAmendment: report.suggestedAmendment,
        requires_user: true,
        stop_here: true,
        decisionId,
        stage: "verify.amendment",
        allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
        blockedTools: ["hy_commit", "hy_merge"],
        nextAction: { tool: null, phase: "verify", stage: "verify.amendment", automatic: false },
        control: { automatic: false, stop: true, reason: "approval_required" },
        userAction: {
          kind: "approval",
          decisionId,
          options: ["approve", "reject", "revise"],
        },
      });
    }

    const next = transition(state, "edit");
    next.pendingAmendment = report.suggestedAmendment;
    next.implementationManifest = report.implementationManifest;
    next.verifyHash = null;
    next.verifiedImplementationDigest = null;
    next.verifiedManifestHash = null;
    writeState(next);
    const failedChecks = report.checks.filter(c => c.hard && !c.passed).map(c => `${c.layer}/${c.name}`);
    return toolResult("edit", {
      passed: false,
      allPassed: false,
      status: "failed",
      hardFailed: report.hardFailed,
      total: report.total,
      checks: report.checks,
      failedChecks,
      implementationManifest: report.implementationManifest,
      suggestedAmendment: report.suggestedAmendment,
      allowedTools: ["hy_edit", "hy_verify", "hy_exam_plan", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      recovery: { strategy: "repair_and_retry", tool: "hy_edit" },
      nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }

  // All passed
  const next = transition(state, "commit");
  next.pendingAmendment = null;
  next.implementationManifest = report.implementationManifest;
  next.verifiedImplementationDigest = computeImplementationDigest(root, report.implementationManifest);
  next.approval = supersedeCommitRecoveryAfterVerification(next.approval);
  writeState(next);

  return toolResult("commit", {
    passed: true,
    allPassed: true,
    status: "passed",
    stage: "commit.prepare",
    checks: report.checks,
    implementationManifest: report.implementationManifest,
    verifyHash: next.verifiedImplementationDigest,
    allowedTools: ["hy_commit", "hy_status"],
    blockedTools: ["hy_merge"],
    nextAction: { tool: null, phase: "commit", stage: "commit.prepare", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: null,
  });
}
