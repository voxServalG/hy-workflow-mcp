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
if (!yaml.includes("permissions:\n  contents: read\n")) throw new Error("required workflow must grant only read access to repository contents");
for (const writePermission of ["contents: write", "actions: write", "checks: write", "pull-requests: write", "id-token: write"]) {
  if (yaml.includes(writePermission)) throw new Error(`required workflow must not grant ${writePermission}`);
}
for (const token of [
  "npm ci",
  "npm fallback requires package-lock.json or npm-shrinkwrap.json",
  "pnpm install --frozen-lockfile",
  "yarn install --immutable",
  "bun install --frozen-lockfile",
  "python -m pytest",
  "go test ./...",
  "cargo test --workspace --all-targets",
  "ci.commands",
  "npm run build",
  "npm test",
  "const standardChecks = ['build', 'typecheck', 'check', 'lint', 'test']",
  "https://codeload.github.com/voxServalG/doclint/tar.gz/20793b8a4e1bcd79556d2cede0973cabe97f1ae4",
  "https://codeload.github.com/voxServalG/codelint/tar.gz/aaaa065160b019f8e2a9d8eff456633dfa4b6d9b",
  'npx --yes --package="$source" "$binary" "$command" --json',
  "timeout --signal=TERM 75s",
  "retrying once",
  "status=$?",
  "JSON.parse",
  "const invalidOk = label === 'doclint'",
  "report.ok !== undefined && report.ok !== true",
  "nestedNumber('errors')",
  "nestedNumber('failed')",
  "nestedNumber('total_files')",
  "files <= 0",
  "configuredFiles.length <= 0",
  "const notApplicable = label === 'codelint'",
  "compat_backup_dir=",
  "cp -a --",
  "trap restore_compat EXIT",
  "rm -rf -- \"$compat_backup_dir\"",
  "name: Windows Smoke",
  "if: ${{ github.repository == 'voxServalG/hy-workflow-mcp' }}",
  "runs-on: windows-latest",
  "npm run test:windows",
]) {
  if (!yaml.includes(token)) throw new Error(`strict workflow contract token is missing: ${token}`);
}
if ((yaml.match(/\n    name: Verify\n/g) ?? []).length !== 1) throw new Error("workflow must expose exactly one stable Verify job identity");
if ((yaml.match(/\n    name: Windows Smoke\n/g) ?? []).length !== 1) throw new Error("workflow must expose exactly one independent Windows Smoke job");
if (yaml.includes("- uses: actions/setup-node@v4\n        if:")) throw new Error("setup-node must be unconditional because mandatory doclint/codelint run in every ecosystem");
for (const forbidden of ["github:voxServalG/", "|| true", "actions/upload-artifact", "'npm install'"]) {
  if (yaml.includes(forbidden)) throw new Error(`workflow must not contain ${forbidden}`);
}

const lintStepMarker = "      - name: Run doclint and codelint\n";
const lintStepStart = yaml.indexOf(lintStepMarker);
if (lintStepStart < 0) throw new Error("strict lint workflow step is missing");
const lintStep = yaml.slice(lintStepStart + lintStepMarker.length);
const runMarker = "        run: |\n";
const runStart = lintStep.indexOf(runMarker);
if (runStart < 0) throw new Error("strict lint workflow run block is missing");
const lintScriptBlock = lintStep.slice(runStart + runMarker.length);
const nextJob = lintScriptBlock.indexOf("\n  windows-smoke:");
const lintScript = (nextJob >= 0 ? lintScriptBlock.slice(0, nextJob) : lintScriptBlock)
  .split("\n")
  .map(line => {
    if (!line) return "";
    if (!line.startsWith("          ")) throw new Error(`unexpected workflow script indentation: ${line}`);
    return line.slice(10);
  })
  .join("\n");

const syntax = spawnSync("bash", ["-n"], { input: lintScript, encoding: "utf-8" });
if (syntax.status !== 0) throw new Error(`strict lint script is invalid Bash: ${syntax.stderr}`);

function exerciseLintScript(mode: string, expectSuccess: boolean, codeExt = ".py"): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hy-workflow-contract-${mode}-`));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), `hy-workflow-runner-${mode}-`));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt, codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
  }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index" + codeExt), codeExt === ".rs" ? "pub fn value() -> u8 { 1 }\n" : "value = 1\n");
  for (const args of [["init", "-b", "main"], ["add", "hy-workflow.json", "src"]]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    if (git.status !== 0) throw new Error(`could not prepare lint fixture git index: ${git.stderr}`);
  }
  const originalCompat = "{\"existing\":true}\n";
  fs.writeFileSync(path.join(root, "codelint.json"), originalCompat);
  const fakeNpx = path.join(bin, "npx");
  fs.writeFileSync(fakeNpx, `#!/usr/bin/env bash
case "\${FAKE_LINT_MODE:-ok}" in
  command-fail) exit 7 ;;
  invalid-json) printf 'not-json' ;;
  missing-ok) printf '{"errors":0,"failed":0,"files":2}' ;;
  codelint-missing-ok)
    if [[ "$*" == *codelint* ]]; then
      printf '{"errors":0,"warnings":0,"total_files":3}'
    else
      printf '{"ok":true,"errors":0,"failed":0,"files":2}'
    fi ;;
  codelint-na)
    if [[ "$*" == *codelint* ]]; then
      printf '{"errors":0,"warnings":0,"total_files":0}'
    else
      printf '{"ok":true,"errors":0,"failed":0,"files":2}'
    fi ;;
  ok-false) printf '{"ok":false,"errors":0,"failed":0,"files":2}' ;;
  errors) printf '{"ok":true,"errors":2,"failed":0,"files":2}' ;;
  failed) printf '{"ok":true,"errors":0,"failed":3,"files":2}' ;;
  zero-files) printf '{"ok":true,"errors":0,"failed":0,"files":0}' ;;
  missing-files) printf '{"ok":true,"errors":0,"failed":0}' ;;
  *) printf '{"ok":true,"errors":0,"failed":0,"files":2}' ;;
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
exerciseLintScript("codelint-missing-ok", true);
exerciseLintScript("codelint-na", true, ".ts");
for (const mode of ["command-fail", "invalid-json", "missing-ok", "ok-false", "errors", "failed", "zero-files", "missing-files"]) {
  exerciseLintScript(mode, false);
}

console.log("setup-workflow: always-shared strict CI template is canonical");
