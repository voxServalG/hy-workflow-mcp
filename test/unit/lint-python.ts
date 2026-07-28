import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintCode } from "../../templates/lint/code.mjs";
import { scanPython } from "../../templates/lint/python.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hy-lint-python-"));
}

function write(project: string, relative: string, content: string): void {
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

const scanned = scanPython([
  { path: "src/app.py", source: "import os\nfrom .core import value\n\nresult = value\n" },
]);
assert(scanned.errors.length === 0, `valid Python scan failed: ${JSON.stringify(scanned)}`);
assert(scanned.results[0]?.effectiveLines === 3, `tokenize effective line count changed: ${JSON.stringify(scanned.results)}`);
assert(scanned.results[0]?.imports.length === 2, `AST imports were not returned: ${JSON.stringify(scanned.results)}`);

const invalid = scanPython([{ path: "src/broken.py", source: "def broken(:\n" }]);
assert(invalid.errors.some(item => item.message.includes("syntax error")), `syntax failure must be structured: ${JSON.stringify(invalid)}`);

{
  const project = root();
  write(project, "src/a.py", "import b\nvalue = b.value\n");
  write(project, "src/b.py", "import a\nvalue = a.value\n");
  const result = lintCode({
    root: project,
    config: {
      project: { codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
      codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
    },
  });
  assert(result.findings.some(item => item.rule === "C004"), `Python dependency cycle must be detected: ${JSON.stringify(result.findings)}`);
  assert(!result.findings.some(item => item.rule === "C005"), `valid Python must not fail reliability: ${JSON.stringify(result.findings)}`);
}

{
  const project = root();
  write(project, "src/app.py", "value = 1\n");
  const result = lintCode({
    root: project,
    pythonCommand: "hy-python-command-does-not-exist",
    config: {
      project: { codeExt: ".py", codeDirs: ["src"], docsDir: "docs" },
      codelint: { lintDirs: ["src"] },
    },
  });
  assert(result.findings.some(item => item.rule === "C005" && item.severity === "error"), `missing interpreter must fail C005: ${JSON.stringify(result.findings)}`);
}
