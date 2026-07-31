import {
  canonicalWorkflowStage,
  DEFAULT_STAGE_BY_PHASE,
  VALID_TRANSITIONS,
  isPhase,
  isWorkflowStatus,
  workflowStageMatchesPhase,
  type Phase,
  type WorkflowStage,
  type WorkflowStatus,
} from "../runtime/state-machine.js";

export type UserActionKind =
  | "approval"
  | "provide_information"
  | "fix_configuration"
  | "authenticate"
  | "grant_permission"
  | "review_failure"
  | "wait"
  | "external_action";

export type ControlReason =
  | "automatic"
  | "approval_required"
  | "information_required"
  | "configuration_required"
  | "authentication_required"
  | "permission_required"
  | "review_required"
  | "wait_required"
  | "external_action_required"
  | "repair_required"
  | "completed";

export type ToolNextAction = {
  tool: string | null;
  arguments?: Record<string, unknown>;
  phase: Phase;
  stage: WorkflowStage;
  automatic: boolean;
};

export type ToolControl = {
  automatic: boolean;
  stop: boolean;
  reason: ControlReason;
};

export type ToolUserAction = {
  kind: UserActionKind;
  decisionId?: string;
  prompt?: string;
  instruction?: string;
  options?: string[];
};

export const TOOL_RECOVERY_STRATEGIES = [
  "retry",
  "repair_and_retry",
  "wait_and_retry",
  "replan",
  "reset",
  "external_action",
] as const;

export type ToolRecoveryStrategy = typeof TOOL_RECOVERY_STRATEGIES[number];

export type ContractFields = {
  phase: Phase;
  stage: WorkflowStage;
  status: WorkflowStatus;
  nextAction: ToolNextAction;
  control: ToolControl;
  userAction: ToolUserAction | null;
};

type ContractInput = {
  next: Phase;
  phase?: Phase;
  stage?: WorkflowStage;
  status?: WorkflowStatus | string;
  error?: unknown;
  allowedTools?: string[];
  requires_user?: boolean;
  stop_here?: boolean;
  nextAction?: ToolNextAction;
  control?: ToolControl;
  userAction?: ToolUserAction | null;
};

function defaultTool(input: ContractInput): string | null {
  const argumentTools = new Set(["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_amend_plan", "hy_exam_submit", "hy_commit"]);
  const candidate = input.allowedTools?.find(tool => tool !== "hy_status" && !argumentTools.has(tool));
  if (candidate) return candidate;
  if (input.allowedTools?.includes("hy_status")) return "hy_status";
  if (input.next === "done") return null;
  return null;
}

function routeError(message: string): never {
  throw new TypeError(`Invalid nextAction contract: ${message}`);
}

function validatePhaseStage(phase: unknown, stage: unknown, label: string): asserts phase is Phase {
  if (typeof phase !== "string" || !isPhase(phase)) routeError(`${label}.phase is not a workflow phase.`);
  if (!workflowStageMatchesPhase(phase, stage)) routeError(`${label}.stage does not belong to ${phase}.`);
}

function requiredArguments(tool: string, value: Record<string, unknown> | undefined): Record<string, unknown> {
  const args = value;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    routeError(`${tool} requires an arguments object.`);
  }
  return args;
}

function requireNonEmptyString(args: Record<string, unknown>, field: string, tool: string): void {
  if (typeof args[field] !== "string" || !(args[field] as string).trim()) {
    routeError(`${tool} requires a non-empty arguments.${field}.`);
  }
}

export function validateToolCallArguments(tool: string, value: Record<string, unknown> | undefined): void {
  if (tool === "hy_read_docs") {
    const args = requiredArguments(tool, value);
    const selector = args.stage;
    if (typeof selector !== "string" || !["before_plan", "before_approve", "after_edit"].includes(selector)) {
      routeError("hy_read_docs arguments.stage must be before_plan, before_approve, or after_edit.");
    }
    if (selector === "before_plan" && (typeof args.task !== "string" || !args.task.trim())) {
      routeError("hy_read_docs before_plan requires a non-empty arguments.task.");
    }
    if (args.task !== undefined && typeof args.task !== "string") {
      routeError("hy_read_docs arguments.task must be a string when provided.");
    }
    if (args.cursor !== undefined && typeof args.cursor !== "string") {
      routeError("hy_read_docs arguments.cursor must be a string when provided.");
    }
    return;
  }

  if (tool === "hy_plan") {
    const args = requiredArguments(tool, value);
    requireNonEmptyString(args, "task", "hy_plan");
    if (!args.plan || typeof args.plan !== "object" || Array.isArray(args.plan)) {
      routeError("hy_plan requires an object arguments.plan.");
    }
    return;
  }

  if (tool === "hy_approve" || tool === "hy_amend_plan") {
    const args = requiredArguments(tool, value);
    if (!(["approve", "reject", "revise"] as unknown[]).includes(args.approved)) {
      routeError(`${tool} arguments.approved must be approve, reject, or revise.`);
    }
    requireNonEmptyString(args, "decisionId", tool);
    return;
  }

  if (tool === "hy_branch") {
    const args = requiredArguments(tool, value);
    requireNonEmptyString(args, "category", "hy_branch");
    requireNonEmptyString(args, "topic", "hy_branch");
    return;
  }

  if (tool === "hy_exam_submit") {
    const args = requiredArguments(tool, value);
    requireNonEmptyString(args, "examId", "hy_exam_submit");
    if (!Array.isArray(args.results)) routeError("hy_exam_submit requires an array arguments.results.");
    return;
  }

  if (tool === "hy_commit") {
    const args = requiredArguments(tool, value);
    requireNonEmptyString(args, "title", "hy_commit");
    if (typeof args.body !== "string") routeError("hy_commit requires a string arguments.body.");
  }
}

