import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintCode } from "../../templates/lint/code.mjs";
import { runLint } from "../../templates/lint/index.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hy-lint-code-"));
}

function write(project: string, relative: string, content: string): void {
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function config(): Record<string, unknown> {
  return {
    project: { docsDir: "docs", codeExt: ".ts", codeDirs: ["src"] },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
    codelint: {
      lintDirs: ["src"],
      maxLinesWarning: 2,
      maxLinesError: 20,
      tiers: [
        { name: "api", paths: ["src/api"] },
        { name: "core", paths: ["src/core"] },
      ],
    },
  };
}

{
  const project = root();
  write(project, "src/api/a.ts", [
    "import { b } from \"../core/b.js\";",
    "export const a = b;",
    "export const pattern = /name:\\s*\"([^\"]+)\"/g;",
    "export const message = `value: ${a}`;",
    "",
  ].join("\n"));
  write(project, "src/core/b.ts", "import { a } from \"../api/a.js\";\nexport const b = a;\n");
  const first = lintCode({ root: project, config: config() });
  const second = lintCode({ root: project, config: config() });
  assert(first.findings.some(item => item.rule === "C002" && item.severity === "warning"), `effective-line warning missing: ${JSON.stringify(first.findings)}`);
  assert(first.findings.some(item => item.rule === "C003" && item.path === "src/core/b.ts"), `reverse tier dependency must fail: ${JSON.stringify(first.findings)}`);
  assert(first.findings.some(item => item.rule === "C004"), `dependency cycle must fail: ${JSON.stringify(first.findings)}`);
  assert(!first.findings.some(item => item.rule === "C005"), `regex and template literals must not cause parser failures: ${JSON.stringify(first.findings)}`);
  assert(JSON.stringify(first.findings) === JSON.stringify(second.findings), "code findings must be deterministic");
}

{
  const project = root();
  write(project, "docs/index.md", "# Docs\n");
  write(project, "src/app.ts", "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
  const runtimeConfig = config();
  delete (runtimeConfig.codelint as { tiers?: unknown }).tiers;
  const report = runLint({ root: project, config: runtimeConfig });
  assert(report.ok, `warnings must not fail the report: ${JSON.stringify(report)}`);
  assert(report.counts.warnings > 0 && report.counts.errors === 0, `warning/error counts are wrong: ${JSON.stringify(report.counts)}`);
  assert(report.checks.find(item => item.rule === "C003")?.status === "not_configured", "missing tiers must be explicit");
}

{
  const project = root();
  write(project, "docs/index.md", "# Docs\n");
  write(project, "src/a-b.ts", "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
  write(project, "src/a_b.ts", "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
  const runtimeConfig = config();
  delete (runtimeConfig.codelint as { tiers?: unknown }).tiers;
  const report = runLint({ root: project, config: runtimeConfig });
  const findingKeys = report.findings.map(item => [item.rule, item.path, item.line ?? 0, item.message].join("\u0000"));
  assert(JSON.stringify(findingKeys) === JSON.stringify([...findingKeys].sort()), "findings must use locale-independent code-unit ordering");
}

{
  const project = root();
  write(project, "src/a.ts", "import type { B } from \"./b.js\";\nexport const a = 1;\n");
  write(project, "src/b.ts", "import { a } from \"./a.js\";\nexport type B = typeof a;\n");
  const result = lintCode({
    root: project,
    config: {
      project: { docsDir: "docs", codeExt: ".ts", codeDirs: ["src"] },
      codelint: { lintDirs: ["src"] },
    },
  });
  assert(!result.findings.some(item => item.rule === "C004"), `type-only imports must not create runtime cycles: ${JSON.stringify(result.findings)}`);
  assert(!result.findings.some(item => item.rule === "C005"), `type-only fixture must remain parseable: ${JSON.stringify(result.findings)}`);
}

{
  const project = root();
  write(project, "docs/index.md", "# Docs\n");
  write(project, "src/main.go", "package main\n\nfunc main() {}\n");
  const report = runLint({
    root: project,
    config: {
      project: { docsDir: "docs", codeExt: ".go", codeDirs: ["src"] },
      codelint: { lintDirs: ["src"] },
      doclint: {},
    },
  });
  assert(report.ok, `unsupported language should retain file/line checks without failing: ${JSON.stringify(report)}`);
  assert(report.checks.find(item => item.rule === "C004")?.status === "not_applicable", "unsupported language C004 must be N/A");
  assert(report.checks.find(item => item.rule === "C005")?.status === "not_applicable", "unsupported language C005 must be N/A");
}

{
  const project = root();
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  const result = lintCode({ root: project, config: config() });
  assert(result.findings.some(item => item.rule === "C001" && item.severity === "error"), `zero-file scan must fail closed: ${JSON.stringify(result.findings)}`);
}
