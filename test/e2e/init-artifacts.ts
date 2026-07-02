import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalArtifactIgnores, handleInit, harnessArtifactStatus, initArtifactGuidance, trackedLocalArtifactDiagnostics } from "../../src/tools/init.js";
import { SETUP_STAMP } from "../../src/bootstrap.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

const root = mkdtempSync(join(tmpdir(), "hy-init-artifacts-"));
const guidance = initArtifactGuidance();

assert(guidance.commitArtifacts.includes(".github/"), "commit artifacts should include .github/");
assert(guidance.commitArtifacts.includes("AGENTS.md"), "commit artifacts should include AGENTS.md");
assert(guidance.commitArtifacts.includes(".gitignore"), "commit artifacts should include .gitignore");
assert(guidance.commitArtifacts.includes("hy-workflow.json"), "commit artifacts should include hy-workflow.json");
assert(guidance.localArtifacts.includes(".hy/"), "local artifacts should include .hy/");
assert(guidance.localArtifacts.includes(".opencode/"), "local artifacts should include .opencode/");
assert(guidance.localArtifacts.includes(".codex/"), "local artifacts should include .codex/");
assert(guidance.localArtifacts.includes(".mcp.json"), "local artifacts should include .mcp.json");
assert(guidance.localArtifacts.includes("codelint.json"), "local artifacts should include runtime codelint compatibility file");
assert(guidance.localArtifacts.includes("doclint.json"), "local artifacts should include runtime doclint compatibility file");
assert(guidance.localArtifacts.includes("docs-gardener.json"), "local artifacts should include runtime docs-gardener compatibility file");
assert(guidance.body.includes("Do not commit local/runtime artifacts"), "guidance should include do-not-commit section");

const changedFirst = ensureLocalArtifactIgnores(root);
assert(changedFirst, "first .gitignore update should report changed");
const first = readFileSync(join(root, ".gitignore"), "utf-8");
assert(first.includes(".hy/\n"), ".gitignore should include .hy/");
assert(first.includes(".opencode/\n"), ".gitignore should include .opencode/");
assert(first.includes(".codex/\n"), ".gitignore should include .codex/");
assert(first.includes(".mcp.json\n"), ".gitignore should include .mcp.json");
assert(first.includes("codelint.json\n"), ".gitignore should include codelint.json");
assert(first.includes("doclint.json\n"), ".gitignore should include doclint.json");
assert(first.includes("docs-gardener.json\n"), ".gitignore should include docs-gardener.json");

const changedSecond = ensureLocalArtifactIgnores(root);
assert(!changedSecond, "second .gitignore update should be idempotent");
const second = readFileSync(join(root, ".gitignore"), "utf-8");
assert(second === first, "idempotent update should not rewrite content");

const existingRoot = mkdtempSync(join(tmpdir(), "hy-init-artifacts-existing-"));
writeFileSync(join(existingRoot, ".gitignore"), "node_modules/\n.hy/\n", "utf-8");
const changedExisting = ensureLocalArtifactIgnores(existingRoot);
assert(changedExisting, "missing local artifact entries should be appended");
const existing = readFileSync(join(existingRoot, ".gitignore"), "utf-8");
assert(existing === "node_modules/\n.hy/\n.opencode/\n.codex/\n.mcp.json\ncodelint.json\ndoclint.json\ndocs-gardener.json\n", "existing .gitignore should preserve content and append missing entries");

const missingHarnessRoot = mkdtempSync(join(tmpdir(), "hy-init-harness-missing-"));
const missingHarness = harnessArtifactStatus(missingHarnessRoot);
assert(!missingHarness.ready, "missing harness artifacts should not be ready");
assert(missingHarness.missingArtifacts.includes(".github/"), "missing harness should include .github/");
assert(missingHarness.missingArtifacts.includes("hy-workflow.json"), "missing harness should include hy-workflow.json");
assert(!missingHarness.missingArtifacts.includes("codelint.json"), "missing harness should not require codelint.json");
assert(!missingHarness.missingArtifacts.includes("doclint.json"), "missing harness should not require doclint.json");
assert(!missingHarness.missingArtifacts.includes("docs-gardener.json"), "missing harness should not require docs-gardener.json");

