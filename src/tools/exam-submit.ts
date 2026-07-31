import { readState, writeState, assertPhase } from "./_base.js";
import { approvalMatchesPlan, documentReadHealth, projectRoot, supersedeCommitRecoveryAfterVerification, transition } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { submitExam, type ExamResult } from "../verify-exam.js";
import { buildImplementationManifest } from "../checks.js";
import { implementationDigest } from "./sync_docs.js";
import { validatePlanScopePaths } from "../plan_validation.js";

export const inputSchema = {
  type: "object",
  properties: {
    examId: { type: "string", minLength: 16 },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          command: { type: "string" },
          nonce: { type: "string" },
          exitCode: { type: "integer" },
          durationMs: { type: "integer" },
          stdoutTail: { type: "string" },
          stderrTail: { type: "string" },
        },
        required: ["id", "command", "nonce", "exitCode"],
        additionalProperties: false,
      },
    },
  },
  required: ["examId", "results"],
  additionalProperties: false,
} as const;

interface Args {
  examId: string;
  results: ExamResult[];
}

export async function handleExamSubmit(args: Args): Promise<ToolResult> {
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
        code: "EXAM_SUBMIT_PLAN_MISSING",
        message: "Workflow state reached asynchronous verification submission without an active PlanDoc.",
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
  const manifest = buildImplementationManifest(root);
  const currentImplementationDigest = implementationDigest(root, state.plan, manifest);
  const health = documentReadHealth(state, currentImplementationDigest);
  if (!health.okForVerify) {
    const blocked = health.blockedBy;
    return toolResult("edit", {
      phase: state.phase,
      stage: currentStage,
      error: blocked?.reason ?? "after_edit document audit and hy_sync_docs must be current before hy_exam_submit.",
      documentReadHealth: health,
      allowedTools: [blocked?.tool ?? "hy_read_docs", "hy_status"],
      blockedTools: ["hy_exam_submit", "hy_commit", "hy_merge"],
    });
  }
  if (state.activeExam && state.activeExam.examId !== args.examId) {
    return toolResult("verify", {
      phase: "verify",
      stage: "verify.run",
      status: "failed",
      error: {
        type: "validation",
        subtype: "invalid_arguments",
        code: "EXAM_NOT_ACTIVE",
        message: "The submitted examId does not match the active verification exam.",
        detail: { activeExamId: state.activeExam.examId, submittedExamId: args.examId },
        retryable: false,
      },
      allowedTools: ["hy_status"],
      blockedTools: ["hy_exam_submit", "hy_commit", "hy_merge"],
      nextAction: { tool: "hy_status", phase: "verify", stage: "verify.run", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }
  state = transition(state, "verify");
  state.stage = "verify.run";
  const outcome = submitExam(root, state, args.examId, args.results);

  if (!outcome.passed) {
    const failedState = transition(state, "edit");
    writeState(failedState);
    return toolResult("edit", {
      passed: false,
      stage: "edit.implementation",
      status: "failed",
      failedChecks: outcome.failedChecks,
      examId: args.examId,
      recovery: { strategy: "repair_and_retry", tool: "hy_edit" },
      allowedTools: ["hy_edit", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      nextAction: { tool: "hy_edit", phase: "edit", stage: "edit.implementation", automatic: true },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }

  // Passed: advance to commit phase same as sync hy_verify
  const next = transition(state, "commit");
  next.implementationManifest = outcome.implementationManifest;
  next.verifiedImplementationDigest = outcome.verifiedImplementationDigest ?? null;
  next.approval = supersedeCommitRecoveryAfterVerification(next.approval);
  writeState(next);

  return toolResult("commit", {
    passed: true,
    next: "commit",
    stage: "commit.prepare",
    status: "passed",
    examId: args.examId,
    submitted: args.results.length,
    allowedTools: ["hy_commit", "hy_status"],
    nextAction: { tool: null, phase: "commit", stage: "commit.prepare", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: null,
  });
}
