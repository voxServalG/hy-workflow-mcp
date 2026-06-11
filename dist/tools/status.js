import { legacyRuntimeDiagnostics, readState } from "../state.js";
import { toolResult } from "./_base.js";
import { initArtifactGuidance } from "./init.js";
export async function handleStatus() {
    const state = readState();
    const legacyDiagnostics = legacyRuntimeDiagnostics();
    const artifactGuidance = initArtifactGuidance();
    const r = toolResult(state.phase, {
        phase: state.phase,
        branch: state.branch,
        prNumber: state.prNumber,
        plan: state.plan?.task ?? null,
        approved: state.approval !== null,
        verified: state.verifyHash !== null,
        hint: legacyDiagnostics.length
            ? `Use phase, next, allowedTools, and action to decide the next safe tool call. Legacy runtime cleanup needed: ${legacyDiagnostics.map(d => d.remediation ?? d.message).join(" ")}`
            : "Use phase, next, allowedTools, and action to decide the next safe tool call.",
        allowedTools: [state.phase === "done" ? "hy_status" : `hy_${state.phase}`, "hy_status"],
        commitArtifacts: artifactGuidance.commitArtifacts,
        localArtifacts: artifactGuidance.localArtifacts,
        legacyDiagnostics: legacyDiagnostics.length ? legacyDiagnostics : undefined,
    });
    if (!state.plan) {
        r.action = {
            command: "hy_plan",
            when: "用户意图涉及开发任务时",
            triggerWords: ["计划一下", "plan it", "做个计划", "plan", "做计划", "plan this"],
        };
    }
    return r;
}
//# sourceMappingURL=status.js.map