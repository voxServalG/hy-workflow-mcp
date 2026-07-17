import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { createHash } from "node:crypto";
import { cacheReviewedArtifacts, clearReviewedArtifacts, loadReviewedArtifacts } from "../../src/setup/reviewed-artifacts.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-reviewed-"));
const stateHome = join(root, ".local", "state");
mkdirSync(stateHome, { recursive: true });
mkdirSync(join(root, ".config"), { recursive: true });
mkdirSync(join(root, ".cache"), { recursive: true });
process.env.HY_WORKFLOW_STATE_HOME = stateHome;
process.env.HY_WORKFLOW_CONFIG_HOME = join(root, ".config");
process.env.HY_WORKFLOW_CACHE_HOME = join(root, ".cache");

try {
  chdir(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/example/test.git\n");

  const entries = [
    { file: "hy-workflow.json", beforeHash: "a".repeat(64), afterHash: "b".repeat(64) },
    { file: ".github/workflows/hy-workflow.yml", beforeHash: "c".repeat(64), afterHash: "d".repeat(64) },
  ];

  assert(loadReviewedArtifacts(root, entries) === null, "empty cache should return null");

  cacheReviewedArtifacts(root, entries);
  const hit = loadReviewedArtifacts(root, entries);
  assert(hit !== null, "cache hit should return entries");
  assert(hit!.length === 2, "cache hit should return 2 entries");

  const mismatch = [{ file: "hy-workflow.json", beforeHash: "a".repeat(64), afterHash: "x".repeat(64) }];
  assert(loadReviewedArtifacts(root, mismatch) === null, "mismatched afterHash should miss");

  const missing = [...entries, { file: "AGENTS.md", beforeHash: null, afterHash: "e".repeat(64) }];
  assert(loadReviewedArtifacts(root, missing) === null, "extra file requested should miss");

  clearReviewedArtifacts(root);
  assert(loadReviewedArtifacts(root, entries) === null, "after clear, cache should be empty");

  console.log("setup-reviewed-artifacts: cache, mismatch, and clear all pass");
} finally {
  chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
