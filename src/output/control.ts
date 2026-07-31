import {
  DEFAULT_STAGE_BY_PHASE,
  isWorkflowStatus,
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

export type ToolRecoveryStrategy =
  | "retry"
  | "repair_and_retry"
  | "wait_and_retry"
  | "replan"
  | "reset"
  | "external_action";

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
  const candidate = input.allowedTools?.find(tool => tool !== "hy_status");
  if (candidate) return candidate;
  if (input.next === "done") return null;
  return `hy_${input.next}`;
}

function defaultUserAction(input: ContractInput): ToolUserAction | null {
  if (input.userAction !== undefined) return input.userAction;
  if (!input.requires_user) return null;
  return {
    kind: "review_failure",
    instruction: "Review the displayed failure and recovery guidance.",
  };
}

function defaultControl(input: ContractInput, userAction: ToolUserAction | null): ToolControl {
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
    return {
      automatic: !input.stop_here,
      stop: Boolean(input.stop_here),
      reason: "repair_required",
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
  const phase = input.phase ?? input.next;
  const stage = input.stage ?? DEFAULT_STAGE_BY_PHASE[phase];
  const userAction = defaultUserAction(input);
  const control = defaultControl(input, userAction);
  const nextAction = input.nextAction ?? {
    tool: defaultTool(input),
    phase: input.next,
    stage: input.next === phase ? stage : DEFAULT_STAGE_BY_PHASE[input.next],
    automatic: control.automatic,
  };
  return {
    phase,
    stage,
    status: defaultStatus(input, control),
    nextAction: {
      ...nextAction,
      stage: nextAction.stage ?? DEFAULT_STAGE_BY_PHASE[nextAction.phase],
      automatic: control.automatic && nextAction.automatic,
    },
    control,
    userAction,
  };
}
