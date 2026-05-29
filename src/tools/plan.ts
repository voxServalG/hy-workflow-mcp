import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";
import { execSync } from "node:child_process";

export async function handlePlan(args: { task: string; plan: PlanDoc }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "plan");

  // Run garden-scan to get baseline
  let baseline = {};
  try {
    const raw = execSync("npx --yes docs-gardener garden-scan 2>/dev/null || echo '{}'", {
      encoding: "utf-8", timeout: 30_000, stdio: ["pipe","pipe","pipe"]
    });
    baseline = JSON.parse(raw || "{}");
  } catch {}

  // Validate plan doc has required fields
  const p = args.plan;
  if (!p.task || !p.scope || !p.boundary || !p.verify) {
    return { next: "plan", error: "PlanDoc must include: task, scope, boundary, verify {platform, smoke, tests}" };
  }

  if (!p.verify.smoke || !p.verify.tests || !p.verify.platform) {
    return { next: "plan", error: "verify must include: platform, smoke (≥1 check), tests" };
  }

  const next = transition(state, "plan"); // stays in plan until approve
  next.phase = "plan";
  next.plan = p;
  writeState(next);

  return {
    next: "approve",
    baseline,
    plan: p,
    message: "Plan written. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
  };
}
