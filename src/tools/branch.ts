import { readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { createBranch } from "../git.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleBranch(args: { category: string; topic: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "approve", "branch");

  if (!state.plan) return toolResult("branch", { error: "No plan found. Run hy_plan first.", allowedTools: ["hy_status"] });

  const validCategories = ["refactor", "feat", "chore", "docs", "ci", "fix", "test"];
  if (!validCategories.includes(args.category)) {
    return toolResult("branch", { error: `Invalid category. Use: ${validCategories.join(", ")}`, allowedTools: ["hy_branch", "hy_status"] });
  }

  const root = projectRoot();
  const result = createBranch(root, args.category, args.topic);
  if (!result.ok) {
    return toolResult("branch", {
      error: result.error,
      display: {
        title: "Branch creation failed",
        body: result.error?.message ?? "Could not create the requested branch.",
      },
      hint: result.error?.hint ?? "Fix the git branch setup issue, then retry hy_branch.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_branch", "hy_status"],
      blockedTools: ["hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
      recovery: { instruction: result.error?.hint ?? "Fix the git branch setup issue, then retry hy_branch." },
    });
  }

  const next = transition(state, "edit");
  next.branch = result.branch;
  next.plan!.branch = result.branch;
  writeState(next);

  return toolResult("edit", {
    branch: result.branch,
    message: `Branch ${result.branch} created. Call hy_edit to lock scope.`,
    hint: "Call hy_edit next to lock scope before editing files.",
    allowedTools: ["hy_edit", "hy_status"],
    blockedTools: ["hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
  });
}
