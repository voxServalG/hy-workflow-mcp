import { readState, writeState, transition, assertPhase, scopePath } from "../state.js";
import { toolResult } from "./_base.js";
import * as fs from "node:fs";
import * as path from "node:path";
// hy_edit doesn't advance phase — it just validates the scope.
// The LLM uses standard Read/Edit/Write tools for actual editing.
// This tool locks scope and returns context.
export async function handleEdit() {
    const state = readState();
    assertPhase(state, "branch", "edit", "verify"); // can re-enter from verify (fix cycle)
    if (!state.plan)
        return toolResult("edit", { error: "No plan", allowedTools: ["hy_status"] });
    // Lock scope in git-private storage so workflow metadata stays out of the worktree.
    const scopeJson = {
        task: state.plan.task,
        scope: state.plan.scope,
        boundary: state.plan.boundary,
        rubrics: state.plan.verify,
        branch: state.branch,
    };
    const target = scopePath();
    const dir = path.dirname(target);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(scopeJson, null, 2) + "\n", "utf-8");
    // Transition to edit if coming from branch or verify
    if (state.phase === "branch" || state.phase === "verify") {
        const next = transition(state, "edit");
        writeState(next);
    }
    return toolResult("verify", {
        phase: "edit",
        branch: state.branch,
        scope: state.plan.scope,
        boundary: state.plan.boundary,
        display: {
            title: "Scope locked",
            body: `Edit only files declared in plan.scope, then run hy_verify.`,
        },
        hint: "Use standard file editing tools only within plan.scope. When edits are complete, run hy_verify.",
        allowedTools: ["hy_verify", "hy_edit", "hy_status"],
        blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
        message: `Scope locked. Edit files within plan.scope: ${state.plan.scope.changes.join(", ")}. When done, run hy_verify.`,
    });
}
//# sourceMappingURL=edit.js.map