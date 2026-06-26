import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export function findProjectRoot(start = process.cwd()): string {
  let dir = start;
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
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
  try {
    const unifiedPath = path.join(root, "hy-workflow.json");
    if (fs.existsSync(unifiedPath)) {
      const config = JSON.parse(fs.readFileSync(unifiedPath, "utf-8"));
      if (config?.project?.baseBranch) return config.project.baseBranch;
    }
    const legacyPath = path.join(root, "codelint.json");
    if (fs.existsSync(legacyPath)) {
      const config = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      if (config.baseBranch) return config.baseBranch;
    }
  } catch {}
  return "dev";
}

