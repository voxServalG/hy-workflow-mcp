import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
// ── State path ───────────────────────────────────────────────
const RUNTIME_STATE_FILE = path.join("hy-workflow", "workflow.json");
const RUNTIME_SCOPE_FILE = path.join("hy-workflow", "scope.json");
const LEGACY_STATE_FILE = path.join(".hy", "workflow.json");
const LEGACY_SCOPE_FILE = path.join(".hy", "scope.json");
export function statePath() {
    return gitPrivatePath(projectRoot(), RUNTIME_STATE_FILE);
}
export function scopePath() {
    return gitPrivatePath(projectRoot(), RUNTIME_SCOPE_FILE);
}
function legacyStatePath(root) {
    return path.join(root, LEGACY_STATE_FILE);
}
function legacyScopePath(root) {
    return path.join(root, LEGACY_SCOPE_FILE);
}
function gitPrivatePath(root, relativePath) {
    try {
        const resolved = execSync(`git rev-parse --git-path ${relativePath}`, { cwd: root })
            .toString()
            .trim();
        return path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
    }
    catch {
        return path.join(root, ".git", relativePath);
    }
}
export function projectRoot() {
    let dir = process.cwd();
    while (dir !== "/") {
        if (fs.existsSync(path.join(dir, ".git")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return process.cwd();
}
function isTracked(root, file) {
    try {
        execSync(`git ls-files --error-unmatch -- "${file}"`, { cwd: root, stdio: "ignore" });
        return true;
    }
    catch (e) {
        if (e.status === 1)
            return false;
        return null;
    }
}
export function legacyRuntimeDiagnostics(root = projectRoot()) {
    const diagnostics = [];
    for (const file of [LEGACY_STATE_FILE, LEGACY_SCOPE_FILE]) {
        const fullPath = path.join(root, file);
        if (!fs.existsSync(fullPath))
            continue;
        const tracked = isTracked(root, file);
        if (tracked === true) {
            diagnostics.push({
                file,
                tracked: true,
                message: `${file} is legacy hy-workflow runtime metadata tracked by Git and may block branch checkout.`,
                remediation: `Run git rm --cached ${file} and add .hy/ to .gitignore, then commit that cleanup.`,
            });
            continue;
        }
        if (tracked === null) {
            diagnostics.push({
                file,
                tracked: false,
                message: `${file} exists but Git tracking status could not be determined, so hy-workflow will not delete it automatically.`,
            });
        }
    }
    return diagnostics;
}
export function cleanupLegacyRuntimeFiles(root = projectRoot()) {
    for (const file of [LEGACY_STATE_FILE, LEGACY_SCOPE_FILE]) {
        const fullPath = path.join(root, file);
        if (!fs.existsSync(fullPath))
            continue;
        const tracked = isTracked(root, file);
        if (tracked === false) {
            try {
                fs.unlinkSync(fullPath);
            }
            catch { }
        }
    }
}
// ── Read / Write ─────────────────────────────────────────────
export function readState() {
    const root = projectRoot();
    const p = statePath();
    if (!fs.existsSync(p)) {
        const legacy = legacyStatePath(root);
        if (fs.existsSync(legacy)) {
            const state = JSON.parse(fs.readFileSync(legacy, "utf-8"));
            try {
                writeState(state);
                cleanupLegacyRuntimeFiles(root);
            }
            catch { }
            return state;
        }
        cleanupLegacyRuntimeFiles(root);
        return {
            version: "1",
            phase: "init",
            branch: null,
            prNumber: null,
            plan: null,
            approval: null,
            verifyHash: null,
        };
    }
    const raw = fs.readFileSync(p, "utf-8");
    cleanupLegacyRuntimeFiles(root);
    return JSON.parse(raw);
}
export function writeState(state) {
    const dir = path.dirname(statePath());
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
}
// ── Phase transitions ────────────────────────────────────────
const VALID_TRANSITIONS = {
    init: ["init", "plan", "done"],
    plan: ["plan", "approve", "done"],
    approve: ["approve", "branch", "plan"], // plan = retry after reject
    branch: ["branch", "edit", "done"],
    edit: ["edit", "verify", "commit", "done"],
    verify: ["verify", "edit", "commit", "done"], // edit = fix, commit = pass
    commit: ["commit", "ci", "done"],
    ci: ["ci", "edit", "merge", "done"], // edit = fix, merge = pass
    merge: ["merge", "chain", "done"],
    chain: ["chain", "done"],
    done: ["done"],
};
export function assertPhase(state, ...expected) {
    if (!expected.includes(state.phase)) {
        throw new StateError(`Phase "${state.phase}" is not in [${expected.join(", ")}]. ` +
            `You may need to call a prior tool first. Current valid transitions: ` +
            `${VALID_TRANSITIONS[state.phase]?.join(" → ") ?? "none"}.`);
    }
}
export function transition(state, to) {
    const allowed = VALID_TRANSITIONS[state.phase];
    if (!allowed?.includes(to)) {
        throw new StateError(`Cannot transition from "${state.phase}" to "${to}". ` +
            `Allowed transitions from "${state.phase}": ${allowed?.join(", ") ?? "none"}.`);
    }
    return { ...state, phase: to };
}
export class StateError extends Error {
    constructor(message) {
        super(message);
        this.name = "StateError";
    }
}
// ── Hash ─────────────────────────────────────────────────────
export function computeVerifyHash(state) {
    const payload = JSON.stringify({
        plan: state.plan?.task,
        scope: state.plan?.scope,
        boundary: state.plan?.boundary,
        rubrics: state.plan?.verify,
    });
    const hash = createHash("sha256");
    hash.update(payload);
    return hash.digest("hex").slice(0, 12);
}
export function computePlanHash(plan) {
    if (!plan)
        return null;
    const payload = JSON.stringify({
        task: plan.task,
        scope: plan.scope,
        boundary: plan.boundary,
        verify: plan.verify,
        risks: plan.risks,
        discussion: plan.discussion,
    });
    const hash = createHash("sha256");
    hash.update(payload);
    return hash.digest("hex").slice(0, 12);
}
function gate(status, reason, expected, actual) {
    return { status, reason, expected, actual };
}
export function documentReadHealth(state, currentImplementationDigest) {
    const planHash = computePlanHash(state.plan);
    const reads = state.documentReads ?? {};
    const beforePlan = reads.beforePlan ?? null;
    const beforeApprove = reads.beforeApprove ?? null;
    const afterEdit = reads.afterEdit ?? null;
    const syncDocs = state.syncDocs ?? null;
    const gates = {
        beforePlan: !beforePlan
            ? gate("missing", "before_plan document baseline is missing.")
            : state.plan && beforePlan.task !== state.plan.task
                ? gate("stale", "before_plan task does not match the current PlanDoc task.", state.plan.task, beforePlan.task)
                : gate("current", "before_plan document baseline matches the current task."),
        beforeApprove: !beforeApprove
            ? gate("missing", "before_approve document audit is missing.")
            : !planHash || beforeApprove.planHash !== planHash
                ? gate("stale", "before_approve plan hash does not match the current PlanDoc.", planHash, beforeApprove.planHash)
                : gate("current", "before_approve document audit matches the current PlanDoc."),
        afterEdit: !afterEdit
            ? gate("missing", "after_edit document audit is missing.")
            : !planHash || afterEdit.planHash !== planHash
                ? gate("stale", "after_edit plan hash does not match the current PlanDoc.", planHash, afterEdit.planHash)
                : currentImplementationDigest && afterEdit.implementationDigest !== currentImplementationDigest
                    ? gate("stale", "after_edit implementation digest does not match the current implementation diff.", currentImplementationDigest, afterEdit.implementationDigest)
                    : gate("current", "after_edit document audit matches the current PlanDoc and implementation diff."),
        syncDocs: !syncDocs
            ? gate("missing", "hy_sync_docs record is missing.")
            : !planHash || syncDocs.planHash !== planHash
                ? gate("stale", "hy_sync_docs plan hash does not match the current PlanDoc.", planHash, syncDocs.planHash)
                : afterEdit && syncDocs.afterEditDigest !== afterEdit.digest
                    ? gate("stale", "hy_sync_docs was recorded for a different after_edit document audit.", afterEdit.digest, syncDocs.afterEditDigest)
                    : currentImplementationDigest && syncDocs.implementationDigest !== currentImplementationDigest
                        ? gate("stale", "hy_sync_docs implementation digest does not match the current implementation diff.", currentImplementationDigest, syncDocs.implementationDigest)
                        : gate("current", "hy_sync_docs record matches the current PlanDoc and after_edit audit."),
    };
    const staleDocumentReads = Object.keys(gates).filter(name => gates[name].status === "stale");
    const missingDocumentReads = Object.keys(gates).filter(name => gates[name].status === "missing");
    const okForApprove = gates.beforeApprove.status === "current";
    const okForVerify = gates.afterEdit.status === "current" && gates.syncDocs.status === "current";
    let blockedBy = null;
    if (state.phase === "approve" && !okForApprove) {
        blockedBy = { gate: "beforeApprove", tool: "hy_read_docs", arguments: { stage: "before_approve" }, reason: gates.beforeApprove.reason };
    }
    else if ((state.phase === "edit" || state.phase === "verify") && gates.afterEdit.status !== "current") {
        blockedBy = { gate: "afterEdit", tool: "hy_read_docs", arguments: { stage: "after_edit" }, reason: gates.afterEdit.reason };
    }
    else if ((state.phase === "edit" || state.phase === "verify") && gates.syncDocs.status !== "current") {
        blockedBy = { gate: "syncDocs", tool: "hy_sync_docs", reason: gates.syncDocs.reason };
    }
    return { planHash, gates, staleDocumentReads, missingDocumentReads, blockedBy, okForApprove, okForVerify };
}
// ── Branch name ──────────────────────────────────────────────
export function currentBranch(root) {
    try {
        return execSync("git branch --show-current", { cwd: root })
            .toString().trim();
    }
    catch {
        return "unknown";
    }
}
export function getBaseBranch(root) {
    try {
        const configPath = path.join(root, "codelint.json");
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (config.baseBranch)
                return config.baseBranch;
        }
    }
    catch { }
    return "dev";
}
//# sourceMappingURL=state.js.map