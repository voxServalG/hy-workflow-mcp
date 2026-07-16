import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function useRuntimeHome(prefix = "hy-runtime-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HY_WORKFLOW_CONFIG_HOME = path.join(root, "config");
  process.env.HY_WORKFLOW_STATE_HOME = path.join(root, "state");
  process.env.HY_WORKFLOW_CACHE_HOME = path.join(root, "cache");
  return root;
}

export function makeGitProject(prefix = "hy-project-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Docs\n\nMaintained project facts and verification expectations.\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Test\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "hy-workflow-fixture",
    version: "1.0.0",
    scripts: { build: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"" },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    name: "hy-workflow-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "hy-workflow-fixture", version: "1.0.0" } },
  }, null, 2) + "\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

export function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}
