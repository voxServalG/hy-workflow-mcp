import { readFileSync } from "node:fs";
import { validateLintPressureEnvelope } from "../acceptance/lint-report.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(value: unknown, tool: "doclint" | "codelint", requireClean: boolean, message: string): void {
  try {
    validateLintPressureEnvelope(value, tool, requireClean, 120_000);
  } catch {
    return;
  }
  throw new Error(message);
}

const supportedProfile = { kind: "python", codeExt: [".py"], lintDirs: ["src"], codeFiles: 12, supportedCodeFiles: 12 };
const unsupportedProfile = { kind: "typescript", codeExt: [".ts"], lintDirs: ["src"], codeFiles: 18, supportedCodeFiles: 0 };

const cleanDoc = validateLintPressureEnvelope({
  tool: "doclint", status: 0, timedOut: false, durationMs: 100,
  report: { ok: true, errors: 0, failed: 0, files: 8 },
}, "doclint", true, 120_000);
assert(cleanDoc.ok && cleanDoc.files === 8, "clean maintained doclint baseline must pass");

const dirtyOss = validateLintPressureEnvelope({
  tool: "codelint", status: 0, timedOut: false, durationMs: 200,
  projectProfile: supportedProfile,
  report: { counts: { errors: 3, files: 40 } },
}, "codelint", false, 120_000);
assert(!dirtyOss.ok && dirtyOss.errors === 3 && dirtyOss.files === 40, "OSS rule findings may be reported without becoming an acceptance crash");

const explicitDirtyOss = validateLintPressureEnvelope({
  tool: "codelint", status: 1, timedOut: false, durationMs: 210,
  projectProfile: supportedProfile,
  report: { ok: false, errors: 3, total_files: 40 },
}, "codelint", false, 120_000);
assert(!explicitDirtyOss.ok && explicitDirtyOss.errors === 3 && explicitDirtyOss.status === 1, "explicit codelint failure with positive counts and a failing native exit must remain inspectable on OSS");

const nativeCleanCode = validateLintPressureEnvelope({
  tool: "codelint", status: 0, timedOut: false, durationMs: 150,
  projectProfile: supportedProfile,
  report: { errors: 0, warnings: 0, total_files: 3 },
}, "codelint", true, 120_000);
assert(nativeCleanCode.ok && nativeCleanCode.files === 3, "native codelint output may omit ok when its required counts prove a clean scan");

const nativeNotApplicable = validateLintPressureEnvelope({
  tool: "codelint", status: 0, timedOut: false, durationMs: 120,
  projectProfile: unsupportedProfile,
  report: { errors: 0, warnings: 0, total_files: 0 },
}, "codelint", true, 120_000);
assert(!nativeNotApplicable.ok && nativeNotApplicable.notApplicable && nativeNotApplicable.files === 0 && nativeNotApplicable.projectFiles === 18, "unsupported project must produce an evidenced N/A, not a clean scan");

const dirtyNonzero = validateLintPressureEnvelope({
  tool: "doclint", status: 1, timedOut: false, durationMs: 300,
  report: { ok: false, summary: { errors: 2, failed: 2, total_files: 20 } },
}, "doclint", false, 120_000);
assert(!dirtyNonzero.ok && dirtyNonzero.failed === 2, "structured OSS rule failures with nonzero status must remain inspectable");

rejects({ tool: "doclint", status: 0, timedOut: false, durationMs: 1, report: { ok: true, errors: 0, failed: 0, files: 0 } }, "doclint", false, "zero-file lint must fail");
rejects({ tool: "doclint", status: 0, timedOut: false, durationMs: 1, report: { ok: true, errors: 0, files: 2 } }, "doclint", false, "doclint missing failed count must fail");
rejects({ tool: "codelint", status: 0, timedOut: true, durationMs: 120_001, report: { ok: true, errors: 0, files: 2 } }, "codelint", false, "timed-out lint must fail");
rejects({ tool: "codelint", status: 1, timedOut: false, durationMs: 1, projectProfile: supportedProfile, report: { ok: true, errors: 0, files: 2 } }, "codelint", false, "clean report with failing exit must fail");
rejects({ tool: "codelint", status: 0, timedOut: false, durationMs: 1, projectProfile: supportedProfile, report: { ok: false, errors: 0, files: 2 } }, "codelint", true, "explicit codelint ok=false must fail even when counts are clean");
rejects({ tool: "codelint", status: 0, timedOut: false, durationMs: 1, projectProfile: supportedProfile, report: { ok: false, errors: 1, files: 2 } }, "codelint", false, "explicit codelint ok=false with a successful native exit is contradictory");
rejects({ tool: "codelint", status: 0, timedOut: false, durationMs: 1, projectProfile: supportedProfile, report: { errors: 1, files: 2 } }, "codelint", true, "maintained legacy target findings must fail");
rejects({ tool: "codelint", status: 0, timedOut: false, durationMs: 1, projectProfile: unsupportedProfile, report: { errors: 0, files: 2 } }, "codelint", false, "unsupported project must not claim scanned files");
rejects({ tool: "codelint", status: 0, timedOut: false, durationMs: 1, projectProfile: { ...unsupportedProfile, codeFiles: 0 }, report: { errors: 0, files: 0 } }, "codelint", false, "N/A requires real project code-file evidence");
rejects({ tool: "codelint", status: 0, timedOut: false, durationMs: 1, projectProfile: unsupportedProfile, report: { errors: 1, files: 0 } }, "codelint", false, "N/A must not hide lint findings");

const child = readFileSync("test/acceptance/lint-pressure-child.mjs", "utf8");
const scenarios = readFileSync("test/acceptance/scenarios.ts", "utf8");
for (const token of ["HY_ACCEPTANCE_PACKAGE_ROOT", "HY_ACCEPTANCE_LINT_ARCHIVE_DIR", "dist", "checks.js", "config.js", "project-profile.js", "inspectProject", "withRuntimeCompatConfigs", "DOCLINT_SOURCE", "CODELINT_SOURCE", "DOCLINT_INTEGRITY_SHA512", "CODELINT_INTEGRITY_SHA512", "curl", "--retry", "--package=", "--offline", 'mode === "prepare"', "spawnSync"]) {
  assert(child.includes(token), `installed-package lint child is missing ${token}`);
}
assert(child.includes('(mode === "prepare" && result.status !== 0)') && !child.includes("timedOut || result.status !== 0 ||"), "scan child must preserve structured nonzero lint findings for validator policy instead of reporting a crash");
for (const token of ["prepareLintPressurePackages", "LINT_PREPARATION_TIMEOUT_MS", "LINT_PREPARATION_ATTEMPTS", "archiveSha512", "runRepositoryLintPressure", "assertCompatibilityUnchanged", "LINT_PRESSURE_TIMEOUT_MS", 'repo.category === "legacy"', "repo.ecosystem === \"python\"", "summary.notApplicable", "lintPressure"]) {
  assert(scenarios.includes(token), `real-repository lint pressure scenario is missing ${token}`);
}

console.log("acceptance-lint-pressure: report, timeout, installed-package, baseline, and compatibility-restoration contracts pass");
