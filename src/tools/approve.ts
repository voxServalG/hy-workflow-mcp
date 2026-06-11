import { readState, writeState, transition, assertPhase } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import type { Approval } from "../state.js";

export async function handleApprove(args: { approved: string; note?: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "approve");

  const input = (args.approved ?? "").trim();

  if (input === "approve" || input === "true") {
    const approval: Approval = {
      time: new Date().toISOString(),
      note: args.note ?? "",
    };
    const next = transition(state, "branch");
    next.approval = approval;
    writeState(next);
    return toolResult("branch", {
      approved: true,
      plan: state.plan?.task,
      pipeline: [
        { step: "hy_branch",  description: "create branch" },
        { step: "hy_edit",    description: "lock scope" },
        { step: "edit files", description: "write code" },
        { step: "hy_verify",  description: "run lint + compile + scope + boundary + tests" },
        { step: "hy_commit",  description: "create PR" },
      ],
      stopAfter: "hy_commit",
      resumeAfter: "hy_commit 完成后任务结束。用户需要时手动调用 hy_ci → hy_merge → hy_chain。",
      hint: "Proceed through the returned pipeline in order until stopAfter. Do not skip hy_verify before hy_commit.",
      allowedTools: ["hy_branch", "hy_status"],
      blockedTools: ["hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
      recovery: {
        tool: "hy_branch",
        instruction: "Create a branch next, then lock scope with hy_edit before editing files.",
      },
    });
  }

  // Any input other than "approve" = rejection, content is the reason
  const next = transition(state, "plan");
  next.approval = { time: new Date().toISOString(), note: input || args.note || "rejected" };
  writeState(next);
  return toolResult("plan", {
    approved: false,
    note: input,
    message: "Plan rejected. Revise the task description and call hy_plan again.",
    hint: "Do not continue the prior pipeline. Revise the PlanDoc and call hy_plan again only if the user wants to proceed.",
    allowedTools: ["hy_plan", "hy_status"],
    blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
  });
}
