import { invalidWorkflowStateResult, readState, writeState, assertPhase } from "./_base.js";
import { approvalMatchesPlan, documentReadHealth, projectRoot, transition } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { issueExam } from "../verify-exam.js";
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
    return invalidWorkflowStateResult(
      state,
      "EXAM_PLAN_MISSING",
      "Workflow state reached asynchronous verification without an active PlanDoc.",
      "Reset the impossible workflow state, then create and approve a new PlanDoc.",
    );
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
        hint: "Reset the invalid workflow state before issuing an exam.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset", instruction: "Reset the invalid approval state before replanning." },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure", instruction: "An exam cannot replace a missing PlanDoc approval." },
    });
  }

  const root = projectRoot();
  const scopeErrors = validatePlanScopePaths(root, state.plan, "verify");
  if (scopeErrors.length) {
    return invalidWorkflowStateResult(
      state,
      "EXAM_SCOPE_INVALID",
      `Stored PlanDoc scope contains invalid paths: ${scopeErrors.join("; ")}`,
      "Reset the invalid workflow state and create a new PlanDoc containing only paths authoritative for this project.",
    );
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
      hint: blocked?.tool === "hy_sync_docs"
        ? "Complete declared documentation edits, then call hy_sync_docs before issuing an exam."
        : "Call hy_read_docs with stage after_edit, complete declared documentation edits, then call hy_sync_docs before issuing an exam.",
      allowedTools: [blocked?.tool ?? "hy_read_docs", "hy_status"],
      blockedTools: ["hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
    });
  }
  const next = transition(state, "verify");
  next.stage = "verify.run";
  writeState(next);
  const manifest = issueExam(root, state.plan);

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
    display: {
      title: "Exam issued — run each command via Bash and submit results with hy_exam_submit",
      body: [
        `${manifest.checks.length} checks issued. Run each command exactly as printed via the Bash tool, collect exitCode + last 4KB stdout, then call hy_exam_submit({ examId: "${manifest.examId}", results: [...] }).`,
        "Exam expires in 2 hours or when the working tree changes.",
        "Submit one complete result set. Any failed check returns to edit; after a fix, refresh document evidence and issue a new exam.",
      ].join("\n"),
    },
    allowedTools: ["hy_exam_submit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    requires_user: false,
    nextAction: { tool: null, phase: "verify", stage: "verify.run", automatic: false },
    control: { automatic: false, stop: true, reason: "external_action_required" },
    userAction: null,
  });
}
