import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

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

const UNSAFE_REF_CHARS = /[\x00-\x20~^:?*\[\\;$`"'|&<>]/;

function isSafeConfigRefName(value: string): boolean {
  if (!value || value.length > 200 || value.trim() !== value) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (UNSAFE_REF_CHARS.test(value)) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  return value.split("/").every(part => Boolean(part) && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

function checkedBaseBranch(value: unknown, source: string): string | null {
  if (typeof value !== "string") return null;
  if (isSafeConfigRefName(value)) return value;
  throw {
    type: "config",
    subtype: "config_invalid",
    code: "INVALID_BASE_BRANCH",
    message: `${source} must be a safe Git branch name.`,
    hint: "Use letters, numbers, dot, underscore, slash, and hyphen only; do not use shell metacharacters, whitespace, leading dash, '..', '@{', or .lock suffixes.",
    detail: { value },
  };
}

export function configuredBaseBranch(root: string): string {
  try {
    const unifiedPath = path.join(root, "hy-workflow.json");
    if (fs.existsSync(unifiedPath)) {
      const config = JSON.parse(fs.readFileSync(unifiedPath, "utf-8"));
      const branch = checkedBaseBranch(config?.project?.baseBranch, "hy-workflow.json project.baseBranch");
      if (branch) return branch;
    }
    const legacyPath = path.join(root, "codelint.json");
    if (fs.existsSync(legacyPath)) {
      const config = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const branch = checkedBaseBranch(config.baseBranch, "codelint.json baseBranch");
      if (branch) return branch;
    }
  } catch (e: any) {
    if (e?.type === "config") throw e;
  }
  return "dev";
}

