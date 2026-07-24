import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { checkCi, classifyVerifyChecks, isVerifyCheckIdentity, type CiCheck } from "../../src/git.js";
import { readState, statePath, writeState, type WorkflowState } from "../../src/state.js";

function run(cmd: string, root: string): void {
  execSync(cmd, { cwd: root, stdio: "ignore" });
}

function ciCheck(name: string, conclusion: string, provenanceVerified = false, workflow = ""): CiCheck {
  return { name, conclusion, workflow, link: "", provenanceVerified };
}

function baseState(): WorkflowState {
  return {
    version: "1",
    phase: "commit",
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
    "#!/usr/bin/env bash\nif [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then\n  printf '{}'\n  exit 0\nfi\nif [ \"$1\" = \"pr\" ] && [ \"$2\" = \"checks\" ]; then\n  case \"${HY_TEST_CI_RESULT:-empty}\" in\n    neutral) printf '[{\"name\":\"advisory\",\"workflow\":\"other\",\"bucket\":\"skipping\",\"state\":\"NEUTRAL\",\"link\":\"https://example.invalid/check\"}]' ;;\n    unrelated) printf '[{\"name\":\"build\",\"workflow\":\"build\",\"bucket\":\"pass\",\"state\":\"SUCCESS\",\"link\":\"https://example.invalid/check\"}]' ;;\n    spoof) printf '[{\"name\":\"Verify\",\"workflow\":\"third-party\",\"bucket\":\"pass\",\"state\":\"SUCCESS\",\"link\":\"https://example.invalid/check\"}]' ;;\n    *) printf '[]' ;;\n  esac\n  exit 0\nfi\nexit 1\n",
    "utf-8",
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  chdir(root);

  writeState(baseState());
  const result = checkCi(root, 123);

  if (!result.noChecks || result.allGreen) {
    throw new Error(`no checks should fail closed, got ${JSON.stringify(result)}`);
  }
  if (readState().phase !== "commit") {
    throw new Error("no checks must preserve commit phase");
  }

  process.env.HY_TEST_CI_RESULT = "neutral";
  writeState(baseState());
  const neutral = checkCi(root, 123);
  if (!neutral.noEffectiveChecks || neutral.allGreen) {
    throw new Error(`only skipped/neutral checks should fail closed, got ${JSON.stringify(neutral)}`);
  }

  process.env.HY_TEST_CI_RESULT = "unrelated";
  writeState(baseState());
  const unrelated = checkCi(root, 123);
  if (!unrelated.noEffectiveChecks || !unrelated.requiredCheckMissing || unrelated.allGreen) {
    throw new Error(`unrelated green checks without Verify must fail closed, got ${JSON.stringify(unrelated)}`);
  }

  process.env.HY_TEST_CI_RESULT = "spoof";
  writeState(baseState());
  const spoof = checkCi(root, 123);
  if (!spoof.requiredCheckMissing || spoof.allGreen) {
    throw new Error(`third-party green named Verify must not substitute for the real workflow: ${JSON.stringify(spoof)}`);
  }

  const verifyRed = classifyVerifyChecks([
    ciCheck("Verify", "FAILURE", true, "hy-workflow"),
    ciCheck("build", "SUCCESS"),
  ]);
  if (verifyRed.effective.length !== 1 || verifyRed.rollupEffective.length !== 2 || verifyRed.allGreen) {
    throw new Error(`Verify red plus unrelated green must remain red: ${JSON.stringify(verifyRed)}`);
  }
  const unrelatedRed = classifyVerifyChecks([
    ciCheck("Verify", "SUCCESS", true, "hy-workflow"),
    ciCheck("build", "FAILURE"),
  ]);
  if (unrelatedRed.effective.length !== 1 || unrelatedRed.rollupEffective.length !== 2 || unrelatedRed.allGreen) {
    throw new Error(`Verify green plus another effective red check must remain red: ${JSON.stringify(unrelatedRed)}`);
  }
  const allGreen = classifyVerifyChecks([
    ciCheck("Verify", "SUCCESS", true, "hy-workflow"),
    ciCheck("build", "SUCCESS"),
    ciCheck("advisory", "NEUTRAL"),
  ]);
  if (!allGreen.allGreen || allGreen.effective.length !== 1 || allGreen.rollupEffective.length !== 2) {
    throw new Error(`Verify and all other effective checks green must pass: ${JSON.stringify(allGreen)}`);
  }
  const foreignWorkflow = classifyVerifyChecks([ciCheck("Verify", "SUCCESS", false, "foreign")]);
  if (foreignWorkflow.required.length || foreignWorkflow.allGreen) throw new Error("foreign workflow Verify must not satisfy the required check");
  const duplicate = classifyVerifyChecks([
    ciCheck("Verify", "SUCCESS", true, "hy-workflow"),
    ciCheck("Verify", "SUCCESS", true, "hy-workflow"),
  ]);
  if (duplicate.required.length !== 2 || duplicate.allGreen) throw new Error("duplicate provenance-verified Verify checks must fail closed");
  if (!isVerifyCheckIdentity("Verify") || isVerifyCheckIdentity("hy-workflow / Verify") || isVerifyCheckIdentity("Verify docs") || isVerifyCheckIdentity("other / Verify")) {
    throw new Error("Verify check identity matching is not stable or is too broad");
  }

  delete process.env.HY_TEST_CI_RESULT;
  const sentinel = join(root, "ci-injection-sentinel");
  writeFileSync(statePath(), JSON.stringify({ ...baseState(), phase: "commit", prNumber: `123;touch${"${IFS}"}${sentinel}` }, null, 2) + "\n", "utf-8");
  try {
    readState();
    throw new Error("invalid prNumber should fail state read");
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
