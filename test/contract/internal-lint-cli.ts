import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RULES = ["D001", "D002", "D003", "D004", "D005", "C001", "C002", "C003", "C004", "C005"];
const server = join(process.cwd(), "dist", "main.js");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(extension = ".py", source = "value = 1\n"): string {
  const root = mkdtempSync(join(tmpdir(), "hy-internal-lint-contract-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, `src/main${extension}`), source);
  writeFileSync(join(root, "docs/index.md"), "# Contract fixture\n\n[Guide](guide.md)\n");
  writeFileSync(join(root, "docs/guide.md"), "# Guide\n\nSubstantive project facts.\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: [extension], codeDirs: ["src"], docsDir: "docs" },
    codelint: {
      lintDirs: ["src"],
      maxLinesWarning: 300,
      maxLinesError: 500,
      tiers: [{ name: "legacy", paths: ["src"] }],
    },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
  }, null, 2) + "\n");
  for (const [file, content] of [
    ["codelint.json", "{\"sentinel\":\"code\"}\n"],
    ["doclint.json", "{\"sentinel\":\"docs\"}\n"],
    ["docs-gardener.json", "{\"sentinel\":\"garden\"}\n"],
  ]) writeFileSync(join(root, file), content);
  return root;
}

function run(root: string): { status: number | null; report: any } {
  const result = spawnSync(process.execPath, [server, "lint", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      npm_config_offline: "true",
      GIT_TERMINAL_PROMPT: "0",
      HY_WORKFLOW_RUNTIME_CONFIG_SOURCE: "hy-workflow.runtime-config-source.v1",
    },
  });
  assert(!result.error && !result.signal, `lint process failed: ${result.error?.message ?? result.signal}`);
  let report: any;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`lint returned invalid JSON: ${result.stdout}\n${result.stderr}`); }
  return { status: result.status, report };
}

function assertCompatibility(root: string): void {
  assert(readFileSync(join(root, "codelint.json"), "utf8") === "{\"sentinel\":\"code\"}\n", "lint changed codelint.json");
  assert(readFileSync(join(root, "doclint.json"), "utf8") === "{\"sentinel\":\"docs\"}\n", "lint changed doclint.json");
  assert(readFileSync(join(root, "docs-gardener.json"), "utf8") === "{\"sentinel\":\"garden\"}\n", "lint changed docs-gardener.json");
}

const cleanRoot = fixture();
const clean = run(cleanRoot);
assert(clean.status === 0 && clean.report.schema === "hy-workflow.lint.v1" && clean.report.version === 1 && clean.report.ok === true, "clean built-in lint must exit zero with schema v1");
assert(clean.report.counts?.checks === 10 && clean.report.checks?.map((check: any) => check.rule).join(",") === RULES.join(","), "built-in lint must return exactly ten ordered rules");
assert(clean.report.counts?.advisories === 0, "lint report must expose an advisory count without changing clean compatibility");
assert(clean.report.checks.find((check: any) => check.rule === "C003")?.status === "not_configured", "C003 compatibility slot must remain not_configured");
assert(clean.report.checks.find((check: any) => check.rule === "C004")?.status === "not_applicable", "C004 compatibility slot must remain not_applicable");
assert(!clean.report.findings.some((finding: any) => finding.rule === "C003" || finding.rule === "C004"), "dependency compatibility slots must not emit findings");
assertCompatibility(cleanRoot);

const unsupportedRoot = fixture(".go", "package main\n");
const unsupported = run(unsupportedRoot);
assert(unsupported.status === 0, "unsupported scanner language must not be a false failure");
assert(unsupported.report.checks.find((check: any) => check.rule === "C005")?.status === "not_applicable", "unsupported scanner language must be explicit not_applicable");
assertCompatibility(unsupportedRoot);

const invalidRoot = fixture(".py", "def broken(:\n");
const invalid = run(invalidRoot);
assert(invalid.status === 1 && invalid.report.ok === false && invalid.report.counts.errors > 0, "supported parser failure must exit one with structured errors");
assert(invalid.report.findings.some((finding: any) => finding.rule === "C005" && finding.severity === "error"), "supported parser failure must be attributed to C005");
assertCompatibility(invalidRoot);

for (const file of ["src/lint.ts", ...["code", "docs", "fs", "index", "markdown", "python", "rust"].map(name => `templates/lint/${name}.mjs`)]) {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  for (const forbidden of ["codeload.github.com", "npx --yes --package", "DOCLINT_SOURCE", "CODELINT_SOURCE", "withRuntimeCompatConfigs"]) {
    assert(!source.includes(forbidden), `${file} must not contain external or compatibility lint runtime token ${forbidden}`);
  }
}

console.log("internal-lint-cli: offline installed CLI, report, N/A, parser failure, and compatibility boundaries pass");
