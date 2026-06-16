import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalArtifactIgnores, harnessArtifactStatus, initArtifactGuidance } from "../src/tools/init.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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
assert(guidance.body.includes("Do not commit local/runtime artifacts"), "guidance should include do-not-commit section");

const changedFirst = ensureLocalArtifactIgnores(root);
assert(changedFirst, "first .gitignore update should report changed");
const first = readFileSync(join(root, ".gitignore"), "utf-8");
assert(first.includes(".hy/\n"), ".gitignore should include .hy/");
assert(first.includes(".opencode/\n"), ".gitignore should include .opencode/");
assert(first.includes(".codex/\n"), ".gitignore should include .codex/");
assert(first.includes(".mcp.json\n"), ".gitignore should include .mcp.json");

const changedSecond = ensureLocalArtifactIgnores(root);
assert(!changedSecond, "second .gitignore update should be idempotent");
const second = readFileSync(join(root, ".gitignore"), "utf-8");
assert(second === first, "idempotent update should not rewrite content");

const existingRoot = mkdtempSync(join(tmpdir(), "hy-init-artifacts-existing-"));
writeFileSync(join(existingRoot, ".gitignore"), "node_modules/\n.hy/\n", "utf-8");
const changedExisting = ensureLocalArtifactIgnores(existingRoot);
assert(changedExisting, "missing local artifact entries should be appended");
const existing = readFileSync(join(existingRoot, ".gitignore"), "utf-8");
assert(existing === "node_modules/\n.hy/\n.opencode/\n.codex/\n.mcp.json\n", "existing .gitignore should preserve content and append missing entries");

const missingHarnessRoot = mkdtempSync(join(tmpdir(), "hy-init-harness-missing-"));
const missingHarness = harnessArtifactStatus(missingHarnessRoot);
assert(!missingHarness.ready, "missing harness artifacts should not be ready");
assert(missingHarness.missingArtifacts.includes(".github/"), "missing harness should include .github/");
assert(missingHarness.missingArtifacts.includes("hy-workflow.json"), "missing harness should include hy-workflow.json");
assert(missingHarness.missingArtifacts.includes("codelint.json"), "missing harness should include codelint.json");
assert(missingHarness.missingArtifacts.includes("doclint.json"), "missing harness should include doclint.json");
assert(missingHarness.missingArtifacts.includes("docs-gardener.json"), "missing harness should include docs-gardener.json");

const readyHarnessRoot = mkdtempSync(join(tmpdir(), "hy-init-harness-ready-"));
mkdirSync(join(readyHarnessRoot, ".github"));
writeFileSync(join(readyHarnessRoot, "hy-workflow.json"), "{}\n", "utf-8");
writeFileSync(join(readyHarnessRoot, "codelint.json"), "{}\n", "utf-8");
writeFileSync(join(readyHarnessRoot, "doclint.json"), "{}\n", "utf-8");
writeFileSync(join(readyHarnessRoot, "docs-gardener.json"), "{}\n", "utf-8");
const readyHarness = harnessArtifactStatus(readyHarnessRoot);
assert(readyHarness.ready, "complete harness artifacts should be ready");
assert(readyHarness.missingArtifacts.length === 0, "ready harness should have no missing artifacts");
