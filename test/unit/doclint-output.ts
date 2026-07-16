import { parseCodeLintReport, parseDocLintReport } from "../../src/checks.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const result = parseDocLintReport({
  counts: {
    failed: 2,
    errors: 2,
    warnings: 1,
    files: 5,
  },
});
assert(result.name === "doclint", "should be doclint result");
assert(result.layer === "lint", "should be lint layer");
assert(!result.passed, "report with errors should fail");
assert(result.detail.includes("errors"), `detail should include errors count: ${result.detail}`);
assert(result.detail.includes("warnings"), `detail should include warnings count: ${result.detail}`);
assert(result.detail.includes("files"), `detail should include file count: ${result.detail}`);
assert(!result.detail.includes("undefined"), `detail must not contain undefined: ${result.detail}`);

for (const report of [
  { ok: true, counts: { errors: 0, failed: 0, files: 0 } },
  { ok: true, counts: { errors: 0, failed: 0 } },
  { ok: true, counts: { failed: 0, files: 2 } },
]) {
  const strict = parseDocLintReport(report);
  assert(!strict.passed && strict.hard, `doclint must fail closed for missing/zero scan counts: ${JSON.stringify(report)}`);
}
const missingOk = { counts: { errors: 0, failed: 0, files: 2 } };
assert(!parseDocLintReport(missingOk).passed, "doclint must require explicit ok=true");
assert(parseCodeLintReport(missingOk).passed, "pinned legacy codelint must accept complete native counts without an ok field");
assert(!parseCodeLintReport({ ...missingOk, ok: false }).passed, "codelint must honor an explicit ok=false envelope");
assert(parseDocLintReport({ ok: true, counts: { errors: 0, failed: 0, files: 2 } }).passed, "doclint explicit ok=true should pass clean counts");
assert(parseCodeLintReport({ ok: true, counts: { errors: 0, failed: 0, files: 2 } }).passed, "codelint explicit ok=true should pass clean counts");
// Note: doclint strict pass is verified in CI (GitHub Actions), not in this unit test.
// hy_verify no longer runs doclint as a hard gate; doclint + codelint run in CI.
