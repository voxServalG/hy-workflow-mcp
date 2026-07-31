import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runLintCli } from "../../src/lint.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-lint-cli-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Project documentation\n\nThis page is the documentation entry point.\n", "utf-8");
  fs.writeFileSync(path.join(root, "src", "app.py"), "value = 1\n", "utf-8");
  fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
    docsGardener: { catalogs: {} },
  }, null, 2) + "\n", "utf-8");
  return root;
}

const root = fixtureRoot();
const legacyText = "{\n  \"owner\": \"team\"\n}\n";
fs.writeFileSync(path.join(root, "codelint.json"), legacyText, "utf-8");
const result = await runLintCli(["--json"], root);
const report = JSON.parse(result.stdout);
assert(report.schema === "hy-workflow.lint.v1" && report.version === 1, "lint CLI must emit the unified versioned envelope");
assert(report.root === "." && report.counts.checks === 10 && report.checks.length === 10, "lint CLI must emit all D001-D005 and C001-C005 checks");
assert(report.checks.some((check: any) => check.rule === "C003" && check.status === "not_configured"), "missing tiers must be explicit rather than inferred");
assert(report.checks.some((check: any) => check.rule === "C004" && check.status === "not_applicable"), "C004 must remain a fixed compatibility slot");
assert(!report.findings.some((finding: any) => finding.rule === "C003" || finding.rule === "C004"), "compatibility-only dependency slots must not emit findings");
assert(result.stdout === JSON.stringify(report) + "\n", "lint --json must emit exactly one compact JSON document on stdout");
assert(fs.readFileSync(path.join(root, "codelint.json"), "utf-8") === legacyText, "lint must preserve an existing legacy compatibility file byte-for-byte");
assert(!fs.existsSync(path.join(root, "doclint.json")) && !fs.existsSync(path.join(root, "docs-gardener.json")), "lint must not materialize missing compatibility files");

const missing = await runLintCli(["--json"], fs.mkdtempSync(path.join(os.tmpdir(), "hy-lint-cli-missing-")));
const missingReport = JSON.parse(missing.stdout);
assert(missing.exitCode === 1 && missingReport.ok === false, "missing root config must fail closed");
assert(missingReport.findings.length === 1 && missingReport.findings[0].rule === "C005", "config loading failures must be classified as C005");

const invalidArgs = await runLintCli(["--json", "--unknown"], root);
const invalidArgsReport = JSON.parse(invalidArgs.stdout);
assert(invalidArgs.exitCode === 1 && invalidArgsReport.findings[0]?.rule === "C005", "unknown lint CLI options must fail closed through C005");

const help = await runLintCli(["--help"], root);
assert(help.exitCode === 0 && help.stdout.includes("hy-workflow lint --json"), "lint help must expose the supported JSON command");

console.log("lint-cli: unified output, C005 failure, and zero compatibility writes pass");
