import { readState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

export async function handleStatus(): Promise<ToolResult> {
  const state = readState();

  const r: ToolResult & Record<string, any> = toolResult(state.phase, {
    phase: state.phase,
    branch: state.branch,
    prNumber: state.prNumber,
    plan: state.plan?.task ?? null,
    approved: state.approval !== null,
    verified: state.verifyHash !== null,
    hint: "Use phase, next, allowedTools, and action to decide the next safe tool call.",
    allowedTools: [state.phase === "done" ? "hy_status" : `hy_${state.phase}`, "hy_status"],
  });

  if (!state.plan) {
    r.action = {
      command: "hy_plan",
      when: "用户意图涉及开发任务时",
      triggerWords: ["计划一下", "plan it", "做个计划", "plan", "做计划", "plan this"],
    };
  }

  return r;
}
