import { readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { createBranch } from "../git.js";
import type { ToolResult } from "./_base.js";

export async function handleBranch(args: { category: string; topic: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "approve", "branch");

  if (!state.plan) return { next: "branch", error: "No plan found. Run hy_plan first." };

  const validCategories = ["refactor", "feat", "chore", "docs", "ci", "fix", "test"];
  if (!validCategories.includes(args.category)) {
    return { next: "branch", error: `Invalid category. Use: ${validCategories.join(", ")}` };
  }

  const root = projectRoot();
  const result = createBranch(root, args.category, args.topic);
  if (!result.ok) return { next: "branch", error: result.error };

  const next = transition(state, "edit");
  next.branch = result.branch;
  next.plan!.branch = result.branch;
  writeState(next);

  return { next: "edit", branch: result.branch };
}
