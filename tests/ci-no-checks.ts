import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { handleCi } from "../src/tools/ci.js";
import { readState, writeState, type WorkflowState } from "../src/state.js";

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
const root = mkdtempSync(join(tmpdir(), "hy-ci-no-checks-"));
const bin = join(root, "bin");

try {
  run("git init -b main", root);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    "#!/usr/bin/env bash\nif [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then\n  printf '{\"statusCheckRollup\":[]}'\n  exit 0\nfi\nexit 1\n",
    "utf-8",
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  chdir(root);

  writeState(baseState());
  const result = await handleCi({ timeoutSeconds: 0, intervalSeconds: 2 });

  if (result.next !== "merge" || result.phase !== "merge") {
    throw new Error(`no checks should advance to merge, got ${JSON.stringify(result)}`);
  }
  if (!result.skipped || result.skipReason !== "no_reported_checks" || !result.noChecks) {
    throw new Error(`no checks should return auditable skip fields, got ${JSON.stringify(result)}`);
  }
  if (result.requires_user || result.stop_here) {
    throw new Error(`no checks skip should be a happy path, got ${JSON.stringify(result)}`);
  }
  if (readState().phase !== "merge") {
    throw new Error("no checks skip should persist merge phase");
  }
} finally {
  chdir(originalCwd);
  process.env.PATH = originalPath;
}
