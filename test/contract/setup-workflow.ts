import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { checkSetupContracts } from "../../src/contralint/rules/setup.js";

const findings = checkSetupContracts({ root: process.cwd() });
const hardFails = findings.filter(f => f.severity === "hard_fail");
if (hardFails.length) {
  throw new Error("Setup/workflow contract violations:\n" +
    hardFails.map(f => `  ${f.message} (${f.file})`).join("\n"));
}
console.log(`setup-workflow: ${findings.length} findings (0 hard)`);

// setup always deploys the packaged template verbatim.
const template = fs.readFileSync("templates/hy-workflow.yml", "utf-8");
const yaml = fs.readFileSync(".github/workflows/hy-workflow.yml", "utf-8");
if (template !== yaml) throw new Error("checked-in workflow must match templates/hy-workflow.yml exactly");
if (fs.existsSync("setup") || fs.existsSync("setup.ps1")) throw new Error("legacy platform installers must not exist");
if (yaml.includes("paths:")) throw new Error("required workflow must run for every push and pull request");
for (const trigger of ["  push:\n", "  pull_request:\n"]) {
  if (!yaml.includes(trigger)) throw new Error(`required workflow trigger is missing: ${trigger.trim()}`);
}
for (const token of [
  "hashFiles('package.json')",
  "hashFiles('package-lock.json')",
  "npm ci",
  "npm run build",
  "npm test",
  "git+https://github.com/voxServalG/doclint.git",
  "git+https://github.com/voxServalG/codelint.git",
  "status=$?",
  "JSON.parse",
  "report.ok === false",
  "nestedNumber('errors')",
  "nestedNumber('failed')",
  "compat_backup_dir=",
  "cp -a --",
  "trap restore_compat EXIT",
  "rm -rf -- \"$compat_backup_dir\"",
]) {
  if (!yaml.includes(token)) throw new Error(`strict workflow contract token is missing: ${token}`);
}
for (const forbidden of ["github:voxServalG/", "|| true", "actions/upload-artifact"]) {
  if (yaml.includes(forbidden)) throw new Error(`workflow must not contain ${forbidden}`);
}

const lintStepMarker = "      - name: Run doclint and codelint\n";
const lintStepStart = yaml.indexOf(lintStepMarker);
if (lintStepStart < 0) throw new Error("strict lint workflow step is missing");
const lintStep = yaml.slice(lintStepStart + lintStepMarker.length);
const runMarker = "        run: |\n";
const runStart = lintStep.indexOf(runMarker);
if (runStart < 0) throw new Error("strict lint workflow run block is missing");
const lintScript = lintStep
  .slice(runStart + runMarker.length)
  .split("\n")
  .map(line => {
    if (!line) return "";
    if (!line.startsWith("          ")) throw new Error(`unexpected workflow script indentation: ${line}`);
    return line.slice(10);
  })
  .join("\n");

const syntax = spawnSync("bash", ["-n"], { input: lintScript, encoding: "utf-8" });
if (syntax.status !== 0) throw new Error(`strict lint script is invalid Bash: ${syntax.stderr}`);

function exerciseLintScript(mode: string, expectSuccess: boolean): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hy-workflow-contract-${mode}-`));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), `hy-workflow-runner-${mode}-`));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
  }));
  const originalCompat = "{\"existing\":true}\n";
  fs.writeFileSync(path.join(root, "codelint.json"), originalCompat);
  const fakeNpx = path.join(bin, "npx");
  fs.writeFileSync(fakeNpx, `#!/usr/bin/env bash
case "\${FAKE_LINT_MODE:-ok}" in
  command-fail) exit 7 ;;
  invalid-json) printf 'not-json' ;;
  ok-false) printf '{"ok":false,"errors":0,"failed":0}' ;;
  errors) printf '{"ok":true,"errors":2,"failed":0}' ;;
  failed) printf '{"ok":true,"errors":0,"failed":3}' ;;
  *) printf '{"ok":true,"errors":0,"failed":0}' ;;
esac
`);
  fs.chmodSync(fakeNpx, 0o755);

  const result = spawnSync("bash", ["-c", lintScript], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runnerTemp,
      FAKE_LINT_MODE: mode,
    },
    encoding: "utf-8",
  });
  if ((result.status === 0) !== expectSuccess) {
    throw new Error(`lint script mode ${mode} returned ${result.status}: ${result.stderr || result.stdout}`);
  }
  if (fs.readFileSync(path.join(root, "codelint.json"), "utf-8") !== originalCompat) {
    throw new Error(`lint script mode ${mode} did not restore the existing compatibility file`);
  }
  for (const absent of ["doclint.json", "docs-gardener.json"]) {
    if (fs.existsSync(path.join(root, absent))) throw new Error(`lint script mode ${mode} left temporary ${absent}`);
  }
  if (fs.existsSync(path.join(runnerTemp, "hy-workflow-compat-backup"))) {
    throw new Error(`lint script mode ${mode} left its compatibility backup`);
  }
}

exerciseLintScript("ok", true);
for (const mode of ["command-fail", "invalid-json", "ok-false", "errors", "failed"]) {
  exerciseLintScript(mode, false);
}

console.log("setup-workflow: always-shared strict CI template is canonical");
