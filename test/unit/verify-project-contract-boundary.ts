import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllChecksAsync } from "../../src/checks-async.js";
import type { PlanDoc, WorkflowState } from "../../src/state.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "hy-python-project-verify-"));
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "src", "app.py"), "VALUE = 1\n");
writeFileSync(join(root, "docs", "index.md"), "# Python consumer\n");
writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
  project: {
    baseBranch: "main",
    codeExt: ".py",
    codeDirs: ["src"],
    docsDir: "docs",
  },
  codelint: {
    lintDirs: ["src"],
    maxLines: 500,
  },
}, null, 2) + "\n");

git(root, "init", "-b", "main");
git(root, "config", "user.email", "test@example.com");
git(root, "config", "user.name", "Test");
git(root, "add", ".");
git(root, "commit", "-m", "initial");
git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
git(root, "checkout", "-b", "fix/python-project-verify");
writeFileSync(join(root, "src", "app.py"), "VALUE = 2\n");

const command = "python3 -c \"import pathlib; compile(pathlib.Path('src/app.py').read_text(), 'src/app.py', 'exec')\"";
const plan: PlanDoc = {
  task: "verify a Python consumer without applying hy-workflow-mcp product contracts",
  scope: {
    changes: ["src/app.py"],
    new_files: [],
    delete: [],
  },
  boundary: {
    dependency_dag: "src/app.py is the only changed consumer module.",
    entry_points: [command],
    no_new_external: true,
  },
  verify: {
    platform: {
      python_version: "N/A",
      setup: [],
    },
    smoke: [{
      command,
      expected_exit: 0,
      description: "Python consumer source compiles.",
    }],
    tests: [{
      command,
      expected_exit: 0,
      description: "Python consumer verification command passes.",
    }],
  },
  risks: [
    "Scenario: product-only contract lint leaks into a consumer project; impact: valid Python verification fails; mitigation: exercise the real asynchronous verifier.",
  ],
  discussion: "Use a real temporary Git repository because compile, scope, and boundary behavior are part of the regression.",
  branch: "fix/python-project-verify",
  verify_hash: null,
  pr_number: null,
};
const state: WorkflowState = {
  version: "1",
  phase: "verify",
  branch: "fix/python-project-verify",
  prNumber: null,
  plan,
  approval: {
    time: new Date().toISOString(),
    note: "test",
  },
  verifyHash: null,
};

const report = await runAllChecksAsync(root, state);
assert(
  !report.checks.some(check => check.name === "workflow-contract"),
  `consumer verification must not run the product workflow contract: ${JSON.stringify(report)}`,
);
assert(report.allPassed, `Python consumer verification should pass: ${JSON.stringify(report)}`);

console.log("verify-project-contract-boundary: Python consumer stays outside product-only contract lint");
