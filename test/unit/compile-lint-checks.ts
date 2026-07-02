import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodeLintReport, parseDocLintReport, runCompile } from "../../src/checks.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, file: string, content: string): void {
  const full = join(root, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function writeConfig(root: string, codeExt: string | string[], codeDirs: string[]): void {
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt, codeDirs, docsDir: "docs" } }, null, 2) + "\n");
}

function installFakeTsc(root: string): void {
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const tsc = join(bin, "tsc");
  writeFileSync(tsc, "#!/usr/bin/env sh\nexit 0\n", "utf-8");
  chmodSync(tsc, 0o755);
}

{
  const root = tempRoot("hy-js-only-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeConfig(root, ".js", ["src"]);
  write(root, "src/app.js", "module.exports = 1;\n");
  const results = runCompile(root);
  assert(results.length === 1, `JS-only compile should produce one result, got ${JSON.stringify(results)}`);
  assert(results[0].name === "compile: javascript", `JS-only should not run TypeScript compile, got ${JSON.stringify(results)}`);
  assert(results[0].passed && results[0].hard === false, `JS-only compile should soft-pass without tsconfig, got ${JSON.stringify(results[0])}`);
}

{
  const root = tempRoot("hy-python-lib-");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeConfig(root, ".py", ["lib"]);
  write(root, "lib/app.py", "value = 1\n");
  const result = runCompile(root).find(check => check.name === "compile: python");
  assert(result?.passed && result.hard, `Python compile should respect non-src codeDirs, got ${JSON.stringify(result)}`);
  assert(result.detail.includes("1 Python file"), `Python compile should enumerate lib/app.py, got ${JSON.stringify(result)}`);
}

{
  const root = tempRoot("hy-python-src-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeConfig(root, ".py", ["src"]);
  write(root, "src/app.py", "value = 1\n");
  const result = runCompile(root).find(check => check.name === "compile: python");
  assert(result?.passed && result.hard, `Python compile should include top-level src/app.py, got ${JSON.stringify(result)}`);
}

{
  const root = tempRoot("hy-mixed-");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeConfig(root, [".ts", ".py"], ["src", "lib"]);
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { noEmit: true }, include: ["src/**/*.ts"] }, null, 2) + "\n");
  write(root, "src/app.ts", "export const value = 1;\n");
  write(root, "lib/app.py", "value = 1\n");
  installFakeTsc(root);
  const results = runCompile(root);
  const names = results.map(check => check.name).sort();
  assert(names.includes("compile: typescript"), `mixed project should run TypeScript compile, got ${JSON.stringify(results)}`);
  assert(names.includes("compile: python"), `mixed project should run Python compile, got ${JSON.stringify(results)}`);
  assert(results.every(check => check.passed), `mixed compile checks should pass with fake tsc and valid Python, got ${JSON.stringify(results)}`);
}

{
  const result = parseDocLintReport({ counts: { failed: "2", errors: "2", warnings: "1", files: "5" } });
  assert(!result.passed && result.detail.includes("2 errors") && result.detail.includes("1 warnings") && result.detail.includes("5 files"), `doclint should parse numeric strings, got ${JSON.stringify(result)}`);
}

{
  const result = parseCodeLintReport({ ok: false, data: { counts: { errors: "4", warnings: "3", files: "8", failed: "4" } } });
  assert(!result.passed, `codelint nested ok=false report should fail, got ${JSON.stringify(result)}`);
  assert(result.detail.includes("4 errors") && result.detail.includes("3 warnings") && result.detail.includes("8 files"), `codelint nested detail should include numeric string counts, got ${JSON.stringify(result)}`);
  assert(!result.detail.includes("undefined"), `codelint detail must not contain undefined, got ${result.detail}`);
}
