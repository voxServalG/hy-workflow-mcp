import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitScope } from "../../src/git.js";
import type { PlanDoc } from "../../src/state.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "hy-commit-retry-"));

try {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  for (const file of ["A.js", "B.js", "doc-1.md", "doc-2.md"]) writeFileSync(join(root, file), `${file}\n`, "utf-8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  const scope: PlanDoc["scope"] = {
    changes: ["doc-1.md", "doc-2.md"],
    new_files: [],
    delete: ["A.js", "B.js"],
  };

  unlinkSync(join(root, "A.js"));
  unlinkSync(join(root, "B.js"));
  writeFileSync(join(root, "doc-1.md"), "first fix\n", "utf-8");
  const first = commitScope(root, scope, "first", "delete old files");
  assert(first.ok, `first scoped commit should succeed: ${JSON.stringify(first)}`);
  assert(first.stagedPaths?.includes("A.js") && first.stagedPaths?.includes("B.js"), "first commit should stage current deletions");

  writeFileSync(join(root, "doc-2.md"), "ci follow-up\n", "utf-8");
  const second = commitScope(root, scope, "second", "ci fix");
  assert(second.ok, `second scoped commit should skip already committed deletions: ${JSON.stringify(second)}`);
  assert(JSON.stringify(second.stagedPaths) === JSON.stringify(["doc-2.md"]), `second commit should stage only the live diff: ${JSON.stringify(second.stagedPaths)}`);
  assert(git(root, ["status", "--porcelain"]) === "", "worktree should be clean after the second commit");
  assert(git(root, ["rev-list", "--count", "HEAD"]) === "3", "both scoped commits should be recorded");
} finally {
  rmSync(root, { recursive: true, force: true });
}
