import { amendmentDecisionId, approvalMatchesPlan, computePlanHash, readState, rebindApprovalForNonMaterialNarrowing, writeState, transition, assertPhase, projectRoot, computeImplementationDigest, documentReadHealth } from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { runAllChecksAsync } from "../checks-async.js";
import { implementationDigest } from "./sync_docs.js";
import { invalidWorkflowStateResult, toolResult, type ToolResult } from "./_base.js";
import { applyAmendment, isNonMaterialScopeNarrowing, writeScopeLock } from "./amend_plan.js";
import { validatePlanScopePaths } from "../plan_validation.js";

export async function handleVerify(): Promise<ToolResult> {
  let state = readState();
  assertPhase(state, "edit", "verify");
  const currentStage = state.stage ?? (state.phase === "verify" ? "verify.run" : "edit.implementation");

  if (!state.plan) {
    return invalidWorkflowStateResult(
      state,
      "VERIFY_PLAN_MISSING",
      "Workflow state reached verification without an active PlanDoc.",
      "Reset the impossible workflow state, then create and approve a new PlanDoc.",
    );
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
        hint: "Reset the invalid workflow state and create a new PlanDoc decision before verification.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset", instruction: "Reset the invalid approval state before replanning." },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure", instruction: "Verification cannot mint or replace a missing PlanDoc approval." },
    });
  }

  const root = projectRoot();
  const scopePathErrors = validatePlanScopePaths(root, plan, "verify");
  if (scopePathErrors.length) {
    return invalidWorkflowStateResult(
      state,
      "VERIFY_SCOPE_INVALID",
      `Stored PlanDoc scope contains invalid paths: ${scopePathErrors.join("; ")}`,
      "Reset the invalid workflow state and create a new PlanDoc containing only paths authoritative for this project.",
    );
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
      hint: blocked?.tool === "hy_sync_docs"
        ? "Call hy_sync_docs to confirm the document sync gate, then rerun hy_verify."
        : "Call hy_read_docs with { stage: \"after_edit\" }, then hy_sync_docs, then rerun hy_verify.",
      allowedTools: [blocked?.tool ?? "hy_read_docs", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
    });
  }

  state = transition(state, "verify");
  state.stage = "verify.run";
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
            display: {
              title: "Non-material scope narrowing applied",
              body: "Unused declared paths were removed or normalized without adding a new write target. The original approval remains valid.",
            },
            hint: "Rerun hy_verify automatically. Do not ask the user to approve this narrowing.",
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
        display: {
          title: "Plan amendment required",
          body: [
            "hy_verify found scope drift that appears to stay inside the approved task boundary.",
            "Review suggestedAmendment, then call hy_amend_plan with approved='approve' to apply it.",
          ].join("\n"),
        },
        requires_user: true,
        stop_here: true,
        decisionId,
        stage: "verify.amendment",
        hint: "Show the suggested amendment to the user. If approved, call hy_amend_plan, then rerun hy_verify. Do not reset to plan for amendable scope drift.",
        allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
        blockedTools: ["hy_commit", "hy_merge"],
        nextAction: { tool: null, phase: "verify", stage: "verify.amendment", automatic: false },
        control: { automatic: false, stop: true, reason: "approval_required" },
        userAction: {
          kind: "approval",
          decisionId,
          prompt: "Review the exact scope amendment and approve, reject, or request revision.",
          options: ["approve", "reject", "revise"],
        },
        message: "Scope drift can be handled with hy_amend_plan. Await approval before amending.",
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
      hint: "Do not call hy_commit. Inspect failed check layers, fix the minimal cause, then rerun hy_verify. If any command exceeds 60s or the full suite exceeds the MCP client timeout, switch to the async exam path (hy_exam_plan → run commands via Bash → hy_exam_submit).",
      allowedTools: ["hy_edit", "hy_verify", "hy_exam_plan", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      recovery: {
        strategy: "repair_and_retry",
        tool: "hy_edit",
        instruction: "Fix failed checks, then rerun hy_verify.",
        byLayer: {
          lint: "Fix formatting, imports, naming, or static rule violations without changing business behavior just to silence lint.",
          compile: "Fix types, imports, exports, or build configuration.",
          scope: "Remove unintended scope-out changes. If verify returns amend_required, use hy_amend_plan instead of resetting to plan.",
          boundary: "Fix real entry points or module boundaries; do not replace checks with hollow commands.",
          platform: "Fix setup or dependency assumptions; do not skip setup silently.",
          smoke: "Fix the smallest executable path covered by the smoke check.",
          tests: "Fix code or tests; do not delete failing tests or weaken assertions.",
        },
      },
      nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
      message: `${report.hardFailed} checks failed: ${failedChecks.join(", ")}. Fix and re-run hy_verify.`,
    });
  }

  // All passed
  const next = transition(state, "commit");
  next.pendingAmendment = null;
  next.implementationManifest = report.implementationManifest;
  next.verifiedImplementationDigest = computeImplementationDigest(root, report.implementationManifest);
  writeState(next);

  return toolResult("commit", {
    passed: true,
    allPassed: true,
    status: "passed",
    stage: "commit.prepare",
    checks: report.checks,
    implementationManifest: report.implementationManifest,
    verifyHash: next.verifiedImplementationDigest,
    hint: "Verification passed. Call hy_commit next to create the PR; do not edit files without rerunning hy_verify.",
    allowedTools: ["hy_commit", "hy_status"],
    blockedTools: ["hy_merge"],
    nextAction: { tool: null, phase: "commit", stage: "commit.prepare", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: null,
    message: `All ${report.total} checks passed. Ready to commit.`,
  });
}
