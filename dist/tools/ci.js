import { readState, writeState, transition, assertPhase } from "../state.js";
import { checkCi } from "../git.js";
import { toolResult } from "./_base.js";
const FAILURE_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
export async function handleCi() {
    const state = readState();
    assertPhase(state, "ci", "edit"); // edit = fix, ci = re-check
    if (!state.prNumber)
        return toolResult("ci", { phase: state.phase, error: "No active PR", allowedTools: ["hy_status"] });
    const result = checkCi(state.prNumber);
    if (!result.ok)
        return toolResult("ci", { error: result.error, checks: result.checks, recovery: { tool: "hy_ci", instruction: "Inspect the CI query error and retry hy_ci after the GitHub/API issue is resolved." }, allowedTools: ["hy_ci", "hy_status"] });
    if (!result.allGreen) {
        const checks = result.checks || [];
        const failedNames = checks.filter((c) => FAILURE_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
        if (!failedNames.length) {
            return toolResult("ci", {
                allGreen: false,
                pending: true,
                checks,
                requires_user: true,
                stop_here: true,
                hint: "CI is pending or unavailable. Stop here and retry hy_ci after GitHub reports completed checks; do not move to edit unless a check actually fails.",
                allowedTools: ["hy_ci", "hy_status"],
                blockedTools: ["hy_merge", "hy_chain"],
                recovery: {
                    tool: "hy_ci",
                    instruction: "Wait for pending CI checks or resolve the GitHub/API status issue, then rerun hy_ci without editing files.",
                },
                message: "CI is pending or status is unavailable. Retry hy_ci after checks complete.",
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