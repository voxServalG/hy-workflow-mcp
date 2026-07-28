import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { checkSetupContracts } from "../../src/contralint/rules/setup.js";
import { renderWorkflowTemplate } from "../../src/setup/shared.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const findings = checkSetupContracts({ root: process.cwd() });
const hardFails = findings.filter(finding => finding.severity === "hard_fail");
if (hardFails.length) {
  throw new Error("Setup/workflow contract violations:\n" + hardFails.map(finding => `  ${finding.message} (${finding.file})`).join("\n"));
}

const template = fs.readFileSync("templates/hy-workflow.yml", "utf8");
const workflow = fs.readFileSync(".github/workflows/hy-workflow.yml", "utf8");
const rendered = renderWorkflowTemplate();
assert(template !== workflow, "raw template must retain its lint bundle placeholder");
assert(workflow === rendered, "checked-in workflow must equal the deterministic rendered template");
assert((template.match(/__HY_WORKFLOW_LINT_BUNDLE_BASE64__/g) ?? []).length === 1, "raw workflow template must contain one lint bundle placeholder");
assert(!workflow.includes("__HY_WORKFLOW_LINT_BUNDLE_BASE64__"), "checked-in workflow must not retain the lint bundle placeholder");
assert(!template.includes("  push:\n"), "generic workflow must not run for push events");
for (const trigger of ["  pull_request:\n", "  workflow_dispatch:\n"]) assert(template.includes(trigger), `workflow trigger is missing: ${trigger.trim()}`);
assert(!template.includes("paths:"), "required workflow must not use path filters");
assert(template.includes("permissions:\n  contents: read\n"), "workflow must grant read-only repository contents permission");
assert((template.match(/persist-credentials: false/g) ?? []).length === 2, "both workflow checkouts must disable persisted credentials");
for (const forbidden of [
  "codeload.github.com",
  "npx --yes --package",
  "curl ",
  "compat_backup",
  "codelint.json",
  "doclint.json",
  "docs-gardener.json",
  "actions/upload-artifact",
  "contents: write",
  "actions: write",
  "checks: write",
  "pull-requests: write",
  "id-token: write",
]) {
  assert(!template.includes(forbidden), `workflow must not contain ${forbidden}`);
}
for (const token of [
  "Run native project CI",
  "Run built-in doclint and codelint",
  "HY_WORKFLOW_INTERNAL_LINT_BUNDLE",
  "requiredModules",
  "RUNNER_TEMP",
  "hy-workflow.lint.v1",
  "report.counts.docs <= 0",
  "report.ok !== true",
  "report.counts.errors > 0",
  "fs.rmSync(runnerRoot",
  "name: Windows Smoke",
  "runs-on: windows-latest",
  "npm run test:windows",
]) {
  assert(template.includes(token), `strict workflow contract token is missing: ${token}`);
}
assert((workflow.match(/\n    name: Verify\n/g) ?? []).length === 1, "workflow must expose exactly one stable Verify job identity");
assert((workflow.match(/\n    name: Windows Smoke\n/g) ?? []).length === 1, "workflow must expose exactly one independent Windows Smoke job");

const lintMarker = "      - name: Run built-in doclint and codelint\n";
const lintStart = workflow.indexOf(lintMarker);
assert(lintStart >= 0, "built-in lint workflow step is missing");
const runMarker = "        run: |\n";
const runStart = workflow.indexOf(runMarker, lintStart);
assert(runStart > lintStart, "built-in lint run block is missing");
const nextJob = workflow.indexOf("\n  windows-smoke:", runStart);
assert(nextJob > runStart, "built-in lint step boundary is missing");
const lintScript = workflow
  .slice(runStart + runMarker.length, nextJob)
  .split("\n")
  .map(line => {
    if (!line) return "";
    assert(line.startsWith("          "), `unexpected workflow script indentation: ${line}`);
    return line.slice(10);
  })
  .join("\n");
const syntax = spawnSync("bash", ["-n"], { input: lintScript, encoding: "utf8" });
assert(syntax.status === 0, `built-in lint script is invalid Bash: ${syntax.stderr}`);

type FixtureOptions = {
  codeExt?: string;
  code?: string;
  docs?: boolean;
  config?: Record<string, unknown>;
  expectSuccess: boolean;
  expectedOutput?: string;
};

function exercise(name: string, options: FixtureOptions): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hy-workflow-lint-${name}-`));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), `hy-workflow-runner-${name}-`));
  const codeExt = options.codeExt ?? ".py";
  const config = options.config ?? {
    project: { baseBranch: "main", codeExt: [codeExt], codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
    ci: { commands: ["true"] },
  };
  fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify(config, null, 2) + "\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, `src/main${codeExt}`), options.code ?? (codeExt === ".rs" ? "pub fn value() -> u8 { 1 }\n" : codeExt === ".go" ? "package main\n" : "value = 1\n"));
  if (options.docs !== false) {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/index.md"), "# Documentation\n\n[Guide](guide.md)\n");
    fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nUseful project facts.\n");
  }

  const compatibility = new Map([
    ["codelint.json", "{\"legacy\":\"code\"}\n"],
    ["doclint.json", "{\"legacy\":\"docs\"}\n"],
    ["docs-gardener.json", "{\"legacy\":\"garden\"}\n"],
  ]);
  for (const [file, bytes] of compatibility) fs.writeFileSync(path.join(root, file), bytes);

  const result = spawnSync("bash", ["-c", lintScript], {
    cwd: root,
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert((result.status === 0) === options.expectSuccess, `${name} returned ${result.status}: ${result.stderr || result.stdout}`);
  if (options.expectedOutput) assert(result.stdout.includes(options.expectedOutput), `${name} output is missing ${options.expectedOutput}`);
  for (const [file, bytes] of compatibility) assert(fs.readFileSync(path.join(root, file), "utf8") === bytes, `${name} changed legacy ${file}`);
  assert(fs.readdirSync(runnerTemp).length === 0, `${name} left the decoded lint bundle in runner temp`);
}

exercise("clean-python", { expectSuccess: true, expectedOutput: '"schema":"hy-workflow.lint.v1"' });
exercise("warning", { code: ["value = 0", ...Array.from({ length: 300 }, () => "value += 1")].join("\n") + "\n", expectSuccess: true, expectedOutput: '"status":"warning"' });
exercise("unsupported-language", { codeExt: ".go", expectSuccess: true, expectedOutput: '"status":"not_applicable"' });
exercise("python-parse-failure", { code: "def broken(:\n", expectSuccess: false });
exercise("zero-docs", { docs: false, expectSuccess: false });
exercise("invalid-thresholds", {
  config: {
    project: { baseBranch: "main", codeExt: [".py"], codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
    doclint: { maxLinesWarning: 501, maxLinesError: 500 },
    ci: { commands: ["true"] },
  },
  expectSuccess: false,
});

console.log(`setup-workflow: ${findings.length} findings, rendered offline lint contract passes`);
