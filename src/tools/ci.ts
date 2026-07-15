import { readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { checkCi } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

const FAILURE_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 1800;
const MIN_INTERVAL_SECONDS = 2;

type CiArgs = {
  timeoutSeconds?: number;
  intervalSeconds?: number;
};

function clampSeconds(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value as number), min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function handleCi(args: CiArgs = {}): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "ci", "edit"); // edit = fix, ci = re-check

  if (!state.prNumber) return toolResult("ci", { phase: state.phase, error: "No active PR", allowedTools: ["hy_status"] });

  const root = projectRoot();
  const timeoutSeconds = clampSeconds(args.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 0, MAX_TIMEOUT_SECONDS);
  const intervalSeconds = clampSeconds(args.intervalSeconds, DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, timeoutSeconds || DEFAULT_INTERVAL_SECONDS);
  const deadline = Date.now() + timeoutSeconds * 1000;

  let result = checkCi(root, state.prNumber);
  while (result.ok && !result.allGreen && !result.noChecks && !result.noEffectiveChecks) {
    const checks = result.checks || [];
    const failedNames = checks.filter((c: any) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c: any) => c.name);
    if (failedNames.length || Date.now() >= deadline) break;
    await sleep(Math.min(intervalSeconds * 1000, Math.max(deadline - Date.now(), 0)));
    result = checkCi(root, state.prNumber);
  }

  if (!result.ok) return toolResult("ci", { error: result.error, data: { executor: result.executor }, checks: result.checks, requires_user: true, stop_here: true, recovery: { tool: "hy_ci", instruction: "Inspect the CI query error and retry hy_ci after the GitHub/API issue is resolved." }, allowedTools: ["hy_ci", "hy_status"] });

  if (result.noChecks || result.noEffectiveChecks) {
    const reason = result.noChecks ? "No CI checks were reported" : "All reported CI checks were skipped or neutral";
    return toolResult("ci", {
      data: { executor: result.executor },
      allGreen: false,
      noChecks: Boolean(result.noChecks),
      noEffectiveChecks: Boolean(result.noEffectiveChecks),
      checks: result.checks,
      error: {
        type: "workflow_state",
        subtype: "invalid_phase",
        code: "CI_CHECKS_REQUIRED",
        message: `${reason} for PR #${state.prNumber}; merge is blocked.`,
        hint: "Ensure the repository workflow runs for every pull request and required checks report SUCCESS, then retry hy_ci.",
        retryable: true,
      },
      requires_user: true,
      stop_here: true,
      display: {
        title: "CI checks required",
        body: `${reason} for PR #${state.prNumber}. hy_ci will not advance to merge.`,
      },
      hint: "Fix or enable the PR checks, then retry hy_ci. Do not merge without a successful effective check.",
      recovery: {
        tool: "hy_ci",
        instruction: "Ensure at least one non-skipped, non-neutral PR check completes successfully, then rerun hy_ci.",
      },
      allowedTools: ["hy_ci", "hy_status"],
      blockedTools: ["hy_merge", "hy_chain"],
      message: `${reason}. Merge remains blocked.`,
    });
  }

  if (!result.allGreen) {
    const checks = result.checks || [];
    const failedNames = checks.filter((c: any) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c: any) => c.name);

    if (!failedNames.length) {
      return toolResult("ci", {
        allGreen: false,
        data: { executor: result.executor },
        pending: true,
        checks,
        timeoutSeconds,
        intervalSeconds,
        requires_user: true,
        stop_here: true,
        hint: "CI is still pending after bounded polling. Stop here and retry hy_ci later; do not move to edit unless a check actually fails.",
        allowedTools: ["hy_ci", "hy_status"],
        blockedTools: ["hy_merge", "hy_chain"],
        recovery: {
          tool: "hy_ci",
          instruction: "Wait for pending CI checks or resolve the GitHub/API status issue, then rerun hy_ci without editing files. You may pass a longer timeoutSeconds if needed.",
        },
        message: `CI is still pending after ${timeoutSeconds}s. Retry hy_ci after checks complete.`,
      });
    }

    const next = transition(state, "edit");
    writeState(next);

    return toolResult("edit", {
      allGreen: false,
      data: { executor: result.executor },
      checks,
      failedChecks: failedNames,
      requires_user: true,
      stop_here: true,
      hint: "CI is not green. Read failed checks before editing. After fixes, run hy_verify, hy_commit, then hy_ci again.",
      allowedTools: ["hy_edit", "hy_verify", "hy_status"],
      blockedTools: ["hy_merge", "hy_chain"],
      recovery: {
        tool: "hy_edit",
        instruction: "Fix CI failures locally, rerun hy_verify, create a new commit with hy_commit, then rerun hy_ci.",
      },
      message: `CI not all green. Failed: ${failedNames.join(", ")}. Fix issues, push, and re-run hy_ci.`,
    });
  }

  const next = transition(state, "merge");
  writeState(next);

  return toolResult("merge", {
    allGreen: true,
    data: { executor: result.executor },
    checks: result.checks,
    display: {
      title: "CI passed",
      body: `All CI checks passed for PR #${state.prNumber}.`,
    },
    hint: "Continue to hy_merge. The approved workflow does not stop after CI success.",
    allowedTools: ["hy_merge", "hy_status"],
    blockedTools: ["hy_chain"],
    message: "All CI checks passed. Ready to merge.",
  });
}
