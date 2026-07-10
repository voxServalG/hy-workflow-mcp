import { detectExecutorCapabilities, requireGhExecutor, requireGitExecutor } from "../../src/executors.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const originalPath = process.env.PATH;

try {
  const capabilities = detectExecutorCapabilities();
  assert(capabilities.git.executor === "git", "git capability should identify its executor");
  assert(capabilities.gh.executor === "gh", "gh capability should identify its executor");
  assert(capabilities.internal.available === false, "unimplemented internal fallback must stay disabled");

  const git = requireGitExecutor();
  assert(git.ok, `test environment should provide git: ${JSON.stringify(git)}`);
  assert(git.executor.available, "required git executor should be available");

  process.env.PATH = "";
  const missingGit = requireGitExecutor();
  assert(!missingGit.ok, "missing git should fail closed");
  assert((missingGit as any).error.code === "GIT_EXECUTOR_UNAVAILABLE", "missing git should return a stable error code");

  const missingGh = requireGhExecutor();
  assert(!missingGh.ok, "missing gh should fail closed");
  assert((missingGh as any).error.code === "GH_EXECUTOR_UNAVAILABLE", "missing gh should return a stable error code");
} finally {
  process.env.PATH = originalPath;
}
