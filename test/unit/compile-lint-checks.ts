import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommandTimeoutMs, parseCodeLintReport, parseDocLintReport, runBoundaryCheck, runCheckCommand, runCompile } from "../../src/checks.js";
import type { PlanDoc } from "../../src/state.js";

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
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt, codeDirs, docsDir: "docs" },
    codelint: { lintDirs: codeDirs },
  }, null, 2) + "\n");
}

function installFakeTsc(root: string): void {
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const tsc = join(bin, "tsc");
  writeFileSync(tsc, "#!/usr/bin/env sh\nexit 0\n", "utf-8");
  chmodSync(tsc, 0o755);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

{
  const root = tempRoot("hy-check-supervisor-");
  const ready = join(root, "ready.txt");
  const marker = join(root, "escaped-child.txt");
  write(root, "tree.mjs", `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [ready, marker] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ["-e", "const fs=require('node:fs');const marker=process.argv[1];setTimeout(()=>fs.writeFileSync(marker,'escaped'),3000);setTimeout(()=>process.exit(0),5000)", marker], { stdio: "ignore" });
writeFileSync(ready, String(grandchild.pid));
setTimeout(() => process.exit(0), 6000);
`);
  const timed = runCheckCommand({ file: process.execPath, args: [join(root, "tree.mjs"), ready, marker] }, root, 1_500);
  assert(!timed.ok && timed.timedOut && timed.status === null, `timed command must return a timeout envelope, got ${JSON.stringify(timed)}`);
  assert(timed.durationMs < 10_000, `timed command cleanup exceeded its bounded allowance: ${JSON.stringify(timed)}`);
  assert(existsSync(ready), "process-tree fixture did not start its grandchild before timeout");
  wait(3_300);
  assert(!existsSync(marker), "check timeout killed only the parent and allowed a grandchild to escape");

  const passed = runCheckCommand({ file: process.execPath, args: ["-e", "process.stdout.write('ok')"] }, root, 5_000);
  assert(passed.ok && passed.status === 0 && passed.stdout === "ok", `supervisor changed successful exit semantics: ${JSON.stringify(passed)}`);
  const failed = runCheckCommand({ file: process.execPath, args: ["-e", "process.exit(7)"] }, root, 5_000);
  assert(!failed.ok && !failed.timedOut && failed.status === 7, `supervisor changed nonzero exit semantics: ${JSON.stringify(failed)}`);
  assert(checkCommandTimeoutMs("npm run test:acceptance") >= 2_820_000, "formal acceptance timeout must exceed its 45-minute internal budget");
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
  mkdirSync(join(root, "src"), { recursive: true });
  writeConfig(root, ".py", ["lib"]);
  write(root, "lib/app.py", "value = 1\n");
  write(root, "src/broken.py", "this is not valid python !!!\n");
  write(root, "codelint.json", JSON.stringify({ codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"] }) + "\n");
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

{
  const result = parseCodeLintReport({ errors: 0, warnings: 0, total_files: 3 });
  assert(result.passed && result.detail.includes("3 files"), `codelint should accept its native total_files field, got ${JSON.stringify(result)}`);
}

for (const report of [
  { ok: true, errors: 0, total_files: 0 },
  { ok: true, errors: 0 },
  { ok: true, total_files: 2 },
]) {
  const strict = parseCodeLintReport(report);
  assert(!strict.passed && strict.hard, `codelint must fail closed for missing/zero scan counts: ${JSON.stringify(report)}`);
}

{
  const root = tempRoot("hy-compile-missing-root-");
  mkdirSync(join(root, "src"), { recursive: true });
  write(root, "src/app.py", "value = 1\n");
  write(root, "codelint.json", JSON.stringify({ codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"] }) + "\n");
  const result = runCompile(root)[0];
  assert(!result.passed && result.hard, `legacy codelint must not make compile run without root config, got ${JSON.stringify(result)}`);
  assert(result.detail.includes("Runtime project config is required") && !result.detail.includes("Python file"), `missing root config should fail closed before compile, got ${JSON.stringify(result)}`);
}

{
  const root = tempRoot("hy-compile-incomplete-root-");
  mkdirSync(join(root, "src"), { recursive: true });
  write(root, "src/app.py", "value = 1\n");
  write(root, "hy-workflow.json", JSON.stringify({ project: { baseBranch: "main", docsDir: "docs" } }) + "\n");
  write(root, "codelint.json", JSON.stringify({ codeExt: ".py", codeDirs: ["src"], lintDirs: ["src"] }) + "\n");
  const result = runCompile(root)[0];
  assert(!result.passed && result.hard, `compat fields must not fill an incomplete root config, got ${JSON.stringify(result)}`);
  assert(result.detail.includes("project.codeExt is required at runtime") && result.detail.includes("codelint.lintDirs is required at runtime"), `incomplete root config should identify required fields, got ${JSON.stringify(result)}`);
}

{
  const root = tempRoot("hy-package-metadata-boundary-");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeConfig(root, ".ts", ["src"]);
  write(root, "src/app.ts", "export const value = 1;\n");
  write(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --version" }, devDependencies: { tsx: "1.0.0" } }, null, 2) + "\n");
  write(root, "package-lock.json", JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", devDependencies: { tsx: "1.0.0" } } } }, null, 2) + "\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, ["checkout", "-b", "fix/package-metadata"]);

  const plan: PlanDoc = {
    task: "allow package metadata changes without weakening the external dependency boundary",
    scope: { changes: ["package.json", "package-lock.json"], new_files: [], delete: [] },
    boundary: { dependency_dag: "package metadata does not change runtime dependencies", entry_points: [], no_new_external: true },
    verify: { platform: { python_version: "N/A", setup: [] }, smoke: [], tests: [] },
    risks: ["Scenario: metadata is mistaken for a dependency; impact: valid releases are blocked; mitigation: compare dependency declarations only."],
    discussion: "Compare dependency fields. Treating every package manifest byte as a dependency was rejected because version and scripts are metadata.",
    branch: "fix/package-metadata",
    verify_hash: null,
    pr_number: null,
  };

  write(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.1", scripts: { test: "node --version", verify: "node --version" }, devDependencies: { tsx: "1.0.0" } }, null, 2) + "\n");
  write(root, "package-lock.json", JSON.stringify({ name: "fixture", version: "1.0.1", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.1", devDependencies: { tsx: "1.0.0" } } } }, null, 2) + "\n");
  const metadataOnly = runBoundaryCheck(root, plan).find(check => check.name === "no_new_external");
  assert(metadataOnly?.passed, `package version and script changes must not look like new external dependencies, got ${JSON.stringify(metadataOnly)}`);

  write(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.1", devDependencies: { tsx: "2.0.0" } }, null, 2) + "\n");
  const dependencyChanged = runBoundaryCheck(root, plan).find(check => check.name === "no_new_external");
  assert(dependencyChanged && !dependencyChanged.passed && dependencyChanged.detail.includes("package.json"), `dependency declaration changes must still fail closed, got ${JSON.stringify(dependencyChanged)}`);
}
