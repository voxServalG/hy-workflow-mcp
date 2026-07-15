import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest } from "../../src/checks.js";
import { buildSuggestedCommand, checkConfig } from "../../src/config.js";
import { checkCi, checkout, createBranch, createPr, isSafeGitRefName, mergePr, push } from "../../src/git.js";
import { readState, statePath, writeState, type WorkflowState } from "../../src/state.js";
import { handleChain } from "../../src/tools/chain.js";

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
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" } }, null, 2) + "\n", "utf-8");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  run("git add .", root);
  run("git commit -m init", root);
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

  for (const result of [push(root, injectedBranch), checkout(root, injectedBranch), checkCi(root, `1;touch${"${IFS}"}${sentinel}`), mergePr(root, `1;touch${"${IFS}"}${sentinel}`)]) {
    assert(result.ok === false, `dangerous git/gh argument should fail: ${JSON.stringify(result)}`);
    assert(!existsSync(sentinel), "dangerous git/gh argument must not execute shell payload");
  }

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nprintf 'https://github.com/o/r/pull/999\\n'\n", "utf-8");
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const titleInjection = `title\";touch ${sentinel};echo \"`;
  const pr = createPr(root, titleInjection, "body", "main", "fix/safe-head");
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
    assert(e.code === "INVALID_BASE_BRANCH" || String(e.message).includes("INVALID_BASE_BRANCH"), `unsafe baseBranch should throw structured config error, got ${JSON.stringify(e)}`);
  }
  assert(!existsSync(sentinel), "unsafe baseBranch must not execute shell payload");

  const command = buildSuggestedCommand({ codeExt: ".ts", codeDirs: ["src;touch${IFS}/tmp/x"], lintDirs: ["src"], docsDir: "docs", baseBranch: "dev;touch${IFS}/tmp/x", maxCodeLines: 500, maxDocLines: 200 }, true);
  assert(command.includes("--base-branch 'dev;touch${IFS}/tmp/x'"), `baseBranch should be shell-quoted: ${command}`);
  assert(command.includes("--code-dirs 'src;touch${IFS}/tmp/x'"), `codeDirs should be shell-quoted: ${command}`);

  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({ project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" } }, null, 2) + "\n", "utf-8");
  writeState({ ...baseState("chain") });
  const chain = await handleChain({ branches: [`topic;touch${"${IFS}"}${sentinel}`] });
  assert(chain.next === "chain", `dangerous chain branch should stay in chain, got ${JSON.stringify(chain)}`);
  assert(chain.requires_user && chain.stop_here, `dangerous chain branch should stop, got ${JSON.stringify(chain)}`);
  assert(!existsSync(sentinel), "dangerous chain branch must not execute shell payload");

  writeFileSync(statePath(), JSON.stringify({ ...baseState("ci"), prNumber: `1;touch${"${IFS}"}${sentinel}` }, null, 2) + "\n", "utf-8");
  try {
    readState();
    throw new Error("invalid prNumber should fail state read");
  } catch (e: any) {
    assert(e.code === "WORKFLOW_STATE_INVALID_PR_NUMBER", `invalid prNumber should be structured, got ${JSON.stringify(e)}`);
  }
  assert(!existsSync(sentinel), "invalid prNumber must not execute shell payload");
} finally {
  chdir(originalCwd);
  process.env.PATH = originalPath;
}
