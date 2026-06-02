import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { projectRoot } from "../state.js";

// hy_edit doesn't advance phase — it just validates the scope.
// The LLM uses standard Read/Edit/Write tools for actual editing.
// This tool locks scope and returns context.

export async function handleEdit(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "branch", "edit", "verify"); // can re-enter from verify (fix cycle)

  if (!state.plan) return { next: "edit", error: "No plan" };

  // Ensure hy/workflow directory exists
  const root = projectRoot();
  const hyDir = path.join(root, ".hy");
  if (!fs.existsSync(hyDir)) fs.mkdirSync(hyDir, { recursive: true });

  // Lock scope: write a .hy/scope.json for the LLM to reference
  const scopeJson = {
    task: state.plan.task,
    scope: state.plan.scope,
    boundary: state.plan.boundary,
    rubrics: state.plan.verify,
    branch: state.branch,
  };
  fs.writeFileSync(path.join(hyDir, "scope.json"), JSON.stringify(scopeJson, null, 2));

  // Transition to edit if coming from branch or verify
  if (state.phase === "branch" || state.phase === "verify") {
    const next = transition(state, "edit");
    writeState(next);
  }

  return {
    next: "verify",
    branch: state.branch,
    scope: state.plan.scope,
    boundary: state.plan.boundary,
    message: `Scope locked. Edit files within plan.scope: ${state.plan.scope.changes.join(", ")}. When done, run hy_verify.`,
  };
}
