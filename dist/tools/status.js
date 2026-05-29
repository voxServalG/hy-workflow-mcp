import { readState } from "../state.js";
export async function handleStatus() {
    const state = readState();
    return {
        phase: state.phase,
        branch: state.branch,
        prNumber: state.prNumber,
        plan: state.plan?.task ?? null,
        approved: state.approval !== null,
        verified: state.verifyHash !== null,
        next: state.phase,
    };
}
//# sourceMappingURL=status.js.map