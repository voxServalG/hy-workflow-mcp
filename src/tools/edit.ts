import { approvalMatchesPlan, readState, writeState, transition, assertPhase, scopePath } from "../state.js";
import { invalidWorkflowStateResult, toolResult, type ToolResult } from "./_base.js";
import * as fs from "node:fs";
import * as path from "node:path";

// hy_edit doesn't advance phase — it just validates the scope.
// The LLM uses standard Read/Edit/Write tools for actual editing.
// This tool locks scope and returns context.

export async function handleEdit(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "branch", "edit", "verify"); // can re-enter from verify (fix cycle)

  if (!state.plan) {
    return invalidWorkflowStateResult(
      state,
      "EDIT_PLAN_MISSING",
      "Workflow state reached edit without an active PlanDoc.",
      "Reset the impossible workflow state, then create and approve a new PlanDoc.",
    );
  }
  if (!approvalMatchesPlan(state.approval, state.plan)) {
    return invalidWorkflowStateResult(
      state,
      "EDIT_APPROVAL_PLAN_MISMATCH",
      "Workflow state cannot lock edit scope without an approval bound to the active PlanDoc.",
      "Reset the invalid workflow state before creating a new approved PlanDoc.",
    );
  }
  if (!state.branch) {
    if (state.phase === "branch") {
      const stage = state.stage ?? "branch.create";
      return toolResult(state.phase, {
        phase: state.phase,
        stage,
        error: "Create the approved workflow branch before locking edit scope.",
        hint: "Call hy_branch with a safe category and topic, then continue automatically to hy_edit.",
        allowedTools: ["hy_branch", "hy_status"],
        nextAction: { tool: null, phase: state.phase, stage, automatic: false },
        control: { automatic: false, stop: true, reason: "information_required" },
        userAction: null,
      });
    }
    return invalidWorkflowStateResult(
      state,
      "EDIT_BRANCH_MISSING",
      "Workflow state reached edit without an active workflow branch.",
      "Reset the impossible workflow state before starting a new approved task.",
    );
  }

  // Lock scope in git-private storage so workflow metadata stays out of the worktree.
  const scopeJson = {
    task: state.plan.task,
    scope: state.plan.scope,
    boundary: state.plan.boundary,
    rubrics: state.plan.verify,
    branch: state.branch,
  };
  const target = scopePath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(scopeJson, null, 2) + "\n", "utf-8");

  // Transition to edit if coming from branch or verify
  const next = state.phase === "edit" ? { ...state } : transition(state, "edit");
  next.stage = "edit.implementation";
  writeState(next);

  return toolResult("edit", {
    phase: "edit",
    stage: "edit.implementation",
    status: "ready",
    branch: state.branch,
    scope: state.plan.scope,
    boundary: state.plan.boundary,
    display: {
      title: "Scope locked",
      body: `Edit only files declared in plan.scope, then run hy_read_docs(after_edit).`,
    },
    hint: "Use standard file editing tools only within plan.scope. When implementation edits are complete, run hy_read_docs with stage after_edit, then hy_sync_docs, then hy_verify.",
    allowedTools: ["hy_read_docs", "hy_edit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    nextAction: { tool: null, phase: "edit", stage: "edit.implementation", automatic: false },
    control: { automatic: false, stop: true, reason: "external_action_required" },
    userAction: null,
    message: `Scope locked. Edit files within plan.scope: ${state.plan.scope.changes.join(", ")}. When done, run hy_read_docs(after_edit), then hy_sync_docs, then hy_verify.`,
  });
}
