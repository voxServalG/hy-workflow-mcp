import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest } from "../../src/checks.js";
import {
  buildSuggestedCommand,
  checkConfig,
  RUNTIME_CONFIG_SOURCE_ENV,
  RUNTIME_CONFIG_SOURCE_SCHEMA,
} from "../../src/config.js";
import { checkCi, checkout, createBranch, createPr, isSafeGitRefName, mergePr, push } from "../../src/git.js";
import { readState, statePath, writeState, type WorkflowState } from "../../src/state.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;
function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function baseState(phase: WorkflowState["phase"]): WorkflowState {
  return {
    version: "1",
    phase,
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
  };
}

function makeGitRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  run("git init -b main", root);
  run("git config user.email test@example.com", root);
  run("git config user.name Test", root);
  writeFileSync(join(root, "README.md"), "initial\n", "utf-8");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"] },
  }, null, 2) + "\n", "utf-8");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  run("git add .", root);
  run("git commit -m init", root);
  run("git remote add origin https://github.com/o/r.git", root);
  run("git update-ref refs/remotes/origin/main HEAD", root);
  return root;
}

assert(isSafeGitRefName("main"), "main should be safe");
assert(isSafeGitRefName("release/v1.2"), "slash refs should be safe");
assert(!isSafeGitRefName("main;touch${IFS}/tmp/x"), "semicolon refs must be rejected");
assert(!isSafeGitRefName("main$(touch /tmp/x)"), "command substitution refs must be rejected");
assert(!isSafeGitRefName("-main"), "leading dash refs must be rejected");

const originalCwd = cwd();
const originalPath = process.env.PATH ?? "";
const runtimeHome = mkdtempSync(join(tmpdir(), "hy-security-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");
const root = makeGitRoot("hy-security-shell-");
const sentinel = join(root, "sentinel");
const injectedBranch = `main;touch${"${IFS}"}${sentinel}`;

try {
  chdir(root);

  const dangerousBranch = createBranch(root, "fix", `bad;touch${"${IFS}"}${sentinel}`);
  assert(dangerousBranch.ok === false, "dangerous branch topic should fail before git execution");
  assert((dangerousBranch.error as any)?.code === "INVALID_BRANCH_TOPIC", `dangerous topic should return INVALID_BRANCH_TOPIC, got ${JSON.stringify(dangerousBranch.error)}`);
  assert(!existsSync(sentinel), "dangerous branch topic must not execute shell payload");

  for (const result of [push(root, injectedBranch, "0".repeat(40), "github.com/o/r"), checkout(root, injectedBranch), checkCi(root, `1;touch${"${IFS}"}${sentinel}`), mergePr(root, `1;touch${"${IFS}"}${sentinel}`)]) {
    assert(result.ok === false, `dangerous git/gh argument should fail: ${JSON.stringify(result)}`);
    assert(!existsSync(sentinel), "dangerous git/gh argument must not execute shell payload");
  }

  const bin = join(root, "bin");
  const prMarker = join(root, "pr-created");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nif [ \"\${1:-}\" = \"--version\" ]; then printf 'gh version test\\n'; exit 0; fi\nif [ \"\${1:-}\" = \"auth\" ] && [ \"\${2:-}\" = \"status\" ]; then exit 0; fi\nif [ \"\${1:-}\" = \"pr\" ] && [ \"\${2:-}\" = \"list\" ]; then\n  if [ -f \"$HY_TEST_PR_MARKER\" ]; then oid=\"$(git rev-parse HEAD)\"; printf '[{\"number\":999,\"url\":\"https://github.com/o/r/pull/999\",\"state\":\"OPEN\",\"baseRefName\":\"main\",\"headRefName\":\"fix/safe-head\",\"headRefOid\":\"%s\",\"isCrossRepository\":false}]' \"$oid\"; else printf '[]'; fi\n  exit 0\nfi\nif [ \"\${1:-}\" = \"pr\" ] && [ \"\${2:-}\" = \"create\" ]; then : > \"$HY_TEST_PR_MARKER\"; printf 'https://github.com/o/r/pull/999\\n'; exit 0; fi\nexit 1\n", "utf-8");
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.HY_TEST_PR_MARKER = prMarker;
  const titleInjection = `title\";touch ${sentinel};echo \"`;
  const expectedOid = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
  const pr = createPr(root, titleInjection, "body", "main", "fix/safe-head", expectedOid, "github.com/o/r");
  assert(pr.ok, `createPr should accept arbitrary title via argv: ${JSON.stringify(pr)}`);
  assert(!existsSync(sentinel), "PR title shell payload must not execute");

  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: `main;touch${"${IFS}"}${sentinel}`, codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" }, codelint: { lintDirs: ["src"] } }, null, 2) + "\n", "utf-8");
  const config = checkConfig(root);
  assert(!config.ok, "unsafe baseBranch should fail config check");
  assert(config.issues.some(issue => issue.includes("project.baseBranch is not a safe Git branch name")), `unsafe baseBranch issue missing: ${config.issues.join(";")}`);
  try {
    buildImplementationManifest(root);
    throw new Error("unsafe baseBranch should not reach git diff");
  } catch (e: any) {
    assert(
      e.code === "INVALID_BASE_BRANCH"
      || (e.code === "ROOT_CONFIG_INVALID" && e.detail?.issues?.some((issue: string) => issue.includes("project.baseBranch is not a safe Git branch name"))),
      `unsafe baseBranch should throw structured config error, got ${JSON.stringify(e)}`,
    );
  }
  assert(!existsSync(sentinel), "unsafe baseBranch must not execute shell payload");

  const command = buildSuggestedCommand({ codeExt: ".ts", codeDirs: ["src;touch${IFS}/tmp/x"], lintDirs: ["src"], docsDir: "docs", baseBranch: "dev;touch${IFS}/tmp/x", maxCodeLines: 500, maxDocLines: 200 }, true);
  assert(command.includes("--base-branch INVALID_BASE_BRANCH"), `unsafe baseBranch should be replaced: ${command}`);
  assert(command.includes("--code-dirs INVALID_CODE_DIRS"), `unsafe codeDirs should be replaced: ${command}`);
  assert(!command.includes("touch${IFS}"), `unsafe values must not be echoed into a suggested command: ${command}`);

  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"] },
  }, null, 2) + "\n", "utf-8");
  writeState({ ...baseState("merge") });
  writeFileSync(statePath(), JSON.stringify({ ...baseState("commit"), prNumber: `1;touch${"${IFS}"}${sentinel}` }, null, 2) + "\n", "utf-8");
  try {
    readState();
    throw new Error("invalid prNumber should fail state read");
  } catch (e: any) {
    assert(e.code === "WORKFLOW_STATE_INVALID_PR_NUMBER", `invalid prNumber should be structured, got ${JSON.stringify(e)}`);
  }
  assert(!existsSync(sentinel), "invalid prNumber must not execute shell payload");
} finally {
  delete process.env.HY_TEST_PR_MARKER;
  chdir(originalCwd);
  process.env.PATH = originalPath;
}
