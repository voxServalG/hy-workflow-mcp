import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { requireRuntimeBaseBranch } from "../config.js";

export class ProjectRootError extends Error {
  type = "config" as const;
  subtype = "setup_artifacts_missing" as const;
  code = "PROJECT_ROOT_NOT_FOUND";
  hint = "Run hy-workflow tools from inside a Git worktree, or initialize Git before starting hy-workflow.";
  retryable = false;

  constructor(start: string) {
    super(`Could not find a Git project root from ${start}.`);
    this.name = "ProjectRootError";
  }
}

export function findProjectRoot(start = process.cwd()): string {
  let dir = start;
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ProjectRootError(start);
}

export function resolveGitPrivatePath(root: string, relativePath: string): string {
  try {
    const resolved = execSync(`git rev-parse --git-path ${relativePath}`, { cwd: root })
      .toString()
      .trim();
    return path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
  } catch {
    return path.join(root, ".git", relativePath);
  }
}

export function currentGitBranch(root: string): string {
  try {
    return execSync("git branch --show-current", { cwd: root }).toString().trim();
  } catch {
    return "unknown";
  }
}

export function configuredBaseBranch(root: string): string {
  return requireRuntimeBaseBranch(root);
}
