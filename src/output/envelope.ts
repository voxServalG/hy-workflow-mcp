import type { Phase, WorkflowStage, WorkflowStatus } from "../runtime/state-machine.js";
import { structuredError, type StructuredError } from "../errs/structured.js";
import {
  normalizeContract,
  TOOL_RECOVERY_STRATEGIES,
  validateToolCallArguments,
  type ToolControl,
  type ToolNextAction,
  type ToolRecoveryStrategy,
  type ToolUserAction,
} from "./control.js";

export type ToolDisplay = {
  title?: string;
  body?: string;
  files?: string[];
  urls?: string[];
  [key: string]: unknown;
};

export type ToolRecoveryCompatibilityFields = {
  tool?: string;
  arguments?: Record<string, unknown>;
  command?: string;
  instruction?: string;
  byLayer?: Record<string, string>;
};

type ToolRecoveryRequirements = {
  retry: { tool: string };
  repair_and_retry: { tool: string; instruction: string };
  wait_and_retry: { tool: string; instruction: string };
  replan: { tool: string; instruction: string };
  reset: { tool: "hy_reset"; instruction: string };
  external_action: { instruction: string };
};

export type ToolRecovery = {
  [Strategy in ToolRecoveryStrategy]:
    ToolRecoveryCompatibilityFields
    & { strategy: Strategy }
    & ToolRecoveryRequirements[Strategy];
}[ToolRecoveryStrategy];

export type ToolPagination = {
  has_more?: boolean;
  page_token?: string;
  next_page_token?: string;
};

export type ToolMeta = {
  command?: string;
  cwd?: string;
  identity?: string;
  format?: string;
  version?: string;
  request_id?: string;
  trace_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
};

export type ToolNotice = {
  update?: {
    message?: string;
    command?: string;
    current_version?: string;
    latest_version?: string;
  };
  [key: string]: unknown;
};

type ToolResultShape = {
  next: Phase;
  ok: boolean;
  phase: Phase;
  stage: WorkflowStage;
  status: WorkflowStatus;
  nextAction: ToolNextAction;
  control: ToolControl;
  userAction: ToolUserAction | null;
  data?: unknown;
  error?: StructuredError;
  display?: ToolDisplay;
  summary?: string;
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: ToolRecovery;
  checks?: unknown[];
  findings?: unknown[];
  pagination?: ToolPagination;
  meta?: ToolMeta;
  _notice?: ToolNotice;
};

export type ToolResult = ToolResultShape & Record<string, any>;

type ContractInputFields = "phase" | "stage" | "status" | "nextAction" | "control" | "userAction";

type ToolResultFieldShape = Omit<ToolResultShape, "next" | "error" | "ok" | ContractInputFields> & {
  ok?: boolean;
  phase?: Phase;
  stage?: WorkflowStage;
  status?: WorkflowStatus | string;
  nextAction?: ToolNextAction;
  control?: ToolControl;
  userAction?: ToolUserAction | null;
  error?: unknown;
};

export type ToolResultFields = ToolResultFieldShape & Record<string, unknown>;

function isStringMap(value: unknown): value is Record<string, string> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === "string"),
  );
}

function checkedRecovery(recovery: ToolRecovery | undefined): ToolRecovery | undefined {
  if (recovery === undefined) return undefined;
  const candidate = recovery as unknown as Record<string, unknown>;
  const strategy = candidate.strategy;
  if (typeof strategy !== "string" || !(TOOL_RECOVERY_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new TypeError("Tool recovery requires a supported strategy discriminator.");
  }
  for (const field of ["tool", "command", "instruction"] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "string") {
      throw new TypeError(`Tool recovery ${field} must be a string when provided.`);
    }
  }
  if (candidate.arguments !== undefined && (!candidate.arguments || typeof candidate.arguments !== "object" || Array.isArray(candidate.arguments))) {
    throw new TypeError("Tool recovery arguments must be an object when provided.");
  }
  if (candidate.byLayer !== undefined && !isStringMap(candidate.byLayer)) {
    throw new TypeError("Tool recovery byLayer must map layer names to string instructions.");
  }
  if (strategy !== "external_action" && typeof candidate.tool !== "string") {
    throw new TypeError(`Tool recovery strategy ${strategy} requires a tool.`);
  }
  if (strategy !== "retry" && typeof candidate.instruction !== "string") {
    throw new TypeError(`Tool recovery strategy ${strategy} requires an instruction.`);
  }
  if (strategy === "reset" && candidate.tool !== "hy_reset") {
    throw new TypeError("Tool recovery strategy reset must route to hy_reset.");
  }
  if (typeof candidate.tool === "string" && candidate.tool.startsWith("hy_")) {
    validateToolCallArguments(candidate.tool, candidate.arguments as Record<string, unknown> | undefined);
  }
  return recovery;
}

export function toolResult(next: Phase, fields: ToolResultFields = {}): ToolResult {
  const { error: rawError, recovery: rawRecovery, ...rest } = fields;
  const error = rawError === undefined ? undefined : structuredError(rawError);
  const recovery = checkedRecovery(rawRecovery);
  const contract = normalizeContract({
    next,
    phase: rest.phase,
    stage: rest.stage,
    status: rest.status,
    error,
    allowedTools: rest.allowedTools,
    requires_user: rest.requires_user,
    stop_here: rest.stop_here,
    nextAction: rest.nextAction,
    control: rest.control,
    userAction: rest.userAction,
  });
  return {
    ok: rest.ok ?? error === undefined,
    next,
    ...rest,
    ...contract,
    ...(error ? { error } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

type ToolResultFailureFields = Omit<ToolResultFieldShape, "error" | "ok"> & Record<string, unknown>;

export function structuredFailureResult(next: Phase, error: unknown, fields: ToolResultFailureFields = {}): ToolResult {
  return toolResult(next, { ...fields, ok: false, error: structuredError(error) });
}
