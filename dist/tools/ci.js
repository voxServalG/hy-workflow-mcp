import { readState, writeState, transition, assertPhase } from "../state.js";
import { checkCi } from "../git.js";
import { toolResult } from "./_base.js";
const FAILURE_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 1800;
const MIN_INTERVAL_SECONDS = 2;
function clampSeconds(value, fallback, min, max) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(Math.max(Math.floor(value), min), max);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export async function handleCi(args = {}) {
    const state = readState();
    assertPhase(state, "ci", "edit"); // edit = fix, ci = re-check
    if (!state.prNumber)
        return toolResult("ci", { phase: state.phase, error: "No active PR", allowedTools: ["hy_status"] });
    const timeoutSeconds = clampSeconds(args.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 0, MAX_TIMEOUT_SECONDS);
    const intervalSeconds = clampSeconds(args.intervalSeconds, DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, timeoutSeconds || DEFAULT_INTERVAL_SECONDS);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let result = checkCi(state.prNumber);
    while (result.ok && !result.allGreen) {
        const checks = result.checks || [];
        const failedNames = checks.filter((c) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
        if (failedNames.length || Date.now() >= deadline)
            break;
        await sleep(Math.min(intervalSeconds * 1000, Math.max(deadline - Date.now(), 0)));
        result = checkCi(state.prNumber);
    }
    if (!result.ok)
        return toolResult("ci", { error: result.error, checks: result.checks, requires_user: true, stop_here: true, recovery: { tool: "hy_ci", instruction: "Inspect the CI query error and retry hy_ci after the GitHub/API issue is resolved." }, allowedTools: ["hy_ci", "hy_status"] });
    if (!result.allGreen) {
        const checks = result.checks || [];
        const failedNames = checks.filter((c) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
        if (!failedNames.length) {
            return toolResult("ci", {
                allGreen: false,
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
//# sourceMappingURL=ci.js.map