import { readState, writeState, assertPhase } from "./_base.js";
import { approvalMatchesPlan, documentReadHealth, projectRoot, transition } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { computeScopeFingerprint, issueExam } from "../verify-exam.js";
import { buildImplementationManifest } from "../checks.js";
import { implementationDigest } from "./sync_docs.js";
import { validatePlanScopePaths } from "../plan_validation.js";

export const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export async function handleExamPlan(): Promise<ToolResult> {
  const state = readState();
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
        code: "EXAM_PLAN_MISSING",
        message: "Workflow state reached asynchronous verification without an active PlanDoc.",
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
        code: "EXAM_APPROVAL_PLAN_MISMATCH",
        message: "The current PlanDoc is not bound to a valid approval.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }

  const root = projectRoot();
  const scopeErrors = validatePlanScopePaths(root, state.plan, "verify");
  if (scopeErrors.length) {
    return toolResult(state.phase, {
      phase: state.phase,
      stage: currentStage,
      status: "blocked",
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "EXAM_SCOPE_INVALID",
        message: `Stored PlanDoc scope contains invalid paths: ${scopeErrors.join("; ")}`,
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_amend_plan", "hy_verify", "hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset" },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure" },
    });
  }
  const implementationManifest = buildImplementationManifest(root);
  const currentImplementationDigest = implementationDigest(root, state.plan, implementationManifest);
  const health = documentReadHealth(state, currentImplementationDigest);
  if (!health.okForVerify) {
    const blocked = health.blockedBy;
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: blocked?.reason ?? "after_edit document audit and hy_sync_docs must be current before hy_exam_plan.",
      documentReadHealth: health,
      allowedTools: [blocked?.tool ?? "hy_read_docs", "hy_status"],
      blockedTools: ["hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
    });
  }
  const currentScopeFingerprint = computeScopeFingerprint(root);
  const manifest = state.activeExam
    && Date.now() < Date.parse(state.activeExam.expiresAt)
    && state.activeExam.scopeFingerprint === currentScopeFingerprint
    ? state.activeExam
    : issueExam(root, state.plan);
  const next = transition(state, "verify");
  next.stage = "verify.run";
  next.activeExam = manifest;
  writeState(next);

  return toolResult("verify", {
    phase: "verify",
    next: "verify",
    stage: "verify.run",
    status: "running",
    examId: manifest.examId,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    scopeFingerprint: manifest.scopeFingerprint,
    nonce: manifest.nonce,
    checks: manifest.checks.map(c => ({
      id: c.id,
      layer: c.layer,
      command: c.command,
      cwd: c.cwd,
      timeoutMs: c.timeoutMs,
      expectExitCode: c.expectExitCode,
      nonce: c.nonce,
      mustContain: c.mustContain,
      mustNotContain: c.mustNotContain,
    })),
    allowedTools: ["hy_exam_submit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    requires_user: false,
    nextAction: { tool: null, phase: "verify", stage: "verify.run", automatic: false },
    control: { automatic: false, stop: true, reason: "external_action_required" },
    userAction: null,
  });
}
