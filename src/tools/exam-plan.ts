import { readState, writeState, assertPhase } from "./_base.js";
import { projectRoot, transition } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { issueExam } from "../verify-exam.js";

export const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export async function handleExamPlan(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "edit", "verify");

  if (!state.plan) {
    return toolResult("verify", { phase: state.phase, error: "No plan", allowedTools: ["hy_status"] });
  }

  const root = projectRoot();
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
        "Tip: run checks in any order; you can re-run a single failing check and resubmit just that result.",
      ].join("\n"),
    },
    allowedTools: ["hy_exam_submit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    requires_user: false,
    nextAction: { tool: "hy_exam_submit", phase: "verify", stage: "verify.run", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
