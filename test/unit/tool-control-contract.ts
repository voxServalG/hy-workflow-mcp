import { toolResult } from "../../src/output/envelope.js";
import {
  WORKFLOW_STAGES,
  canonicalWorkflowStage,
  workflowStageMatchesPhase,
  workflowStagePhase,
} from "../../src/runtime/state-machine.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const automatic = toolResult("verify", {
  phase: "edit",
  allowedTools: ["hy_read_docs", "hy_status"],
  nextAction: {
    tool: "hy_read_docs",
    arguments: { stage: "after_edit" },
    phase: "edit",
    stage: "edit.after_edit",
    automatic: true,
  },
});
assert(automatic.next === "verify", "legacy next should remain the requested next phase");
assert(automatic.phase === "edit", "phase should be the persisted workflow state");
assert(automatic.stage === "edit.implementation", "stage should describe progress inside phase");
assert(automatic.nextAction.tool === "hy_read_docs", "nextAction should name the concrete tool");
assert(automatic.control.automatic && !automatic.control.stop, "ordinary continuation should be automatic");
assert(automatic.userAction === null, "ordinary continuation should not invent human action");

const statusFallback = toolResult("verify", {
  phase: "edit",
  allowedTools: ["hy_status"],
});
assert(statusFallback.nextAction.tool === "hy_status", "normalization must not invent a phase-named tool");

const noRoute = toolResult("plan", {});
assert(noRoute.nextAction.tool === null && noRoute.control.stop && !noRoute.control.automatic, "a result without an executable route must stop instead of inventing automation");

function expectRouteFailure(name: string, build: () => unknown, message: string): void {
  try {
    build();
    throw new Error(`${name} should fail closed`);
  } catch (error) {
    assert(error instanceof TypeError && error.message.includes(message), `${name} should report ${message}: ${String(error)}`);
  }
}

expectRouteFailure("tool outside allowedTools", () => toolResult("verify", {
  phase: "edit",
  allowedTools: ["hy_status"],
  nextAction: { tool: "hy_verify", phase: "verify", stage: "verify.run", automatic: true },
}), "not present in allowedTools");

expectRouteFailure("stage outside target phase", () => toolResult("verify", {
  phase: "edit",
  allowedTools: ["hy_verify"],
  nextAction: { tool: "hy_verify", phase: "verify", stage: "commit.ci" as any, automatic: true },
}), "does not belong to verify");

expectRouteFailure("unreachable target phase", () => toolResult("merge", {
  phase: "plan",
  allowedTools: ["hy_merge"],
  nextAction: { tool: "hy_merge", phase: "merge", stage: "merge.reconcile", automatic: true },
}), "is not reachable from plan");

expectRouteFailure("before_plan without task", () => toolResult("plan", {
  phase: "plan",
  stage: "plan.before_plan",
  allowedTools: ["hy_read_docs"],
  nextAction: {
    tool: "hy_read_docs",
    arguments: { stage: "before_plan" },
    phase: "plan",
    stage: "plan.before_plan",
    automatic: true,
  },
}), "requires a non-empty arguments.task");

expectRouteFailure("read-doc selector route mismatch", () => toolResult("approve", {
  phase: "plan",
  allowedTools: ["hy_read_docs"],
  nextAction: {
    tool: "hy_read_docs",
    arguments: { stage: "after_edit" },
    phase: "approve",
    stage: "approve.before_approve",
    automatic: true,
  },
}), "must target edit/edit.after_edit");

expectRouteFailure("automatic control mismatch", () => toolResult("verify", {
  phase: "edit",
  allowedTools: ["hy_verify"],
  nextAction: { tool: "hy_verify", phase: "verify", stage: "verify.run", automatic: false },
}), "must equal control.automatic");

for (const [name, tool, phase, stage] of [
  ["plan", "hy_plan", "plan", "plan.compose"],
  ["approval", "hy_approve", "approve", "approve.decision"],
  ["branch", "hy_branch", "branch", "branch.create"],
  ["amendment", "hy_amend_plan", "verify", "verify.amendment"],
  ["exam submit", "hy_exam_submit", "verify", "verify.run"],
  ["commit", "hy_commit", "commit", "commit.prepare"],
] as const) {
  expectRouteFailure(`${name} without arguments`, () => toolResult(phase, {
    phase,
    allowedTools: [tool],
    nextAction: { tool, phase, stage, automatic: true },
  }), "requires an arguments object");
}

const executableCommit = toolResult("commit", {
  phase: "commit",
  allowedTools: ["hy_commit"],
  nextAction: {
    tool: "hy_commit",
    arguments: { title: "fix: executable retry", body: "same intent" },
    phase: "commit",
    stage: "commit.ci",
    automatic: true,
  },
});
assert(executableCommit.nextAction.arguments?.title === "fix: executable retry", "complete parameterized calls should remain executable");

const legacyStop = toolResult("commit", {
  error: "temporary failure",
  requires_user: true,
  stop_here: true,
  allowedTools: ["hy_commit", "hy_status"],
});
assert(legacyStop.userAction?.kind === "review_failure", "legacy stop fields must not be interpreted as approval");
assert(legacyStop.control.reason === "review_required", "legacy stop should have an explicit non-approval reason");

const complete = toolResult("done", { allowedTools: ["hy_reset", "hy_status"] });
assert(complete.status === "completed", "done should normalize to completed");
assert(complete.stage === "done.completed", "done should expose its terminal stage");

for (const alias of ["before_plan", "before_approve", "after_edit"]) {
  assert(!(WORKFLOW_STAGES as readonly string[]).includes(alias), `${alias} must remain a document-read selector, not a workflow stage`);
}
assert(canonicalWorkflowStage("plan", "before_plan") === "plan.before_plan", "historical before_plan state should migrate once");
assert(canonicalWorkflowStage("approve", "before_approve") === "approve.before_approve", "historical before_approve state should migrate once");
assert(canonicalWorkflowStage("edit", "after_edit") === "edit.after_edit", "historical after_edit state should migrate once");
assert(canonicalWorkflowStage("edit", "verify.run") === "edit.implementation", "a stage from another phase must fall back safely");
for (const stage of WORKFLOW_STAGES) {
  const phase = workflowStagePhase(stage);
  assert(workflowStageMatchesPhase(phase, stage), `${stage} should have exactly one owning phase`);
}
