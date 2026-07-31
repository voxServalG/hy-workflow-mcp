import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { execFileSync } from "node:child_process";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { issueExam, submitExam, computeScopeFingerprint } from "../../src/verify-exam.js";
import { computePlanHash, createPlanApproval, readState, writeState } from "../../src/state.js";
import { handleExamSubmit } from "../../src/tools/exam-submit.js";
import { handleExamPlan } from "../../src/tools/exam-plan.js";
import { buildImplementationManifest } from "../../src/checks.js";
import { implementationDigest } from "../../src/tools/sync_docs.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-exam-"));
const runtimeRoot = useRuntimeHome("hy-exam-runtime-");

try {
  chdir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# test\n");
  const tsConfig = JSON.stringify({
    project: { baseBranch: "main", codeExt: [".ts"], codeDirs: ["src"], docsDir: "." },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
    ci: { commands: ["npm test"] },
  }, null, 2) + "\n";
  writeFileSync(join(root, "hy-workflow.json"), tsConfig);
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
  writeFileSync(join(root, "README.md"), "# test\n\nverified change\n");
  const planHash = computePlanHash(plan)!;
  const implementationManifest = buildImplementationManifest(root);
  const currentImplementationDigest = implementationDigest(root, plan, implementationManifest);
  const auditDigest = "exam-after-edit";
  const state: any = {
    version: "1",
    phase: "edit",
    plan,
    branch: "fix/test",
    approval: createPlanApproval(plan, "approved for exam"),
    implementationManifest,
    documentReads: {
      afterEdit: {
        stage: "after_edit",
        purpose: "test exam preflight",
        time: new Date().toISOString(),
        task: plan.task,
        planHash,
        docsDir: ".",
        digest: auditDigest,
        files: [],
        findings: [],
        implementationFiles: [],
        implementationDigest: currentImplementationDigest,
      },
    },
    syncDocs: {
      time: new Date().toISOString(),
      planHash,
      afterEditDigest: auditDigest,
      implementationDigest: currentImplementationDigest,
      allowedDocs: ["README.md"],
    },
  };
  writeState(state);

  writeState({ ...readState(), approval: null });
  const missingApprovalPlan = await handleExamPlan();
  assert(missingApprovalPlan.error?.code === "EXAM_APPROVAL_PLAN_MISMATCH", `exam issue must not bypass a missing approval: ${JSON.stringify(missingApprovalPlan)}`);
  const missingApprovalSubmit = await handleExamSubmit({ examId: "deadbeef".repeat(4), results: [] });
  assert(missingApprovalSubmit.error?.code === "EXAM_APPROVAL_PLAN_MISMATCH", `exam submit must not bypass a missing approval: ${JSON.stringify(missingApprovalSubmit)}`);
  writeState(state);

  const fingerprint = computeScopeFingerprint(root);
  assert(fingerprint.length > 0, "fingerprint should be a non-empty hash");

  // Issue exam
  const exam = issueExam(root, plan);
  assert(exam.checks.length >= 2, `expected at least 2 checks, got ${exam.checks.length}`);
  assert(exam.scopeFingerprint === fingerprint, "exam fingerprint should match current tree");
  assert(exam.planHash === planHash, "exam must bind the exact PlanDoc hash");
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

  const repeatedOutcome = submitExam(root, readState(), exam.examId, results);
  assert(
    repeatedOutcome.passed === false && repeatedOutcome.failedChecks!.some(f => f.reason === "exam_already_submitted"),
    "an exam must be consumed by its first submission, even when that submission passed",
  );

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
  writeFileSync(join(root, "hy-workflow.json"), tsConfig);
  rmSync(join(root, "src"), { recursive: true, force: true });

  // Reset phase back to edit for failure-path tests
  writeState({ ...readState(), phase: "edit", verifiedImplementationDigest: null, implementationManifest: null });

  // Nonce mismatch
  const badExam = issueExam(root, plan);
  const bad = badExam.checks.map(c => ({
    id: c.id,
    command: c.command,
    nonce: c.nonce,
    exitCode: c.expectExitCode ?? 0,
  }));
  bad[0] = { ...bad[0], nonce: "wrong-nonce" };
  const badOutcome = submitExam(root, readState(), badExam.examId, bad);
  assert(badOutcome.passed === false, "nonce mismatch should fail");
  assert(badOutcome.failedChecks!.some(f => f.reason === "nonce_mismatch"), "expected nonce mismatch failure");

  // Tamper with command
  const tamperedExam = issueExam(root, plan);
  const tampered = tamperedExam.checks.map(c => ({
    id: c.id,
    command: c.command + " | true",
    nonce: c.nonce,
    exitCode: 0,
  }));
  const tamperedOutcome = submitExam(root, readState(), tamperedExam.examId, tampered);
  assert(tamperedOutcome.passed === false, "tampered command should fail");
  assert(tamperedOutcome.failedChecks!.some(f => f.reason === "command_mismatch"), "expected command_mismatch failure");

  // Unknown exam id
  const unknownOutcome = submitExam(root, readState(), "deadbeef".repeat(4), results);
  assert(unknownOutcome.passed === false, "unknown exam id should fail");

  const staleExam = issueExam(root, plan);
  const staleResults = staleExam.checks.map(c => ({
    id: c.id,
    command: c.command,
    nonce: c.nonce,
    exitCode: c.expectExitCode,
  }));
  writeFileSync(join(root, "README.md"), "# test\n\nchanged after exam issue\n");
  const staleOutcome = submitExam(root, readState(), staleExam.examId, staleResults);
  assert(staleOutcome.passed === false && staleOutcome.failedChecks!.some(f => f.reason === "source_changed"), "exam results must be rejected when any tracked or untracked implementation content changes");

  console.log("verify-exam: approval, one-shot submit, worktree binding, nonce, command mismatch, and unknown id all pass");
} finally {
  chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeRoot, { recursive: true, force: true });
}
