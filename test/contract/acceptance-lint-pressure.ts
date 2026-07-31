import { existsSync, readFileSync } from "node:fs";
import { validateLintPressureEnvelope } from "../acceptance/lint-report.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const rules = ["D001", "D002", "D003", "D004", "D005", "C001", "C002", "C003", "C004", "C005"];

function makeReport(options: {
  statuses?: Record<string, string>;
  findings?: Array<{ rule: string; severity: "error" | "warning"; path: string; line?: number; message: string }>;
  docs?: number;
  code?: number;
} = {}): any {
  const statuses = { C003: "not_configured", C004: "not_applicable", ...(options.statuses ?? {}) };
  const findings = options.findings ?? [];
  const checks = rules.map(rule => {
    const own = findings.filter(finding => finding.rule === rule);
    return {
      rule,
      status: statuses[rule] ?? (own.some(finding => finding.severity === "error") ? "failed" : own.length ? "warning" : "passed"),
      files: rule.startsWith("D") ? (options.docs ?? 1) : (options.code ?? 2),
      errors: own.filter(finding => finding.severity === "error").length,
      warnings: own.filter(finding => finding.severity === "warning").length,
      message: rule + " evidence",
    };
  });
  const errors = findings.filter(finding => finding.severity === "error").length;
  const warnings = findings.filter(finding => finding.severity === "warning").length;
  const failed = checks.filter(check => check.status === "failed").length;
  const docs = options.docs ?? 1;
  const code = options.code ?? 2;
  return {
    schema: "hy-workflow.lint.v1",
    version: 1,
    ok: errors === 0 && failed === 0,
    root: "/fixture",
    counts: { checks: 10, failed, errors, warnings, files: docs + code, docs, code },
    checks,
    findings,
  };
}

function validate(report: any, status = report.ok ? 0 : 1): ReturnType<typeof validateLintPressureEnvelope> {
  return validateLintPressureEnvelope({ status, timedOut: false, durationMs: 25, report }, 120_000);
}

function rejects(report: any, status: number, message: string): void {
  try { validate(report, status); } catch { return; }
  throw new Error(message);
}

const clean = validate(makeReport());
assert(clean.ok && clean.docs === 1 && clean.code === 2 && clean.notConfiguredRules.includes("C003") && clean.notApplicableRules.includes("C004"), "clean internal lint report must preserve both fixed dependency compatibility statuses");

const warningFinding = { rule: "C002", severity: "warning" as const, path: "src/large.py", line: 301, message: "effective line warning" };
const warning = validate(makeReport({ findings: [warningFinding] }));
assert(warning.ok && warning.warnings === 1 && warning.status === 0, "warning-only internal lint must remain nonblocking");

const errorFinding = { rule: "C005", severity: "error" as const, path: "src/broken.py", line: 1, message: "parse failure" };
const dirty = validate(makeReport({ findings: [errorFinding] }), 1);
assert(!dirty.ok && dirty.errors === 1 && dirty.failed === 1, "structured OSS lint errors must remain inspectable without being mistaken for an engine crash");

const unsupported = validate(makeReport({ statuses: { C005: "not_applicable" } }));
assert(unsupported.ok && unsupported.notConfiguredRules.join(",") === "C003" && unsupported.notApplicableRules.join(",") === "C004,C005", "unsupported languages must preserve compatibility statuses while reporting parser N/A evidence");

rejects(makeReport({ docs: 0 }), 0, "zero-document scan must fail pressure validation");
rejects(makeReport(), 1, "clean report with a failing exit must be rejected");
rejects(makeReport({ statuses: { C003: "passed" } }), 0, "C003 must not be reactivated through report status drift");
rejects(makeReport({ statuses: { C004: "passed" } }), 0, "C004 must not be reactivated through report status drift");
rejects(makeReport({ findings: [{ rule: "C004", severity: "warning", path: "src/app.ts", message: "legacy dependency finding" }] }), 0, "compatibility-only dependency slots must reject findings");
const missingRule = makeReport();
missingRule.checks.pop();
rejects(missingRule, 0, "missing D/C rule must be rejected");
const unsorted = makeReport({ findings: [
  { rule: "D003", severity: "warning", path: "z.md", message: "z" },
  { rule: "C002", severity: "warning", path: "a.py", message: "a" },
] });
rejects(unsorted, 0, "nondeterministically ordered findings must be rejected");

const scenarios = readFileSync("test/acceptance/scenarios.ts", "utf8");
const runner = readFileSync("test/acceptance/runner.ts", "utf8");
const harness = readFileSync("test/acceptance/harness.ts", "utf8");
assert(!existsSync("test/acceptance/lint-pressure-child.mjs"), "external lint child must be removed");
for (const token of ["codeload.github.com", "DOCLINT_SOURCE", "CODELINT_SOURCE", "HY_ACCEPTANCE_LINT_ARCHIVE_DIR", "prepareLintPressurePackages"]) {
  assert(!scenarios.includes(token) && !runner.includes(token) && !harness.includes(token), "acceptance must not retain external lint token " + token);
}
for (const token of ['run("hy-workflow", ["lint", "--json"]', "validateLintPressureEnvelope", "assertCompatibilityUnchanged", "LINT_PRESSURE_TIMEOUT_MS", "PARSER_SCANNER_EXTENSIONS", 'summary.notConfiguredRules.includes("C003")', 'summary.notApplicableRules.includes("C004")', "unsupported language did not report C005 as N/A", "lintPressure"]) {
  assert(scenarios.includes(token), "real-repository internal lint pressure scenario is missing " + token);
}
const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
assert(packageScripts["test:acceptance:pressure"]?.includes("--profile release"), "baseline must not weaken release lint pressure");

console.log("acceptance-lint-pressure: unified report, timeout, installed-package, N/A, and zero-mutation contracts pass");