function validateToolArguments(nextAction: ToolNextAction): void {
  if (nextAction.tool === null) return;
  validateToolCallArguments(nextAction.tool, nextAction.arguments);
  if (nextAction.tool !== "hy_read_docs") return;
  const selector = nextAction.arguments!.stage as "before_plan" | "before_approve" | "after_edit";
  const routes = {
    before_plan: { phase: "plan", stage: "plan.before_plan" },
    before_approve: { phase: "approve", stage: "approve.before_approve" },
    after_edit: { phase: "edit", stage: "edit.after_edit" },
  } as const;
  const expected = routes[selector];
  if (nextAction.phase !== expected.phase || nextAction.stage !== expected.stage) {
    routeError(`hy_read_docs ${selector} must target ${expected.phase}/${expected.stage}.`);
  }
}

function validateNextAction(input: ContractInput, nextAction: ToolNextAction, control: ToolControl): void {
  validatePhaseStage(nextAction.phase, nextAction.stage, "nextAction");
  const currentPhase = input.phase ?? input.next;
  if (!VALID_TRANSITIONS[currentPhase]?.includes(nextAction.phase)) {
    routeError(`phase ${nextAction.phase} is not reachable from ${currentPhase}.`);
  }
  if (nextAction.tool !== null) {
    if (typeof nextAction.tool !== "string") routeError("tool must be a string or null.");
    if (!input.allowedTools?.includes(nextAction.tool)) {
      routeError(`tool ${nextAction.tool} is not present in allowedTools.`);
    }
  }
  if (nextAction.arguments !== undefined && (!nextAction.arguments || typeof nextAction.arguments !== "object" || Array.isArray(nextAction.arguments))) {
    routeError("arguments must be an object when provided.");
  }
  validateToolArguments(nextAction);
  const automatic = control.automatic && !control.stop;
  if (nextAction.automatic !== automatic) {
    routeError("nextAction.automatic must equal control.automatic and be false when control.stop is true.");
  }
  if (nextAction.tool === null && automatic) routeError("an automatic route requires a concrete tool.");
}

function defaultUserAction(input: ContractInput): ToolUserAction | null {
  if (input.userAction !== undefined) return input.userAction;
  if (!input.requires_user) return null;
  return { kind: "review_failure" };
}

function defaultControl(
  input: ContractInput,
  userAction: ToolUserAction | null,
  fallbackTool: string | null,
): ToolControl {
  if (input.control) return input.control;
  if (input.next === "done" && !input.error) {
    return { automatic: false, stop: true, reason: "completed" };
  }
  if (userAction) {
    const reasons: Record<UserActionKind, ControlReason> = {
      approval: "approval_required",
      provide_information: "information_required",
      fix_configuration: "configuration_required",
      authenticate: "authentication_required",
      grant_permission: "permission_required",
      review_failure: "review_required",
      wait: "wait_required",
      external_action: "external_action_required",
    };
    return { automatic: false, stop: true, reason: reasons[userAction.kind] };
  }
  if (input.error) {
    if (!input.nextAction) {
      return {
        automatic: false,
        stop: true,
        reason: "repair_required",
      };
    }
    return {
      automatic: !input.stop_here,
      stop: Boolean(input.stop_here),
      reason: "repair_required",
    };
  }
  if (fallbackTool === null && !input.nextAction) {
    return {
      automatic: false,
      stop: true,
      reason: "information_required",
    };
  }
  return { automatic: true, stop: false, reason: "automatic" };
}

function defaultStatus(input: ContractInput, control: ToolControl): WorkflowStatus {
  if (isWorkflowStatus(input.status)) return input.status;
  if (control.reason === "completed") return "completed";
  if (control.reason === "wait_required" || control.reason === "approval_required") return "pending";
  if (input.error) return control.stop ? "blocked" : "failed";
  return input.next === (input.phase ?? input.next) ? "ready" : "passed";
}

export function normalizeContract(input: ContractInput): ContractFields {
  if (typeof input.next !== "string" || !isPhase(input.next)) routeError("next is not a workflow phase.");
  const phase = input.phase ?? input.next;
  if (typeof phase !== "string" || !isPhase(phase)) routeError("phase is not a workflow phase.");
  if (input.stage !== undefined && !workflowStageMatchesPhase(phase, input.stage)) {
    routeError(`stage does not belong to ${phase}.`);
  }
  const stage = input.stage ?? DEFAULT_STAGE_BY_PHASE[phase];
  const userAction = defaultUserAction(input);
  const fallbackTool = input.error ? null : defaultTool(input);
  const control = defaultControl(input, userAction, fallbackTool);
  const nextAction = input.nextAction ?? {
    tool: fallbackTool,
    phase: input.next,
    stage: input.next === phase ? stage : DEFAULT_STAGE_BY_PHASE[input.next],
    automatic: control.automatic,
  };
  validateNextAction(input, nextAction, control);
  return {
    phase,
    stage,
    status: defaultStatus(input, control),
    nextAction: {
      ...nextAction,
      stage: canonicalWorkflowStage(nextAction.phase, nextAction.stage),
      automatic: nextAction.automatic,
    },
    control,
    userAction,
  };
}
