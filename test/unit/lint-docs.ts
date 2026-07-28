import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintDocs } from "../../templates/lint/docs.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hy-lint-docs-"));
}

function write(project: string, relative: string, content: string): void {
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function config(warning = 200, error = 500): Record<string, unknown> {
  return {
    project: { docsDir: "docs", codeExt: ".ts", codeDirs: ["src"] },
    doclint: { maxLinesWarning: warning, maxLinesError: error },
    codelint: { lintDirs: ["src"] },
  };
}

{
  const project = root();
  write(project, "docs/index.md", "# Documentation\n\n[Guide](./guide.md#details)\n");
  write(project, "docs/guide.md", "# Guide\n\n## Details\n\nSee [the repeated section](#details-1).\n\n## Details\n");
  const result = lintDocs({ root: project, config: config() });
  assert(result.files.length === 2, `expected two docs, got ${JSON.stringify(result.files)}`);
  assert(result.findings.length === 0, `valid documentation should pass, got ${JSON.stringify(result.findings)}`);
}

{
  const project = root();
  write(project, "docs/index.md", "# Documentation\n\n[Missing](./missing.md)\n");
  write(project, "docs/orphan.md", "### Orphan\n");
  const result = lintDocs({ root: project, config: config() });
  assert(result.findings.some(item => item.rule === "D002" && item.path === "docs/orphan.md"), `unreachable doc must fail D002: ${JSON.stringify(result.findings)}`);
  assert(result.findings.some(item => item.rule === "D003" && item.path === "docs/index.md"), `missing local link must fail D003: ${JSON.stringify(result.findings)}`);
  assert(result.findings.some(item => item.rule === "D004" && item.path === "docs/orphan.md"), `invalid first heading must fail D004: ${JSON.stringify(result.findings)}`);
}

{
  const project = root();
  write(project, "docs/index.md", "# Documentation\n\none\n\ntwo\n\nthree\n");
  const warning = lintDocs({ root: project, config: config(2, 10) });
  assert(warning.findings.some(item => item.rule === "D005" && item.severity === "warning"), `D005 warning threshold was not enforced: ${JSON.stringify(warning.findings)}`);
  const error = lintDocs({ root: project, config: config(2, 3) });
  assert(error.findings.some(item => item.rule === "D005" && item.severity === "error"), `D005 error threshold was not enforced: ${JSON.stringify(error.findings)}`);
}

{
  const project = root();
  const result = lintDocs({ root: project, config: config() });
  assert(result.findings.some(item => item.rule === "D001" && item.severity === "error"), `missing docs system must fail D001: ${JSON.stringify(result.findings)}`);
}
