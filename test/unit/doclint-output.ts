import { parseDocLintReport } from "../../src/checks.js";

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
// Note: doclint strict pass is verified in CI (GitHub Actions), not in this unit test.
// hy_verify no longer runs doclint as a hard gate; doclint + codelint run in CI.
