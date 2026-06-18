import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBaseBranch } from "./state.js";
import { JS_TS_CODE_EXTS, PYTHON_CODE_EXTS, normalizeCodeExt } from "./code_ext.js";
// ── Helpers ──────────────────────────────────────────────────
function execOr(cmd, cwd) {
    try {
        const stdout = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
        return { ok: true, stdout: stdout.trim(), stderr: "" };
    }
    catch (e) {
        return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "" };
    }
}
function ok(title, layer, detail = "", hard = true) {
    return { layer, name: title, passed: true, detail: detail || "OK", hard };
}
function fail(title, layer, detail = "", hard = true) {
    return { layer, name: title, passed: false, detail: detail || "FAILED", hard };
}
function unique(values) {
    return [...new Set(values.filter(Boolean))].sort();
}
function findPython() {
    const candidates = ["python3", "python", "py"];
    for (const cmd of candidates) {
        try {
            execSync(`${cmd} --version`, { stdio: "ignore", timeout: 5_000 });
            return cmd;
        }
        catch { }
    }
    return "python3";
}
// ── 1. Lint (hard) ──────────────────────────────────────────
function numberFrom(...values) {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
    }
    return null;
}
function parseDocLintReport(report) {
    const counts = report?.data?.counts ?? report?.counts ?? {};
    const summary = report?.data?.summary ?? report?.summary ?? {};
    const failed = numberFrom(counts.failed, summary.failed, report?.failed);
    const errors = numberFrom(counts.errors, report?.errors, failed);
    const warnings = numberFrom(counts.warnings, report?.warnings, 0) ?? 0;
    const files = numberFrom(counts.files, summary.total, report?.total, 0) ?? 0;
    if (failed === null && errors === null && typeof report?.ok !== "boolean") {
        return fail("doclint", "lint", "Could not understand doclint JSON report", true);
    }
    const effectiveErrors = errors ?? failed ?? 0;
    const effectiveFailed = failed ?? effectiveErrors;
    const passed = report?.ok === false ? false : effectiveErrors === 0 && effectiveFailed === 0;
    const detail = `${effectiveErrors} errors, ${warnings} warnings (${files} files, ${effectiveFailed} failed)`;
    return passed
        ? ok("doclint", "lint", detail)
        : fail("doclint", "lint", detail, true);
}
export function runDocLint(root) {
    const r = execOr("npx --yes github:voxServalG/doclint lint --json", root);
    try {
        const report = JSON.parse(r.stdout || "{}");
        return [parseDocLintReport(report)];
    }
    catch {
        return [fail("doclint", "lint", "Could not parse doclint report", true)];
    }
}
export function runCodeLint(root) {
    const r = execOr("npx --yes github:voxServalG/codelint check --json", root);
    try {
        const report = JSON.parse(r.stdout || "{}");
        return [report.errors === 0
                ? ok("codelint", "lint", `${report.errors ?? 0} errors, ${report.warnings ?? 0} warnings`)
                : fail("codelint", "lint", `${report.errors} errors`, true)];
    }
    catch {
        return [fail("codelint", "lint", "Could not parse codelint report", true)];
    }
}
// ── 2. Compile (hard) ───────────────────────────────────────
function resolveCompileCmd(root) {
    const configPath = path.join(root, "codelint.json");
    if (!fs.existsSync(configPath))
        return null;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const exts = normalizeCodeExt(config.codeExt);
        if (exts.some(ext => JS_TS_CODE_EXTS.has(ext)))
            return "npx tsc --noEmit";
        if (exts.some(ext => PYTHON_CODE_EXTS.has(ext)))
            return `${findPython()} -m py_compile src/**/*.py`;
    }
    catch { }
    return null;
}
export function runCompile(root) {
    const cmd = resolveCompileCmd(root);
    if (!cmd)
        return [ok("compile", "compile", "No compile command configured (missing codelint.json)", false)];
    const r = execOr(cmd, root);
    return [r.ok
            ? ok("compile", "compile", "Build OK")
            : fail("compile", "compile", r.stderr || r.stdout || "Build failed", true)];
}
// ── 3. Scope (hard) ─────────────────────────────────────────
function parseNameStatus(output) {
    const modified = [];
    const added = [];
    const deleted = [];
    for (const line of output.split("\n").filter(Boolean)) {
        const parts = line.trim().split(/\t+/);
        const status = parts[0] ?? "";
        const first = parts[1] ?? "";
        const second = parts[2] ?? "";
        if (status.startsWith("R") || status.startsWith("C")) {
            if (first)
                deleted.push(first);
            if (second)
                added.push(second);
            continue;
        }
        if (status.includes("D")) {
            if (first)
                deleted.push(first);
            continue;
        }
        if (status.includes("A")) {
            if (first)
                added.push(first);
            continue;
        }
        if (first)
            modified.push(first);
    }
    return {
        modified: unique(modified),
        added: unique(added),
        deleted: unique(deleted),
    };
}
export function buildImplementationManifest(root) {
    const base = getBaseBranch(root);
    const diff = execOr(`git diff origin/${base} --name-status -- . ":(exclude)dist/*" ":(exclude)node_modules/*"`, root);
    if (!diff.ok)
        throw new Error(`git diff failed: ${diff.stderr}`);
    const parsed = parseNameStatus(diff.stdout);
    const untrackedResult = execOr(`git ls-files --others --exclude-standard -- . ":(exclude)dist/*" ":(exclude)node_modules/*"`, root);
    if (!untrackedResult.ok)
        throw new Error(`git ls-files failed: ${untrackedResult.stderr}`);
    const untracked = unique(untrackedResult.stdout.split("\n").filter(Boolean).map(s => s.trim()));
    return {
        ...parsed,
        untracked,
        changed: unique([...parsed.modified, ...parsed.added, ...parsed.deleted, ...untracked]),
    };
}
function isTestSupportFile(file) {
    const normalized = file.replace(/\\/g, "/");
    const base = path.basename(normalized);
    return (normalized.startsWith("tests/") ||
        base === "conftest.py" ||
        (base === "__init__.py" && normalized.includes("/tests/")) ||
        /^test[_-]/.test(base) ||
        /\.test\.[jt]sx?$/.test(base) ||
        /\.spec\.[jt]sx?$/.test(base));
}
function declaredDirectories(plan) {
    return new Set([...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete].map(file => path.posix.dirname(file.replace(/\\/g, "/"))));
}
function isWithinDeclaredDirectory(file, plan) {
    return declaredDirectories(plan).has(path.posix.dirname(file.replace(/\\/g, "/")));
}
function isAmendableScopeFile(file, plan) {
    return isTestSupportFile(file) || isWithinDeclaredDirectory(file, plan);
}
function emptyScopeAmendment() {
    return {
        changes: { add: [], remove: [] },
        new_files: { add: [], remove: [] },
        delete: { add: [], remove: [] },
    };
}
export function suggestPlanAmendment(plan, manifest) {
    const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
    const actual = manifest.changed;
    const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
    const amendableExtra = extra.filter(f => isAmendableScopeFile(f, plan));
    const notAmendableExtra = extra.filter(f => !isAmendableScopeFile(f, plan));
    const missing = declared.filter(f => !actual.includes(f));
    const scope = emptyScopeAmendment();
    for (const file of amendableExtra) {
        if (manifest.deleted.includes(file))
            scope.delete.add.push(file);
        else if (manifest.added.includes(file) || manifest.untracked.includes(file))
            scope.new_files.add.push(file);
        else
            scope.changes.add.push(file);
    }
    for (const file of missing) {
        if (plan.scope.changes.includes(file))
            scope.changes.remove.push(file);
        if (plan.scope.new_files.includes(file))
            scope.new_files.remove.push(file);
        if (plan.scope.delete.includes(file))
            scope.delete.remove.push(file);
    }
    const hasScopeChanges = [
        ...scope.changes.add,
        ...scope.changes.remove,
        ...scope.new_files.add,
        ...scope.new_files.remove,
        ...scope.delete.add,
        ...scope.delete.remove,
    ].length > 0;
    if (!hasScopeChanges)
        return null;
    scope.changes.add = unique(scope.changes.add);
    scope.changes.remove = unique(scope.changes.remove);
    scope.new_files.add = unique(scope.new_files.add);
    scope.new_files.remove = unique(scope.new_files.remove);
    scope.delete.add = unique(scope.delete.add);
    scope.delete.remove = unique(scope.delete.remove);
    return {
        reason: notAmendableExtra.length
            ? "Some scope drift is outside the amendable boundary; only safe amendments are suggested."
            : "Scope drift is limited to test support files or the already approved directory boundary.",
        scope,
        warnings: [
            ...missing.map(file => `Declared but not changed: ${file}`),
            ...notAmendableExtra.map(file => `Not amendable automatically: ${file}`),
        ],
    };
}
function isAmendOnlyFailure(plan, manifest) {
    const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
    const extra = manifest.changed.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
    return extra.length > 0 && extra.every(f => isAmendableScopeFile(f, plan));
}
export function runScopeCheck(root, plan, manifest) {
    const res = [];
    let actualManifest;
    try {
        actualManifest = manifest ?? buildImplementationManifest(root);
    }
    catch (e) {
        return [fail("scope", "scope", e.message ?? String(e))];
    }
    const actual = actualManifest.changed;
    const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
    const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
    if (extra.length) {
        const amendable = isAmendOnlyFailure(plan, actualManifest);
        res.push({
            ...fail("scope", "scope", `Unexpected changes: ${extra.join(", ")}`),
            classification: amendable ? "amend_required" : "hard_fail",
        });
    }
    else {
        res.push(ok("scope", "scope", `${actual.length} files, all in plan.scope`));
    }
    const missing = declared.filter(f => !actual.includes(f));
    if (missing.length) {
        res.push({
            ...fail("scope", "scope", `Declared but not changed: ${missing.join(", ")}`, false),
            classification: "warning",
        });
    }
    return res;
}
// ── 4. Boundary ──────────────────────────────────────────────
export function runBoundaryCheck(root, plan) {
    const res = [];
    for (const ep of plan.boundary.entry_points) {
        const r = execOr(ep, root);
        res.push(r.ok
            ? ok(`entry: ${ep.slice(0, 55)}...`, "boundary", "OK")
            : fail(`entry: ${ep.slice(0, 55)}...`, "boundary", r.stderr || r.stdout));
    }
    if (plan.boundary.no_new_external) {
        const r = execOr(`git diff origin/${getBaseBranch(root)}.. -- pyproject.toml setup.cfg setup.py requirements.txt policy.md`, root);
        res.push(r.stdout.trim()
            ? fail("no_new_external", "boundary", "Dependency file changed")
            : ok("no_new_external", "boundary", "No dep changes"));
    }
    return res;
}
// ── 5. Platform ──────────────────────────────────────────────
export function runPlatform(plan) {
    return plan.verify.platform.setup.map(cmd => {
        const r = execOr(cmd);
        return r.ok
            ? ok(`setup: ${cmd.slice(0, 50)}`, "platform", r.stdout || "OK")
            : fail(`setup: ${cmd.slice(0, 50)}`, "platform", r.stderr || r.stdout);
    });
}
// ── 6. Smoke & 7. Tests ──────────────────────────────────────
export function runSmoke(plan, root) {
    return runItems(plan.verify.smoke, "smoke", root);
}
export function runTests(plan, root) {
    return runItems(plan.verify.tests, "tests", root);
}
function runItems(items, layer, root) {
    return items.map(item => {
        const r = execOr(item.command, root);
        const exitOk = r.ok === (item.expected_exit === 0);
        return exitOk
            ? ok(item.description, layer, r.stdout || "OK")
            : fail(item.description, layer, r.stderr || r.stdout || "exit mismatch");
    });
}
export function runAllChecks(root, state) {
    const p = state.plan;
    const emptyManifest = { modified: [], added: [], deleted: [], untracked: [], changed: [] };
    if (!p)
        return {
            allPassed: false,
            hardFailed: 1,
            total: 1,
            checks: [fail("plan", "lint", "No plan")],
            status: "hard_fail",
            implementationManifest: emptyManifest,
            suggestedAmendment: null,
        };
    let implementationManifest = emptyManifest;
    let manifestError = null;
    try {
        implementationManifest = buildImplementationManifest(root);
    }
    catch (e) {
        manifestError = fail("scope", "scope", e.message ?? String(e));
    }
    const all = [
        ...runDocLint(root),
        ...runCodeLint(root),
        ...runCompile(root),
        ...(manifestError ? [manifestError] : runScopeCheck(root, p, implementationManifest)),
        ...runBoundaryCheck(root, p),
        ...runPlatform(p),
        ...runSmoke(p, root),
        ...runTests(p, root),
    ];
    const hardFailures = all.filter(c => c.hard && !c.passed);
    const suggestedAmendment = manifestError ? null : suggestPlanAmendment(p, implementationManifest);
    const status = hardFailures.length === 0
        ? "passed"
        : hardFailures.every(c => c.classification === "amend_required") && suggestedAmendment
            ? "amend_required"
            : "hard_fail";
    return {
        allPassed: all.every(c => c.passed || !c.hard),
        hardFailed: hardFailures.length,
        total: all.length,
        checks: all,
        status,
        implementationManifest,
        suggestedAmendment,
    };
}
//# sourceMappingURL=checks.js.map