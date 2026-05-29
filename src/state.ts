import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export type Phase =
  | "init"
  | "plan"
  | "approve"
  | "branch"
  | "edit"
  | "verify"
  | "commit"
  | "ci"
  | "merge"
  | "chain"
  | "done";

export interface CheckItem {
  command: string;
  expected_exit: number;
  description: string;
}

export interface PlanDoc {
  task: string;

  scope: {
    changes: string[];
    new_files: string[];
    delete: string[];
  };

  boundary: {
    dependency_dag: string;
    entry_points: string[];
    no_new_external: boolean;
  };

  verify: {
    platform: {
      python_version: string;
      setup: string[];
    };
    smoke: CheckItem[];
    tests: CheckItem[];
  };

  risks: string[];
  discussion: string;

  // runtime
  branch: string | null;
  verify_hash: string | null;
  pr_number: number | null;
}

export interface Approval {
  time: string;
  note: string;
}

export interface WorkflowState {
  version: "1";
  phase: Phase;
  branch: string | null;
  prNumber: number | null;
  plan: PlanDoc | null;
  approval: Approval | null;
  verifyHash: string | null;
}

// ── State path ───────────────────────────────────────────────

const STATE_DIR = ".hy";
const STATE_FILE = path.join(STATE_DIR, "workflow.json");

export function statePath(): string {
  return path.join(projectRoot(), STATE_FILE);
}

export function projectRoot(): string {
  let dir = process.cwd();
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ── Read / Write ─────────────────────────────────────────────

export function readState(): WorkflowState {
  const p = statePath();
  if (!fs.existsSync(p)) {
    return {
      version: "1",
      phase: "init",
      branch: null,
      prNumber: null,
      plan: null,
      approval: null,
      verifyHash: null,
    };
  }
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw) as WorkflowState;
}

export function writeState(state: WorkflowState): void {
  const dir = path.join(projectRoot(), STATE_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ── Phase transitions ────────────────────────────────────────

const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  init: ["init", "plan", "done"],
  plan: ["plan", "approve", "done"],
  approve: ["approve", "branch", "plan"], // plan = retry after reject
  branch: ["branch", "edit", "done"],
  edit: ["edit", "verify", "done"],
  verify: ["verify", "edit", "commit", "done"], // edit = fix, commit = pass
  commit: ["commit", "ci", "done"],
  ci: ["ci", "edit", "merge", "done"], // edit = fix, merge = pass
  merge: ["merge", "chain", "done"],
  chain: ["chain", "done"],
  done: ["done"],
};

export function assertPhase(state: WorkflowState, ...expected: Phase[]): void {
  if (!expected.includes(state.phase)) {
    throw new StateError(
      `Phase "${state.phase}" is not in [${expected.join(", ")}]. ` +
      `You may need to call a prior tool first. Current valid transitions: ` +
      `${VALID_TRANSITIONS[state.phase]?.join(" → ") ?? "none"}.`
    );
  }
}

export function transition(state: WorkflowState, to: Phase): WorkflowState {
  const allowed = VALID_TRANSITIONS[state.phase];
  if (!allowed?.includes(to)) {
    throw new StateError(
      `Cannot transition from "${state.phase}" to "${to}". ` +
      `Allowed transitions from "${state.phase}": ${allowed?.join(", ") ?? "none"}.`
    );
  }
  return { ...state, phase: to };
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

// ── Hash ─────────────────────────────────────────────────────

export function computeVerifyHash(state: WorkflowState): string {
  const payload = JSON.stringify({
    plan: state.plan?.task,
    scope: state.plan?.scope,
    boundary: state.plan?.boundary,
    rubrics: state.plan?.verify,
  });
  const hash = createHash("sha256");
  hash.update(payload);
  return hash.digest("hex").slice(0, 12);
}

// ── Branch name ──────────────────────────────────────────────

export function currentBranch(root: string): string {
  try {
    return execSync("git branch --show-current", { cwd: root })
      .toString().trim();
  } catch {
    return "unknown";
  }
}
