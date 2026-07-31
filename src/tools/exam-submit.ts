import { readState, writeState, assertPhase } from "./_base.js";
import { projectRoot, transition } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { submitExam, type ExamResult } from "../verify-exam.js";

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

  if (!state.plan) return toolResult("verify", { phase: state.phase, error: "No plan", allowedTools: ["hy_status"] });

  const root = projectRoot();
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
      recovery: {
        nextAction: "fix_then_resubmit",
        resubmitExamId: args.examId,
        hint: "Fix the failed checks, re-run them via Bash with the same exam, and call hy_exam_submit again. Passed checks do not need to be re-submitted.",
      },
      display: {
        title: `${outcome.failedChecks?.length ?? 0} checks failed`,
        body: (outcome.failedChecks ?? []).map(f => `- ${f.id}: ${f.reason} — ${f.message}`).join("\n"),
      },
      allowedTools: ["hy_exam_submit", "hy_status"],
      blockedTools: ["hy_commit", "hy_merge"],
      nextAction: { tool: "hy_exam_submit", phase: "edit", stage: "verify.run", automatic: true },
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
    nextAction: { tool: "hy_commit", phase: "commit", stage: "commit.prepare", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
