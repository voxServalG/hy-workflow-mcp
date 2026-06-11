import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch } from "../state.js";
import { checkout, pull, rebaseDev, pushForce } from "../git.js";
import { toolResult } from "./_base.js";
export async function handleChain(args) {
    const state = readState();
    assertPhase(state, "chain");
    const root = projectRoot();
    const results = [];
    const base = getBaseBranch(root);
    // Pull latest base
    checkout(root, base);
    pull(root);
    for (const br of args.branches) {
        checkout(root, br);
        const r = rebaseDev(root);
        if (!r.ok) {
            return toolResult("chain", {
                error: `Rebase failed for ${br}: ${r.error}`,
                done: results,
                recovery: { tool: "hy_chain", instruction: "Resolve the rebase conflict manually, then rerun hy_chain for remaining downstream branches." },
                allowedTools: ["hy_chain", "hy_status"],
            });
        }
        pushForce(root, br);
        results.push(`${br}: rebased + pushed`);
    }
    checkout(root, base);
    const next = transition(state, "done");
    writeState(next);
    return toolResult("done", {
        done: results,
        display: {
            title: "Workflow complete",
            body: `Rebased ${results.length} downstream branches.`,
        },
        hint: "Workflow is complete. No further hy-workflow tool is required unless starting a new task.",
        allowedTools: ["hy_status"],
        message: `Rebased ${results.length} branches. Workflow complete. All downstream branches synced.`,
    });
}
//# sourceMappingURL=chain.js.map