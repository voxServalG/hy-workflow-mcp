import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { execFileSync } from "node:child_process";
import { issueExam, submitExam, computeScopeFingerprint } from "../../src/verify-exam.js";
import { readState, writeState } from "../../src/state.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-exam-"));
process.env.HY_WORKFLOW_STATE_HOME = join(root, ".local/state");
process.env.HY_WORKFLOW_CONFIG_HOME = join(root, ".config");
process.env.HY_WORKFLOW_CACHE_HOME = join(root, ".cache");
mkdirSync(join(root, ".local/state/hy-workflow/projects"), { recursive: true });

try {
  chdir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

  // Seed a minimal plan in state
  const plan = {
    task: "test",
    scope: { changes: ["README.md"], new_files: [], delete: [] },
    boundary: { dependency_dag: "x", entry_points: [], no_new_external: true },
    verify: {
      platform: { python_version: "n/a", setup: [] },
      smoke: [{ command: "true", expected_exit: 0, description: "noop smoke" }],
      tests: [{ command: "echo tests-passed", expected_exit: 0, description: "noop tests" }],
    },
  } as any;
  const state: any = {
    phase: "edit",
    plan,
    branch: "fix/test",
    approval: { approved: true, note: "", approvedAt: new Date().toISOString() },
    implementationManifest: { modified: [], added: [], deleted: [], untracked: [], changed: [] },
  };
  writeState(state);

  const fingerprint = computeScopeFingerprint(root);
  assert(fingerprint.length > 0, "fingerprint should be a non-empty hash");

  // Issue exam
  const exam = issueExam(root, plan);
  assert(exam.checks.length >= 2, `expected at least 2 checks, got ${exam.checks.length}`);
  assert(exam.scopeFingerprint === fingerprint, "exam fingerprint should match current tree");
  assert(/^\d{4}-\d{2}-\d{2}/.test(exam.issuedAt), "issuedAt should be ISO");
  assert(exam.checks.every(c => c.nonce && c.command && c.timeoutMs > 0), "every check has nonce/command/timeout");

  // Build results where all pass
  const results = exam.checks.map(c => ({
    id: c.id,
    command: c.command,
    nonce: c.nonce,
    exitCode: c.expectExitCode ?? 0,
    durationMs: 10,
    stdoutTail: "",
  }));

  const outcome = submitExam(root, readState(), exam.examId, results);
  assert(outcome.passed === true, `exam should pass: ${JSON.stringify(outcome.failedChecks)}`);
  assert(outcome.verifyHash && outcome.verifyHash.length === 12, "verifyHash should be 12-char hex");

  // Nonce mismatch
  const bad = [{ ...results[0], nonce: "wrong-nonce" }];
  // Only submit 1 result for partial (must fail since others missing)
  const badOutcome = submitExam(root, readState(), exam.examId, bad);
  assert(badOutcome.passed === false, "nonce mismatch should fail");
  assert(badOutcome.failedChecks!.some(f => f.reason === "nonce_mismatch" || f.reason === "missing_result"), "expected nonce/missing failure");

  // Tamper with command
  const tampered = exam.checks.map(c => ({
    id: c.id,
    command: c.command + " | true",
    nonce: c.nonce,
    exitCode: 0,
  }));
  const tamperedOutcome = submitExam(root, readState(), exam.examId, tampered);
  assert(tamperedOutcome.passed === false, "tampered command should fail");
  assert(tamperedOutcome.failedChecks!.some(f => f.reason === "command_mismatch"), "expected command_mismatch failure");

  // Unknown exam id
  const unknownOutcome = submitExam(root, readState(), "deadbeef".repeat(4), results);
  assert(unknownOutcome.passed === false, "unknown exam id should fail");

  console.log("verify-exam: issue, submit, nonce, command mismatch, unknown id all pass");
} finally {
  chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