const readyHarnessRoot = mkdtempSync(join(tmpdir(), "hy-init-harness-ready-"));
mkdirSync(join(readyHarnessRoot, ".github"));
writeFileSync(join(readyHarnessRoot, "hy-workflow.json"), "{}\n", "utf-8");
const readyHarness = harnessArtifactStatus(readyHarnessRoot);
assert(readyHarness.ready, "complete harness artifacts should be ready");
assert(readyHarness.missingArtifacts.length === 0, "ready harness should have no missing artifacts");

const trackedRoot = mkdtempSync(join(tmpdir(), "hy-init-tracked-artifacts-"));
run("git init -b main", trackedRoot);
run("git config user.email test@example.com", trackedRoot);
run("git config user.name Test", trackedRoot);
mkdirSync(join(trackedRoot, ".hy"), { recursive: true });
writeFileSync(join(trackedRoot, ".hy", "workflow.json"), "{}\n", "utf-8");
writeFileSync(join(trackedRoot, "codelint.json"), "{}\n", "utf-8");
writeFileSync(join(trackedRoot, "doclint.json"), "{}\n", "utf-8");
writeFileSync(join(trackedRoot, "docs-gardener.json"), "{}\n", "utf-8");
writeFileSync(join(trackedRoot, "README.md"), "# test\n", "utf-8");
run("git add .", trackedRoot);
run("git commit -m init", trackedRoot);
const trackedLocal = trackedLocalArtifactDiagnostics(trackedRoot);
assert(trackedLocal.includes(".hy/workflow.json"), "tracked diagnostics should include tracked .hy runtime files");
assert(trackedLocal.includes("codelint.json"), "tracked diagnostics should include tracked codelint compatibility file");
assert(trackedLocal.includes("doclint.json"), "tracked diagnostics should include tracked doclint compatibility file");
assert(trackedLocal.includes("docs-gardener.json"), "tracked diagnostics should include tracked docs-gardener compatibility file");
const trackedGuidance = initArtifactGuidance(trackedLocal);
assert(trackedGuidance.trackedLocalArtifacts.includes("codelint.json"), "guidance should expose tracked local artifacts");
assert(trackedGuidance.body.includes("Tracked local/runtime artifacts detected"), "guidance should call out tracked local artifacts");
assert(trackedGuidance.body.includes("git rm --cached"), "guidance should include index cleanup recovery");


const outdatedInitRoot = mkdtempSync(join(tmpdir(), "hy-init-outdated-stamp-"));
run("git init -b main", outdatedInitRoot);
mkdirSync(join(outdatedInitRoot, ".github", "workflows"), { recursive: true });
writeFileSync(join(outdatedInitRoot, ".github", "workflows", "hy-workflow.yml"), "name: hy-workflow\n", "utf-8");
writeFileSync(join(outdatedInitRoot, "hy-workflow.json"), "{}\n", "utf-8");
mkdirSync(join(outdatedInitRoot, ".git", "hy-workflow"), { recursive: true });
writeFileSync(join(outdatedInitRoot, SETUP_STAMP), JSON.stringify({ schemaVersion: "1", setupVersion: "0.0.0" }, null, 2) + "\n", "utf-8");
const initCwd = process.cwd();
try {
  process.chdir(outdatedInitRoot);
  const outdatedInit = await handleInit();
  assert(outdatedInit.error?.subtype === "setup_update_required", "hy_init should reject outdated setup stamp even when artifacts exist");
  assert(outdatedInit.requires_user === true && outdatedInit.stop_here === true, "outdated setup stamp should stop hy_init");
} finally {
  process.chdir(initCwd);
}
