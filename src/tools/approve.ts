import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { Approval } from "../state.js";

export async function handleApprove(args: { approved: string; note?: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "plan", "approve");

  const input = (args.approved ?? "").trim();

  if (input === "approve") {
    const approval: Approval = {
      time: new Date().toISOString(),
      note: args.note ?? "",
    };
    const next = transition(state, "branch");
    next.approval = approval;
    writeState(next);
    return {
      next: "branch",
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
    };
  }

  // Any input other than "approve" = rejection, content is the reason
  const next = transition(state, "plan");
  next.approval = { time: new Date().toISOString(), note: input || args.note || "rejected" };
  writeState(next);
  return { next: "plan", approved: false, note: input, message: "Plan rejected. Revise the task description and call hy_plan again." };
}
