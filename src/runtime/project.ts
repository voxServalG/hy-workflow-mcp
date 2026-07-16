import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
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
  const candidate = path.resolve(start);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (root) return fs.realpathSync.native(root);
  } catch {}
  throw new ProjectRootError(candidate);
}

export function resolveGitPrivatePath(root: string, relativePath: string): string {
  try {
    const resolved = execFileSync("git", ["rev-parse", "--git-path", relativePath], { cwd: root, encoding: "utf-8" }).trim();
    return path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
  } catch {
    return path.join(root, ".git", relativePath);
  }
}

export function currentGitBranch(root: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function configuredBaseBranch(root: string): string {
  return requireRuntimeBaseBranch(root);
}
