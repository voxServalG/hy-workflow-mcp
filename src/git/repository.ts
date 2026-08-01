import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { HyWorkflowError } from "../cli/output.js";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

export type GitResult = {
  stdout: Buffer;
  stderr: string;
  status: number;
};

export function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): GitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: 60_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    throw new HyWorkflowError("GIT_UNAVAILABLE", `Git could not run: ${result.error.message}`);
  }
  const status = result.status ?? 1;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
  if (status !== 0 && !options.allowFailure) {
    throw new HyWorkflowError(
      "GIT_COMMAND_FAILED",
      `git ${args[0] ?? "command"} failed${stderr ? `: ${stderr}` : "."}`,
    );
  }
  return {
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr,
    status,
  };
}
export function findRepositoryRoot(cwd = process.cwd()): string {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.status !== 0) {
    throw new HyWorkflowError("GIT_REPOSITORY_NOT_FOUND", "Current directory is not inside a Git worktree.");
  }
  const root = result.stdout.toString("utf8").trim();
  if (!root || !path.isAbsolute(root)) {
    throw new HyWorkflowError("GIT_REPOSITORY_INVALID", "Git returned an invalid worktree root.");
  }
  return path.resolve(root);
}

export function isTrackedFile(root: string, relativePath: string): boolean {
  return runGit(root, ["ls-files", "--error-unmatch", "--", relativePath], { allowFailure: true }).status === 0;
}
