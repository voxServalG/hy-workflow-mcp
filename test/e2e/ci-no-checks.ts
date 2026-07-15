import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleCi } from "../../src/tools/ci.js";
import { readState, statePath, writeState, type WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function baseState(): WorkflowState {
  return {
    version: "1",
    phase: "ci",
    branch: "fix/no-checks",
    prNumber: 123,
    plan: null,
    approval: null,
    verifyHash: "abc123",
  };
}

const originalCwd = cwd();
const originalPath = process.env.PATH ?? "";
const runtimeHome = mkdtempSync(join(tmpdir(), "hy-ci-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");
const root = mkdtempSync(join(tmpdir(), "hy-ci-no-checks-"));
const bin = join(root, "bin");

try {
  run("git init -b main", root);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    "#!/usr/bin/env bash\nif [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then\n  if [ \"${HY_TEST_CI_RESULT:-empty}\" = \"neutral\" ]; then\n    printf '{\"statusCheckRollup\":[{\"name\":\"docs\",\"conclusion\":\"SKIPPED\"},{\"name\":\"advisory\",\"conclusion\":\"NEUTRAL\"}]}'\n  else\n    printf '{\"statusCheckRollup\":[]}'\n  fi\n  exit 0\nfi\nexit 1\n",
    "utf-8",
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  chdir(root);

  writeState(baseState());
  const result = await handleCi({ timeoutSeconds: 0, intervalSeconds: 2 });

  if (result.next !== "ci" || result.phase !== "ci") {
    throw new Error(`no checks should remain in ci, got ${JSON.stringify(result)}`);
  }
  if (!result.noChecks || result.allGreen || result.error?.code !== "CI_CHECKS_REQUIRED") {
    throw new Error(`no checks should return a structured fail-closed result, got ${JSON.stringify(result)}`);
  }
  if (!result.requires_user || !result.stop_here || !result.blockedTools?.includes("hy_merge")) {
    throw new Error(`no checks should stop and block merge, got ${JSON.stringify(result)}`);
  }
  if (readState().phase !== "ci") {
    throw new Error("no checks must preserve ci phase");
  }

  process.env.HY_TEST_CI_RESULT = "neutral";
  writeState(baseState());
  const neutral = await handleCi({ timeoutSeconds: 0, intervalSeconds: 2 });
  if (neutral.next !== "ci" || neutral.phase !== "ci" || !neutral.noEffectiveChecks) {
    throw new Error(`only skipped/neutral checks should remain in ci, got ${JSON.stringify(neutral)}`);
  }
  if (!neutral.requires_user || !neutral.stop_here || neutral.error?.code !== "CI_CHECKS_REQUIRED") {
    throw new Error(`only skipped/neutral checks should fail closed, got ${JSON.stringify(neutral)}`);
  }
  if (readState().phase !== "ci") {
    throw new Error("only skipped/neutral checks must preserve ci phase");
  }

  delete process.env.HY_TEST_CI_RESULT;
  const sentinel = join(root, "ci-injection-sentinel");
  writeFileSync(statePath(), JSON.stringify({ ...baseState(), phase: "ci", prNumber: `123;touch${"${IFS}"}${sentinel}` }, null, 2) + "\n", "utf-8");
  try {
    await handleCi({ timeoutSeconds: 0, intervalSeconds: 2 });
    throw new Error("invalid prNumber should fail before gh execution");
  } catch (e: any) {
    if (e.code !== "WORKFLOW_STATE_INVALID_PR_NUMBER") {
      throw new Error(`invalid prNumber should be structured, got ${JSON.stringify(e)}`);
    }
  }
  if (existsSync(sentinel)) {
    throw new Error("invalid prNumber should not execute shell payload");
  }
} finally {
  delete process.env.HY_TEST_CI_RESULT;
  chdir(originalCwd);
  process.env.PATH = originalPath;
}
