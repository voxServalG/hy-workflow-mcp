export type LintPressureTool = "doclint" | "codelint";

export type LintPressureSummary = {
  tool: LintPressureTool;
  ok: boolean;
  status: number;
  files: number;
  errors: number;
  failed: number;
  notApplicable: boolean;
  projectFiles: number;
  supportedFiles: number;
  durationMs: number;
};

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function nestedNumber(report: any, key: string): number | null {
  return numberFrom(
    report?.data?.counts?.[key], report?.counts?.[key],
    report?.data?.summary?.[key], report?.summary?.[key],
    report?.data?.[key], report?.[key],
  );
}

export function validateLintPressureEnvelope(
  value: unknown,
  expectedTool: LintPressureTool,
  requireClean: boolean,
  timeoutMs: number,
): LintPressureSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(expectedTool + " pressure child returned no structured envelope");
  const envelope = value as any;
  if (envelope.tool !== expectedTool) throw new Error(expectedTool + " pressure child returned the wrong tool identity");
  if (envelope.timedOut === true) throw new Error(expectedTool + " exceeded its pressure-test timeout");
  if (!Number.isInteger(envelope.status) || envelope.status < 0) throw new Error(expectedTool + " crashed or returned no numeric exit status");
  if (!Number.isFinite(envelope.durationMs) || envelope.durationMs < 0 || envelope.durationMs > timeoutMs) {
    throw new Error(expectedTool + " exceeded its measured execution budget");
  }
  const report = envelope.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error(expectedTool + " returned an invalid JSON report shape");
  }
  const hasOk = Object.prototype.hasOwnProperty.call(report, "ok");
  if ((expectedTool === "doclint" && typeof report.ok !== "boolean")
    || (expectedTool === "codelint" && hasOk && typeof report.ok !== "boolean")) {
    throw new Error(expectedTool + " returned an invalid JSON report shape");
  }
  const errors = nestedNumber(report, "errors");
  const failed = nestedNumber(report, "failed");
  const files = numberFrom(
    nestedNumber(report, "files"), nestedNumber(report, "total_files"),
    nestedNumber(report, "totalFiles"), nestedNumber(report, "total"),
  );
  if (errors === null || errors < 0 || files === null || files < 0 || (expectedTool === "doclint" && (failed === null || failed < 0))) {
    throw new Error(expectedTool + " report is missing non-negative counts");
  }
  const failedCount = failed ?? errors;
  if (failedCount < 0) throw new Error(expectedTool + " report contains a negative failed count");
  const acceptedOk = expectedTool === "doclint" ? report.ok === true : !hasOk || report.ok === true;
  let notApplicable = false;
  let projectFiles = 0;
  let supportedFiles = 0;
  if (expectedTool === "doclint") {
    if (files <= 0) throw new Error("doclint report contains no real scanned-file evidence");
  } else {
    const profile = envelope.projectProfile;
    projectFiles = profile?.codeFiles;
    supportedFiles = profile?.supportedCodeFiles;
    if (!Number.isInteger(projectFiles) || projectFiles <= 0 || !Number.isInteger(supportedFiles) || supportedFiles < 0 || supportedFiles > projectFiles) {
      throw new Error("codelint pressure child returned no trustworthy installed project-profile evidence");
    }
    notApplicable = supportedFiles === 0;
    if (notApplicable && files !== 0) throw new Error("codelint scanned files outside its pinned Python/Rust support matrix");
    if (!notApplicable && files <= 0) throw new Error("codelint scanned zero supported Python/Rust files");
    if (!acceptedOk && (requireClean || errors === 0 || failedCount === 0 || envelope.status === 0)) {
      throw new Error("codelint returned an explicit non-true ok value without consistent OSS finding evidence");
    }
    if (notApplicable && (errors !== 0 || failedCount !== 0 || envelope.status !== 0)) {
      throw new Error("codelint N/A must be a structured zero-count successful invocation");
    }
  }
  const clean = !notApplicable && acceptedOk && errors === 0 && failedCount === 0;
  if (envelope.status !== 0 && clean) throw new Error(expectedTool + " returned a failing exit status for a clean report");
  if (requireClean && !notApplicable && !clean) throw new Error(expectedTool + " must pass on a maintained legacy target");
  return {
    tool: expectedTool,
    ok: clean,
    status: envelope.status,
    files,
    errors,
    failed: failedCount,
    notApplicable,
    projectFiles,
    supportedFiles,
    durationMs: envelope.durationMs,
  };
}
