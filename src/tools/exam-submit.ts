import { invalidWorkflowStateResult, readState, writeState, assertPhase } from "./_base.js";
import { approvalMatchesPlan, documentReadHealth, projectRoot, transition } from "../state.js";
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
    return invalidWorkflowStateResult(
      state,
      "EXAM_SUBMIT_PLAN_MISSING",
      "Workflow state reached asynchronous verification submission without an active PlanDoc.",
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
        hint: "Reset the invalid workflow state before submitting exam results.",
      },
      allowedTools: ["hy_reset", "hy_status"],
      blockedTools: ["hy_exam_plan", "hy_exam_submit", "hy_commit", "hy_merge"],
      recovery: { strategy: "reset", tool: "hy_reset", instruction: "Reset the invalid approval state before replanning." },
      nextAction: { tool: "hy_reset", phase: state.phase, stage: currentStage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure", instruction: "Submitted results cannot replace a missing PlanDoc approval." },
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
  state = transition(state, "verify");
  state.stage = "verify.run";
  writeState(state);
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
      recovery: {
        strategy: "repair_and_retry",
        tool: "hy_edit",
        instruction: "Re-enter edit, fix the failed checks, refresh after_edit and sync_docs evidence, then issue a new hy_exam_plan. A changed worktree invalidates this exam fingerprint.",
      },
      display: {
        title: `${outcome.failedChecks?.length ?? 0} checks failed`,
        body: (outcome.failedChecks ?? []).map(f => `- ${f.id}: ${f.reason} — ${f.message}`).join("\n"),
      },
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
  writeState(next);

  return toolResult("commit", {
    passed: true,
    next: "commit",
    stage: "commit.prepare",
    status: "passed",
    examId: args.examId,
    submitted: args.results.length,
    display: {
      title: "All checks passed via exam",
      body: `All ${args.results.length} submitted checks passed. Ready to hy_commit.`,
    },
    allowedTools: ["hy_commit", "hy_status"],
    nextAction: { tool: null, phase: "commit", stage: "commit.prepare", automatic: false },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: null,
  });
}
