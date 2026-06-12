import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBaseBranch } from "./state.js";
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
        if (config.codeExt === ".ts")
            return "npx tsc --noEmit";
        if (config.codeExt === ".py")
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
export function runScopeCheck(root, plan) {
    const res = [];
    const base = getBaseBranch(root);
    const r = execOr(`git diff origin/${base} --name-only -- . ":(exclude)dist/*" ":(exclude)node_modules/*"`, root);
    if (!r.ok)
        return [fail("scope", "scope", `git diff failed: ${r.stderr}`)];
    const actual = r.stdout.split("\n").filter(Boolean).map(s => s.trim());
    const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
    const extra = actual.filter(f => !declared.includes(f) && !f.startsWith(".hy/"));
    if (extra.length) {
        res.push(fail("scope", "scope", `Unexpected changes: ${extra.join(", ")}`));
    }
    else {
        res.push(ok("scope", "scope", `${actual.length} files, all in plan.scope`));
    }
    const missing = declared.filter(f => !actual.includes(f));
    if (missing.length) {
        res.push(fail("scope", "scope", `Declared but not changed: ${missing.join(", ")}`, false));
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
    if (!p)
        return { allPassed: false, hardFailed: 1, total: 1, checks: [fail("plan", "lint", "No plan")] };
    const all = [
        ...runDocLint(root),
        ...runCodeLint(root),
        ...runCompile(root),
        ...runScopeCheck(root, p),
        ...runBoundaryCheck(root, p),
        ...runPlatform(p),
        ...runSmoke(p, root),
        ...runTests(p, root),
    ];
    return {
        allPassed: all.every(c => c.passed || !c.hard),
        hardFailed: all.filter(c => c.hard && !c.passed).length,
        total: all.length,
        checks: all,
    };
}
//# sourceMappingURL=checks.js.map