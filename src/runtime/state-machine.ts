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

export const WORKFLOW_STAGES_BY_PHASE = {
  init: ["init.ready"],
  plan: ["plan.before_plan", "plan.compose", "plan.review"],
  approve: ["approve.before_approve", "approve.decision"],
  branch: ["branch.create"],
  edit: ["edit.scope", "edit.implementation", "edit.after_edit", "edit.sync_docs"],
  verify: ["verify.run", "verify.amendment"],
  commit: ["commit.prepare", "commit.publish", "commit.ci"],
  merge: ["merge.reconcile", "merge.sync"],
  done: ["done.completed"],
} as const satisfies Record<Phase, readonly string[]>;

export type WorkflowStageForPhase<P extends Phase> = typeof WORKFLOW_STAGES_BY_PHASE[P][number];
export type WorkflowStage = WorkflowStageForPhase<Phase>;

export const WORKFLOW_STAGES = Object.freeze(
  Object.values(WORKFLOW_STAGES_BY_PHASE).flat(),
) as readonly WorkflowStage[];

export const DEFAULT_STAGE_BY_PHASE = {
  init: "init.ready",
  plan: "plan.compose",
  approve: "approve.decision",
  branch: "branch.create",
  edit: "edit.implementation",
  verify: "verify.run",
  commit: "commit.prepare",
  merge: "merge.reconcile",
  done: "done.completed",
} as const satisfies { [P in Phase]: WorkflowStageForPhase<P> };

const LEGACY_STAGE_ALIASES: Readonly<Record<string, WorkflowStage>> = {
  before_plan: "plan.before_plan",
  before_approve: "approve.before_approve",
  after_edit: "edit.after_edit",
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

export function workflowStagePhase(stage: WorkflowStage): Phase {
  for (const phase of PHASES) {
    if ((WORKFLOW_STAGES_BY_PHASE[phase] as readonly string[]).includes(stage)) return phase;
  }
  throw new Error(`Unknown workflow stage: ${stage}`);
}

export function workflowStageMatchesPhase<P extends Phase>(
  phase: P,
  stage: unknown,
): stage is WorkflowStageForPhase<P> {
  return typeof stage === "string"
    && (WORKFLOW_STAGES_BY_PHASE[phase] as readonly string[]).includes(stage);
}

/**
 * Canonicalize persisted or caller-provided stage data for one phase.
 *
 * The three unqualified values are accepted only as historical external-state
 * input. They are never members of WorkflowStage and are never emitted or
 * persisted again.
 */
export function canonicalWorkflowStage<P extends Phase>(
  phase: P,
  value: unknown,
): WorkflowStageForPhase<P> {
  const candidate = typeof value === "string"
    ? LEGACY_STAGE_ALIASES[value] ?? value
    : value;
  return workflowStageMatchesPhase(phase, candidate)
    ? candidate
    : DEFAULT_STAGE_BY_PHASE[phase];
}
