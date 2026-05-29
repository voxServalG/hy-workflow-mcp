import { readState, writeState, transition, assertPhase } from "../state.js";
export async function handleApprove(args) {
    const state = readState();
    assertPhase(state, "plan", "approve");
    if (!args.approved) {
        // User rejected → back to plan
        const next = transition(state, "plan");
        next.approval = { time: new Date().toISOString(), note: args.note ?? "Rejected by user" };
        writeState(next);
        return { next: "plan", approved: false, note: args.note };
    }
    // User approved
    const approval = { time: new Date().toISOString(), note: args.note ?? "Approved" };
    const next = transition(state, "branch");
    next.approval = approval;
    writeState(next);
    return { next: "branch", approved: true, plan: state.plan?.task };
}
//# sourceMappingURL=approve.js.map