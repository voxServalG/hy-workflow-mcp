import { execSync } from "node:child_process";
import type { CheckItem, PlanDoc, WorkflowState } from "./state.js";
import { currentBranch } from "./state.js";

// ── Result ───────────────────────────────────────────────────

export interface CheckResult {
  layer: string;
  name: string;
  passed: boolean;
  detail: string;
  hard: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

function execOr(cmd: string, cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 120_000 });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.trim() ?? "", stderr: e.stderr?.trim() ?? e.message ?? "" };
  }
}

function ok(title: string, layer: string, detail = "", hard = true): CheckResult {
  return { layer, name: title, passed: true, detail: detail || "OK", hard };
}
function fail(title: string, layer: string, detail = "", hard = true): CheckResult {
  return { layer, name: title, passed: false, detail: detail || "FAILED", hard };
}

// ── 1. Lint (hard) ──────────────────────────────────────────

export function runDocLint(root: string): CheckResult[] {
  const r = execOr("npx --yes doclint lint --json 2>/dev/null || true", root);
  try {
    const report = JSON.parse(r.stdout || "{}");
    return [report.failed === 0
      ? ok("doclint", "lint", `0 errors (${report.total ?? 0} files)`)
      : fail("doclint", "lint", `${report.failed} errors`, true)];
  } catch {
    return [fail("doclint", "lint", "Could not parse doclint report", true)];
  }
}

export function runCodeLint(root: string): CheckResult[] {
  const r = execOr("npx --yes codelint check --json 2>/dev/null || true", root);
  try {
    const report = JSON.parse(r.stdout || "{}");
    return [report.errors === 0
      ? ok("codelint", "lint", `${report.errors ?? 0} errors, ${report.warnings ?? 0} warnings`)
      : fail("codelint", "lint", `${report.errors} errors`, true)];
  } catch {
    return [fail("codelint", "lint", "Could not parse codelint report", true)];
  }
}

// ── 2. Scope (hard) ─────────────────────────────────────────

export function runScopeCheck(root: string, plan: PlanDoc): CheckResult[] {
  const res: CheckResult[] = [];
  const branch = currentBranch(root);
  const r = execOr(`git diff origin/dev..${branch} --name-only`, root);
  if (!r.ok) return [fail("scope", "scope", `git diff failed: ${r.stderr}`)];

  const actual = r.stdout.split("\n").filter(Boolean).map(s => s.trim());
  const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
  const extra = actual.filter(f => !declared.includes(f) && f !== ".hy/workflow.json");

  if (extra.length) {
    res.push(fail("scope", "scope", `Unexpected changes: ${extra.join(", ")}`));
  } else {
    res.push(ok("scope", "scope", `${actual.length} files, all in plan.scope`));
  }

  const missing = declared.filter(f => !actual.includes(f));
  if (missing.length) {
    res.push(fail("scope", "scope", `Declared but not changed: ${missing.join(", ")}`, false));
  }
  return res;
}

// ── 3. Boundary ──────────────────────────────────────────────

export function runBoundaryCheck(root: string, plan: PlanDoc): CheckResult[] {
  const res: CheckResult[] = [];

  for (const ep of plan.boundary.entry_points) {
    const r = execOr(`python3 -c "${ep}"`, root);
    res.push(r.ok
      ? ok(`entry: ${ep.slice(0, 55)}...`, "boundary", "OK")
      : fail(`entry: ${ep.slice(0, 55)}...`, "boundary", r.stderr || r.stdout));
  }

  if (plan.boundary.no_new_external) {
    const r = execOr("git diff origin/dev.. -- pyproject.toml setup.cfg setup.py requirements.txt", root);
    res.push(r.stdout.trim()
      ? fail("no_new_external", "boundary", "Dependency file changed")
      : ok("no_new_external", "boundary", "No dep changes"));
  }

  return res;
}

// ── 4. Platform ──────────────────────────────────────────────

export function runPlatform(plan: PlanDoc): CheckResult[] {
  return plan.verify.platform.setup.map(cmd => {
    const r = execOr(cmd);
    return r.ok
      ? ok(`setup: ${cmd.slice(0, 50)}`, "platform", r.stdout || "OK")
      : fail(`setup: ${cmd.slice(0, 50)}`, "platform", r.stderr || r.stdout);
  });
}

// ── 5. Smoke & 6. Tests ──────────────────────────────────────

export function runSmoke(plan: PlanDoc, root: string): CheckResult[] {
  return runItems(plan.verify.smoke, "smoke", root);
}
export function runTests(plan: PlanDoc, root: string): CheckResult[] {
  return runItems(plan.verify.tests, "tests", root);
}

function runItems(items: CheckItem[], layer: string, root: string): CheckResult[] {
  return items.map(item => {
    const r = execOr(item.command, root);
    const exitOk = r.ok === (item.expected_exit === 0);
    return exitOk
      ? ok(item.description, layer, r.stdout || "OK")
      : fail(item.description, layer, r.stderr || r.stdout || "exit mismatch");
  });
}

// ── Master ───────────────────────────────────────────────────

export interface VerifyReport {
  allPassed: boolean;
  hardFailed: number;
  total: number;
  checks: CheckResult[];
}

export function runAllChecks(root: string, state: WorkflowState): VerifyReport {
  const p = state.plan;
  if (!p) return { allPassed: false, hardFailed: 1, total: 1, checks: [fail("plan", "lint", "No plan")] };

  const all: CheckResult[] = [
    ...runDocLint(root),
    ...runCodeLint(root),
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
