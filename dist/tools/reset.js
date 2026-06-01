import { readState, writeState } from "../state.js";
export async function handleReset() {
    const state = readState();
    state.phase = "plan";
    state.branch = null;
    state.prNumber = null;
    state.plan = null;
    state.verifyHash = null;
    writeState(state);
    return {
        next: "plan",
        message: "Reset to plan phase. Run hy_plan to start a new task.",
    };
}
//# sourceMappingURL=reset.js.map