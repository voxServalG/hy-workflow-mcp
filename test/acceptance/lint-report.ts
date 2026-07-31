export type LintPressureSummary = {
  ok: boolean;
  status: number;
  files: number;
  docs: number;
  code: number;
  errors: number;
  warnings: number;
  failed: number;
  notApplicableRules: string[];
  notConfiguredRules: string[];
  durationMs: number;
};

const RULES = ["D001", "D002", "D003", "D004", "D005", "C001", "C002", "C003", "C004", "C005"] as const;
const STATUSES = new Set(["passed", "failed", "warning", "not_applicable", "not_configured"]);

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error("built-in lint report has invalid " + label);
  return Number(value);
}

export function validateLintPressureEnvelope(value: unknown, timeoutMs: number): LintPressureSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("built-in lint returned no structured execution envelope");
  const envelope = value as any;
  if (envelope.timedOut === true) throw new Error("built-in lint exceeded its pressure-test timeout");
  if (!Number.isInteger(envelope.status) || envelope.status < 0) throw new Error("built-in lint crashed or returned no numeric exit status");
  if (!Number.isFinite(envelope.durationMs) || envelope.durationMs < 0 || envelope.durationMs > timeoutMs) {
    throw new Error("built-in lint exceeded its measured execution budget");
  }

  const report = envelope.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("built-in lint returned invalid JSON");
  if (report.schema !== "hy-workflow.lint.v1" || report.version !== 1 || typeof report.ok !== "boolean" || typeof report.root !== "string") {
    throw new Error("built-in lint report schema is invalid");
  }
  const counts = report.counts;
  const files = nonNegativeInteger(counts?.files, "counts.files");
  const docs = nonNegativeInteger(counts?.docs, "counts.docs");
  const code = nonNegativeInteger(counts?.code, "counts.code");
  const errors = nonNegativeInteger(counts?.errors, "counts.errors");
  const warnings = nonNegativeInteger(counts?.warnings, "counts.warnings");
  const failed = nonNegativeInteger(counts?.failed, "counts.failed");
  const checksCount = nonNegativeInteger(counts?.checks, "counts.checks");
  if (docs <= 0) throw new Error("built-in doclint scanned zero documentation files");
  if (files < docs || files < code) throw new Error("built-in lint aggregate file counts are inconsistent");

  if (!Array.isArray(report.checks) || report.checks.length !== RULES.length || checksCount !== RULES.length) {
    throw new Error("built-in lint must report exactly D001-D005 and C001-C005");
  }
  const byRule = new Map<string, any>();
  for (const check of report.checks) {
    if (!check || typeof check !== "object" || !RULES.includes(check.rule) || byRule.has(check.rule)) throw new Error("built-in lint check identities are invalid");
    if (!STATUSES.has(check.status)) throw new Error("built-in lint check status is invalid for " + check.rule);
    nonNegativeInteger(check.files, check.rule + ".files");
    nonNegativeInteger(check.errors, check.rule + ".errors");
    nonNegativeInteger(check.warnings, check.rule + ".warnings");
    if (typeof check.message !== "string" || !check.message.trim()) throw new Error("built-in lint check message is missing for " + check.rule);
    byRule.set(check.rule, check);
  }
  if (RULES.some(rule => !byRule.has(rule))) throw new Error("built-in lint check set is incomplete");
  if (byRule.get("C003")?.status !== "not_configured") throw new Error("built-in lint C003 compatibility slot must remain not_configured");
  if (byRule.get("C004")?.status !== "not_applicable") throw new Error("built-in lint C004 compatibility slot must remain not_applicable");
  const failedChecks = report.checks.filter((check: any) => check.status === "failed").length;
  if (failed !== failedChecks) throw new Error("built-in lint failed-check count is inconsistent");

  if (!Array.isArray(report.findings)) throw new Error("built-in lint findings must be an array");
  const findingKeys: string[] = [];
  let findingErrors = 0;
  let findingWarnings = 0;
  for (const finding of report.findings) {
    if (!finding || typeof finding !== "object" || !RULES.includes(finding.rule)) throw new Error("built-in lint finding rule is invalid");
    if (finding.rule === "C003" || finding.rule === "C004") throw new Error("built-in lint compatibility-only dependency slots must not emit findings");
    if (finding.severity !== "error" && finding.severity !== "warning") throw new Error("built-in lint finding severity is invalid");
    if (typeof finding.path !== "string" || typeof finding.message !== "string" || !finding.message.trim()) throw new Error("built-in lint finding payload is invalid");
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) throw new Error("built-in lint finding line is invalid");
    if (finding.severity === "error") findingErrors += 1;
    else findingWarnings += 1;
    findingKeys.push([finding.rule, finding.path, finding.line ?? 0, finding.message].join("\u0000"));
  }
  if (JSON.stringify(findingKeys) !== JSON.stringify([...findingKeys].sort())) throw new Error("built-in lint findings are not deterministically sorted");
  if (errors !== findingErrors || warnings !== findingWarnings) throw new Error("built-in lint finding counts are inconsistent");
  if (report.ok !== (errors === 0 && failed === 0)) throw new Error("built-in lint ok flag is inconsistent");
  if ((envelope.status === 0) !== report.ok) throw new Error("built-in lint exit status is inconsistent with its report");

  return {
    ok: report.ok,
    status: envelope.status,
    files,
    docs,
    code,
    errors,
    warnings,
    failed,
    notApplicableRules: report.checks.filter((check: any) => check.status === "not_applicable").map((check: any) => check.rule),
    notConfiguredRules: report.checks.filter((check: any) => check.status === "not_configured").map((check: any) => check.rule),
    durationMs: envelope.durationMs,
  };
}
