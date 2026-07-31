import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { execFileSync } from "node:child_process";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { issueExam, submitExam, computeScopeFingerprint } from "../../src/verify-exam.js";
import { readState, writeState } from "../../src/state.js";
import { handleExamSubmit } from "../../src/tools/exam-submit.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;

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
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "." },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
    ci: { commands: ["npm test"] },
  }, null, 2) + "\n");
  execFileSync("git", ["add", "README.md", "hy-workflow.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });

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
  assert(!exam.checks.some(c => c.id.startsWith("compile:python")), "TypeScript-only config must not receive a Python compile check");
  assert(!exam.checks.some(c => c.command.includes("compileall")), "compile checks must never synthesize compileall from plan entry points");

  // Submit passing results for the TS exam BEFORE any source change
  const results = exam.checks.map(c => ({
    id: c.id,
    command: c.command,
    nonce: c.nonce,
    exitCode: c.expectExitCode ?? 0,
    durationMs: 10,
    stdoutTail: "",
  }));

  const handled = await handleExamSubmit({ examId: exam.examId, results });
  assert(handled.ok === true, `exam should pass: ${JSON.stringify(handled)}`);
  const persisted = readState();
  assert(persisted.phase === "commit", "passing exam should advance to commit");
  assert(Boolean(persisted.implementationManifest), "passed exam should persist implementation manifest");
  assert(persisted.verifiedImplementationDigest && persisted.verifiedImplementationDigest.length === 12, "implementation digest should be 12-char hex");
  const outcome = { implementationManifest: persisted.implementationManifest, verifiedImplementationDigest: persisted.verifiedImplementationDigest };

  // Now reconfigure for Python in a separate working tree state
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "sample.py"), "value = 1\n");
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: [".py"], codeDirs: ["src"], docsDir: "." },
    codelint: { lintDirs: ["src"], maxLines: 500 }, doclint: { maxLines: 200 }, docsGardener: { catalogs: {} }, ci: { commands: ["npm test"] },
  }, null, 2) + "\n");
  const pythonExam = issueExam(root, plan);
  const pythonCheck = pythonExam.checks.find(c => c.id.startsWith("compile:python"));
  assert(Boolean(pythonCheck), "Python config with a source file must receive a Python compile check");
  assert(pythonCheck!.command.includes('-m py_compile "src/sample.py"'), `unexpected Python compile command: ${pythonCheck!.command}`);
  assert(!pythonCheck!.command.includes("compileall"), "Python exam must use the same py_compile mode as synchronous verify");
  // Restore TS config to keep the repo clean
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "." },
    codelint: { lintDirs: ["src"], maxLines: 500 }, doclint: { maxLines: 200 }, docsGardener: { catalogs: {} }, ci: { commands: ["npm test"] },
  }, null, 2) + "\n");
  rmSync(join(root, "src"), { recursive: true, force: true });

  // Reset phase back to edit for failure-path tests
  writeState({ ...readState(), phase: "edit", verifiedImplementationDigest: null, implementationManifest: null });

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
