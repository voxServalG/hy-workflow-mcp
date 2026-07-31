export const PHASES = [
  "init",
  "plan",
  "approve",
  "branch",
  "edit",
  "verify",
  "commit",
  "merge",
  "done",
] as const;

export type Phase = typeof PHASES[number];

export const WORKFLOW_STATUSES = [
  "ready",
  "running",
  "passed",
  "warning",
  "pending",
  "blocked",
  "failed",
  "completed",
  // Compatibility value emitted while a scope amendment is awaiting review.
  "amend_required",
] as const;

export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];

export const WORKFLOW_STAGES = [
  "init.ready",
  "plan.before_plan",
  "plan.compose",
  "plan.review",
  "approve.before_approve",
  "approve.decision",
  "branch.create",
  "edit.scope",
  "edit.implementation",
  "edit.after_edit",
  "edit.sync_docs",
  "verify.run",
  "verify.amendment",
  "commit.prepare",
  "commit.publish",
  "commit.ci",
  "merge.reconcile",
  "merge.sync",
  "done.completed",
  // Existing hy_read_docs result values remain valid during the additive rollout.
  "before_plan",
  "before_approve",
  "after_edit",
] as const;

export type WorkflowStage = typeof WORKFLOW_STAGES[number];

export const DEFAULT_STAGE_BY_PHASE: Record<Phase, WorkflowStage> = {
  init: "init.ready",
  plan: "plan.compose",
  approve: "approve.decision",
  branch: "branch.create",
  edit: "edit.implementation",
  verify: "verify.run",
  commit: "commit.prepare",
  merge: "merge.reconcile",
  done: "done.completed",
};

export const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  init: ["init", "plan", "done"],
  plan: ["plan", "approve", "done"],
  approve: ["approve", "branch", "plan"],
  branch: ["branch", "edit", "done"],
  edit: ["edit", "verify", "commit", "done"],
  verify: ["verify", "edit", "commit", "done"],
  commit: ["commit", "edit", "merge", "done"],
  merge: ["merge", "done"],
  done: ["done"],
};

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export function isWorkflowStage(value: unknown): value is WorkflowStage {
  return typeof value === "string" && (WORKFLOW_STAGES as readonly string[]).includes(value);
}
