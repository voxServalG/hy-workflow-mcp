import { readState, writeState, transition, assertPhase, projectRoot, computeVerifyHash } from "../state.js";
import { runAllChecks } from "../checks.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleVerify(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "edit", "verify");

  if (!state.plan) return toolResult("verify", { phase: state.phase, error: "No plan", allowedTools: ["hy_status"] });

  const root = projectRoot();
  const report = runAllChecks(root, state);

  if (!report.allPassed) {
    const next = transition(state, "edit");
    writeState(next);
    const failedChecks = report.checks.filter(c => c.hard && !c.passed).map(c => `${c.layer}/${c.name}`);
    return toolResult("edit", {
      passed: false,
      allPassed: false,
      hardFailed: report.hardFailed,
      total: report.total,
      checks: report.checks,
      failedChecks,
      hint: "Do not call hy_commit. Inspect failed check layers, fix the minimal cause, then rerun hy_verify.",
      allowedTools: ["hy_edit", "hy_verify", "hy_status"],
      blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
      recovery: {
        tool: "hy_edit",
        instruction: "Fix failed checks, then rerun hy_verify.",
        byLayer: {
          lint: "Fix formatting, imports, naming, or static rule violations without changing business behavior just to silence lint.",
          compile: "Fix types, imports, exports, or build configuration.",
          scope: "Remove unintended scope-out changes, or re-plan if the extra files are truly required.",
          boundary: "Fix real entry points or module boundaries; do not replace checks with hollow commands.",
          platform: "Fix setup or dependency assumptions; do not skip setup silently.",
          smoke: "Fix the smallest executable path covered by the smoke check.",
          tests: "Fix code or tests; do not delete failing tests or weaken assertions.",
        },
      },
      message: `${report.hardFailed} checks failed: ${failedChecks.join(", ")}. Fix and re-run hy_verify.`,
    });
  }

  // All passed
  const next = transition(state, "commit");
  next.verifyHash = computeVerifyHash(next);
  writeState(next);

  return toolResult("commit", {
    passed: true,
    allPassed: true,
    checks: report.checks,
    verifyHash: next.verifyHash,
    hint: "Verification passed. Call hy_commit next to create the PR; do not edit files without rerunning hy_verify.",
    allowedTools: ["hy_commit", "hy_status"],
    blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
    message: `All ${report.total} checks passed. Ready to commit.`,
  });
}
