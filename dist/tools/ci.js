import { readState, writeState, transition, assertPhase } from "../state.js";
import { checkCi } from "../git.js";
export async function handleCi() {
    const state = readState();
    assertPhase(state, "ci", "edit"); // edit = fix, ci = re-check
    if (!state.prNumber)
        return { next: "ci", error: "No active PR" };
    const result = checkCi(state.prNumber);
    if (!result.ok)
        return { next: "ci", error: result.error, checks: result.checks };
    if (!result.allGreen) {
        const failedNames = (result.checks || []).filter((c) => c.status !== "pass").map((c) => c.name);
        return {
            next: "edit",
            allGreen: false,
            checks: result.checks,
            failedChecks: failedNames,
            message: `CI not all green. Failed: ${failedNames.join(", ")}. Fix issues, push, and re-run hy_ci.`,
        };
    }
    const next = transition(state, "merge");
    writeState(next);
    return {
        next: "merge",
        allGreen: true,
        checks: result.checks,
        message: "All CI checks passed. Ready to merge.",
    };
}
//# sourceMappingURL=ci.js.map