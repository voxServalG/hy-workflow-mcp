import { readState, writeState, transition, assertPhase, projectRoot, computeVerifyHash } from "../state.js";
import { runAllChecks } from "../checks.js";
import type { ToolResult } from "./_base.js";

export async function handleVerify(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "edit", "verify");

  if (!state.plan) return { next: "verify", error: "No plan" };

  const root = projectRoot();
  const report = runAllChecks(root, state);

  if (!report.allPassed) {
    const next = transition(state, "edit");
    writeState(next);
    return {
      next: "edit",
      passed: false,
      allPassed: false,
      hardFailed: report.hardFailed,
      total: report.total,
      checks: report.checks,
      message: `${report.hardFailed} hard checks failed. Fix and re-run hy_verify.`,
    };
  }

  // All passed
  const next = transition(state, "commit");
  next.verifyHash = computeVerifyHash(next);
  writeState(next);

  return {
    next: "commit",
    passed: true,
    allPassed: true,
    checks: report.checks,
    verifyHash: state.verifyHash,
    message: `All ${report.total} checks passed. Ready to commit.`,
  };
}
