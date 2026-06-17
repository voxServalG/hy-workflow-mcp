import { readState, writeState, transition, assertPhase, projectRoot, computeVerifyHash, computePlanHash } from "../state.js";
import { buildImplementationManifest, runAllChecks } from "../checks.js";
import { implementationDigest } from "./sync_docs.js";
import { toolResult } from "./_base.js";
export async function handleVerify() {
    const state = readState();
    assertPhase(state, "edit", "verify");
    if (!state.plan)
        return toolResult("verify", { phase: state.phase, error: "No plan", allowedTools: ["hy_status"] });
    const planHash = computePlanHash(state.plan);
    const afterEdit = state.documentReads?.afterEdit;
    if (!planHash || afterEdit?.planHash !== planHash) {
        return toolResult("edit", {
            phase: state.phase,
            error: "after_edit document audit is required before hy_verify.",
            hint: "Call hy_read_docs with { stage: \"after_edit\" }, then hy_sync_docs, then rerun hy_verify.",
            allowedTools: ["hy_read_docs", "hy_status"],
            blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
        });
    }
    const syncDocs = state.syncDocs;
    if (syncDocs?.planHash !== planHash || syncDocs.afterEditDigest !== afterEdit.digest) {
        return toolResult("edit", {
            phase: state.phase,
            error: "hy_sync_docs is required after hy_read_docs(after_edit) and before hy_verify.",
            hint: "Call hy_sync_docs to confirm the document sync gate, then rerun hy_verify.",
            allowedTools: ["hy_sync_docs", "hy_status"],
            blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
        });
    }
    const root = projectRoot();
    const currentImplementationDigest = implementationDigest(root, state.plan, buildImplementationManifest(root));
    if (syncDocs.implementationDigest !== currentImplementationDigest) {
        return toolResult("edit", {
            phase: state.phase,
            error: "Implementation diff changed after hy_sync_docs.",
            hint: "Rerun hy_read_docs with { stage: \"after_edit\" }, then hy_sync_docs, then hy_verify so the document audit matches the final implementation diff.",
            allowedTools: ["hy_read_docs", "hy_status"],
            blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
        });
    }
    const report = runAllChecks(root, state);
    if (!report.allPassed) {
        if (report.status === "amend_required" && report.suggestedAmendment) {
            const next = transition(state, "verify");
            next.pendingAmendment = report.suggestedAmendment;
            next.implementationManifest = report.implementationManifest;
            next.verifyHash = null;
            writeState(next);
            return toolResult("verify", {
                passed: false,
                allPassed: false,
                status: "amend_required",
                total: report.total,
                checks: report.checks,
                implementationManifest: report.implementationManifest,
                suggestedAmendment: report.suggestedAmendment,
                display: {
                    title: "Plan amendment required",
                    body: [
                        "hy_verify found scope drift that appears to stay inside the approved task boundary.",
                        "Review suggestedAmendment, then call hy_amend_plan with approved='approve' to apply it.",
                    ].join("\n"),
                },
                requires_user: true,
                stop_here: true,
                hint: "Show the suggested amendment to the user. If approved, call hy_amend_plan, then rerun hy_verify. Do not reset to plan for amendable scope drift.",
                allowedTools: ["hy_amend_plan", "hy_verify", "hy_status"],
                blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
                recovery: {
                    tool: "hy_amend_plan",
                    instruction: "Apply the pending plan amendment only after explicit user approval, then rerun hy_verify.",
                },
                message: "Scope drift can be handled with hy_amend_plan. Await approval before amending.",
            });
        }
        const next = transition(state, "edit");
        next.pendingAmendment = report.suggestedAmendment;
        next.implementationManifest = report.implementationManifest;
        next.verifyHash = null;
        writeState(next);
        const failedChecks = report.checks.filter(c => c.hard && !c.passed).map(c => `${c.layer}/${c.name}`);
        return toolResult("edit", {
            passed: false,
            allPassed: false,
            status: report.status,
            hardFailed: report.hardFailed,
            total: report.total,
            checks: report.checks,
            failedChecks,
            implementationManifest: report.implementationManifest,
            suggestedAmendment: report.suggestedAmendment,
            hint: "Do not call hy_commit. Inspect failed check layers, fix the minimal cause, then rerun hy_verify.",
            allowedTools: ["hy_edit", "hy_verify", "hy_status"],
            blockedTools: ["hy_commit", "hy_ci", "hy_merge", "hy_chain"],
            recovery: {
                tool: "hy_edit",
                instruction: "Fix failed checks, then rerun hy_verify.",
                byLayer: {
                    lint: "Fix formatting, imports, naming, or static rule violations without changing business behavior just to silence lint.",
                    compile: "Fix types, imports, exports, or build configuration.",
                    scope: "Remove unintended scope-out changes. If verify returns amend_required, use hy_amend_plan instead of resetting to plan.",
                    boundary: "Fix real entry points or module boundaries; do not replace checks with hollow commands.",
                    platform: "Fix setup or dependency assumptions; do not skip setup silently.",
                    smoke: "Fix the smallest executable path covered by the smoke check.",
                    tests: "Fix code or tests; do not delete failing tests or weaken assertions.",
                },
            },
            message: `${report.hardFailed} checks failed: ${failedChecks.join(", ")}. Fix and re-run hy_verify.`,
        });
    }
    // All passed
    const next = transition(state, "commit");
    next.verifyHash = computeVerifyHash(next);
    next.pendingAmendment = null;
    next.implementationManifest = report.implementationManifest;
    writeState(next);
    return toolResult("commit", {
        passed: true,
        allPassed: true,
        status: report.status,
        checks: report.checks,
        implementationManifest: report.implementationManifest,
        verifyHash: next.verifyHash,
        hint: "Verification passed. Call hy_commit next to create the PR; do not edit files without rerunning hy_verify.",
        allowedTools: ["hy_commit", "hy_status"],
        blockedTools: ["hy_ci", "hy_merge", "hy_chain"],
        message: `All ${report.total} checks passed. Ready to commit.`,
    });
}
//# sourceMappingURL=verify.js.map