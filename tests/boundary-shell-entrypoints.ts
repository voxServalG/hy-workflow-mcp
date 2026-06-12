import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runBoundaryCheck } from "../src/checks.js";
import type { PlanDoc } from "../src/state.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "hy-boundary-shell-"));
execSync("git init -q", { cwd: root });
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "app.py"), "print('ok')\n", "utf-8");
writeFileSync(join(root, "codelint.json"), JSON.stringify({ codeExt: ".py", baseBranch: "main" }, null, 2) + "\n", "utf-8");

const plan: PlanDoc = {
  task: "boundary shell regression",
  scope: { changes: ["src/app.py"], new_files: [], delete: [] },
  boundary: {
    dependency_dag: "test only",
    entry_points: ["python -m compileall -q src"],
    no_new_external: false,
  },
  verify: { platform: { python_version: "3.11", setup: [] }, smoke: [], tests: [] },
  risks: ["test risk"],
  discussion: "test discussion",
  branch: null,
  verify_hash: null,
  pr_number: null,
};

const results = runBoundaryCheck(root, plan);
assert(results.length === 1, "expected one boundary entry result");
assert(results[0].passed, `shell entry point should pass in Python project: ${results[0].detail}`);

plan.boundary.entry_points = ["raise SystemExit(0)"];
const invalid = runBoundaryCheck(root, plan)[0];
assert(!invalid.passed, "Python snippet should not be auto-wrapped as python -c");
