import { attachSetupCheck, checkSetupStamp, createSetupGate } from "../bootstrap.js";
import { structuredError, type StructuredError } from "../errs/structured.js";
import {
  type ControlReason,
  type ToolControl,
  type ToolUserAction,
} from "../output/control.js";
import type { ToolRecovery, ToolResult } from "../output/envelope.js";
import {
  DEFAULT_STAGE_BY_PHASE,
  type Phase,
  type WorkflowStage,
  type WorkflowStatus,
} from "../runtime/state-machine.js";
import { readState } from "../state.js";
import { handleAmendPlan } from "../tools/amend_plan.js";
import { handleApprove } from "../tools/approve.js";
import { handleBranch } from "../tools/branch.js";
import { handleCommit } from "../tools/commit.js";
import { handleEdit } from "../tools/edit.js";
import { handleExamPlan } from "../tools/exam-plan.js";
import { handleExamSubmit } from "../tools/exam-submit.js";
import { handleInit } from "../tools/init.js";
import { handleMerge } from "../tools/merge.js";
import { handlePlan } from "../tools/plan.js";
import { handleReadDocs } from "../tools/read_docs.js";
import { handleReset } from "../tools/reset.js";
import { handleStatus } from "../tools/status.js";
import { handleSyncDocs } from "../tools/sync_docs.js";
import { handleVerify } from "../tools/verify.js";

import {
  WorkflowCliInputError,
  parseWorkflowCliArgsWithDependencies,
  stableJsonStringify,
  validateWorkflowCommandInputWithDependencies,
  type WorkflowCliInputDependencies,
} from "./workflow-input.js";
import {
  nullHandoffAction,
  routeAction,
  routeArgv,
  type WorkflowCliRouteDependencies,
} from "./workflow-route.js";

export { WorkflowCliInputError, stableJsonStringify };

export const WORKFLOW_CLI_SCHEMA = "hy-workflow.cli.v1" as const;
export const WORKFLOW_CLI_VERSION = 1 as const;
export const WORKFLOW_CLI_PROGRAM = "hy-workflow" as const;
export const WORKFLOW_CLI_MAX_INPUT_BYTES = 1024 * 1024;

export const WORKFLOW_CLI_COMMANDS = [
  "init",
  "status",
  "read-docs",
  "plan",
  "approve",
  "branch",
  "edit",
  "sync-docs",
  "verify",
  "exam-plan",
  "exam-submit",
  "amend-plan",
  "commit",
  "merge",
  "reset",
] as const;

export type WorkflowCliCommand = typeof WORKFLOW_CLI_COMMANDS[number];
export type WorkflowCliInput = Record<string, unknown>;

type WorkflowToolName =
  | "hy_init"
  | "hy_status"
  | "hy_read_docs"
  | "hy_plan"
  | "hy_approve"
  | "hy_branch"
  | "hy_edit"
  | "hy_sync_docs"
  | "hy_verify"
  | "hy_exam_plan"
  | "hy_exam_submit"
  | "hy_amend_plan"
  | "hy_commit"
  | "hy_merge"
  | "hy_reset";

type CommandSpec = {
  tool: WorkflowToolName;
  fields: readonly string[];
  handler: (input: WorkflowCliInput) => Promise<ToolResult>;
};

const COMMAND_SPECS: Readonly<Record<WorkflowCliCommand, CommandSpec>> = {
  init: { tool: "hy_init", fields: [], handler: () => handleInit() },
  status: { tool: "hy_status", fields: [], handler: () => handleStatus() },
  "read-docs": { tool: "hy_read_docs", fields: ["stage", "task", "cursor"], handler: input => handleReadDocs(input as Parameters<typeof handleReadDocs>[0]) },
  plan: { tool: "hy_plan", fields: ["task", "plan"], handler: input => handlePlan(input as Parameters<typeof handlePlan>[0]) },
  approve: { tool: "hy_approve", fields: ["approved", "decisionId", "note", "auditDecision"], handler: input => handleApprove(input as Parameters<typeof handleApprove>[0]) },
  branch: { tool: "hy_branch", fields: ["category", "topic"], handler: input => handleBranch(input as Parameters<typeof handleBranch>[0]) },
  edit: { tool: "hy_edit", fields: [], handler: () => handleEdit() },
  "sync-docs": { tool: "hy_sync_docs", fields: [], handler: () => handleSyncDocs() },
  verify: { tool: "hy_verify", fields: [], handler: () => handleVerify() },
  "exam-plan": { tool: "hy_exam_plan", fields: [], handler: () => handleExamPlan() },
  "exam-submit": { tool: "hy_exam_submit", fields: ["examId", "results"], handler: input => handleExamSubmit(input as unknown as Parameters<typeof handleExamSubmit>[0]) },
  "amend-plan": { tool: "hy_amend_plan", fields: ["approved", "decisionId", "note"], handler: input => handleAmendPlan(input as Parameters<typeof handleAmendPlan>[0]) },
  commit: { tool: "hy_commit", fields: ["title", "body"], handler: input => handleCommit(input as Parameters<typeof handleCommit>[0]) },
  merge: { tool: "hy_merge", fields: [], handler: () => handleMerge() },
  reset: { tool: "hy_reset", fields: [], handler: () => handleReset() },
};

const TOOL_TO_COMMAND = Object.freeze(Object.fromEntries(
  Object.entries(COMMAND_SPECS).map(([command, spec]) => [spec.tool, command]),
)) as Readonly<Record<WorkflowToolName, WorkflowCliCommand>>;


export type ParsedWorkflowCli = {
  command: WorkflowCliCommand;
  input: WorkflowCliInput;
  argv: string[];
  inputSource: "default" | "inline" | "file";
};

export type WorkflowCliInputRequirement = {
  path: string;
  type: "string" | "object" | "array" | "enum";
  source: "current_user_task" | "human_decision" | "skill_synthesis" | "skill_review" | "external_result";
  minLength?: number;
  options?: string[];
  decisionId?: string;
};

export type WorkflowCliRouteAction = {
  command: WorkflowCliCommand | null;
  target?: string;
  argv: string[] | null;
  input?: WorkflowCliInput;
  inputRequired?: WorkflowCliInputRequirement[];
  phase: Phase;
  stage: WorkflowStage;
  automatic: boolean;
};

export type WorkflowCliUserAction = Omit<ToolUserAction, "prompt" | "instruction">;

export type WorkflowCliRecovery = Record<string, unknown> & {
  strategy: ToolRecovery["strategy"];
  command: WorkflowCliCommand | null;
  target?: string;
  argv: string[] | null;
  input?: WorkflowCliInput;
};

export type WorkflowCliRoute = {
  nextPhase: Phase;
  action: WorkflowCliRouteAction;
  choices?: WorkflowCliCommand[];
  allowed: string[];
  blocked: string[];
  control: ToolControl;
  userAction: WorkflowCliUserAction | null;
  recovery?: WorkflowCliRecovery;
};

export type WorkflowCliEnvelope = {
  schema: typeof WORKFLOW_CLI_SCHEMA;
  version: typeof WORKFLOW_CLI_VERSION;
  command: WorkflowCliCommand | null;
  ok: boolean;
  phase: Phase;
  stage: WorkflowStage;
  status: WorkflowStatus;
  error?: Omit<StructuredError, "hint">;
  route: WorkflowCliRoute;
  [key: string]: unknown;
};

export type WorkflowCliRunResult = {
  exitCode: 0 | 1;
  stdout: string;
  envelope: WorkflowCliEnvelope;
};

function isWorkflowCliCommand(value: string): value is WorkflowCliCommand {
  return (WORKFLOW_CLI_COMMANDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// The delegated validator preserves the public INPUT_SCHEMA_INVALID error code.
const INPUT_DEPENDENCIES: WorkflowCliInputDependencies = {
  maxInputBytes: WORKFLOW_CLI_MAX_INPUT_BYTES,
  isCommand: isWorkflowCliCommand,
  commandSpec: command => COMMAND_SPECS[command],
};

export function validateWorkflowCommandInput(command: WorkflowCliCommand, input: WorkflowCliInput): void {
  validateWorkflowCommandInputWithDependencies(command, input, INPUT_DEPENDENCIES);
}

export function parseWorkflowCliArgs(
  argv: readonly string[],
  options: { cwd?: string } = {},
): ParsedWorkflowCli {
  return parseWorkflowCliArgsWithDependencies(argv, options, INPUT_DEPENDENCIES);
}

export function workflowCommandForTool(tool: string | null | undefined): WorkflowCliCommand | null {
  if (!tool) return null;
  return TOOL_TO_COMMAND[tool as WorkflowToolName] ?? null;
}

export function workflowCommandArgv(
  command: WorkflowCliCommand,
  input?: WorkflowCliInput,
): string[] {
  const argv: string[] = [WORKFLOW_CLI_PROGRAM, command];
  if (input !== undefined && Object.keys(input).length > 0) argv.push("--input", stableJsonStringify(input));
  return argv;
}

const ROUTE_DEPENDENCIES: WorkflowCliRouteDependencies = {
  commandForTool: workflowCommandForTool,
  commandArgv: workflowCommandArgv,
  commandFields: command => COMMAND_SPECS[command].fields,
};

function routeUserAction(userAction: ToolUserAction | null | undefined): WorkflowCliUserAction | null {
  if (!userAction) return null;
  const { prompt: _prompt, instruction: _instruction, ...facts } = userAction;
  return facts;
}

function routeRecovery(recovery: ToolRecovery | undefined): WorkflowCliRecovery | undefined {
  if (!recovery) return undefined;
  const record = recovery as ToolRecovery & Record<string, unknown>;
  const {
    tool,
    arguments: rawInput,
    command: _shellCommand,
    byLayer: _byLayer,
    instruction: _instruction,
    ...facts
  } = record;
  const input = isRecord(rawInput) ? rawInput : undefined;
  const command = workflowCommandForTool(tool);
  return {
    ...facts,
    strategy: recovery.strategy,
    command,
    ...(tool && !command ? { target: tool } : {}),
    argv: routeArgv(tool, input, ROUTE_DEPENDENCIES),
    ...(input !== undefined ? { input } : {}),
  };
}

function routeName(tool: string): string {
  return workflowCommandForTool(tool) ?? tool;
}

const CONTROL_FIELDS = new Set([
  "ok",
  "next",
  "phase",
  "stage",
  "status",
  "nextAction",
  "control",
  "userAction",
  "allowedTools",
  "blockedTools",
  "recovery",
  "error",
  "display",
  "summary",
  "message",
  "pipeline",
  "stopAfter",
  "resumeAfter",
  "_notice",
  "hint",
  "requires_user",
  "stop_here",
]);

function factFields(result: ToolResult): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (!CONTROL_FIELDS.has(key) && value !== undefined) facts[key] = value;
  }
  return facts;
}

function errorWithoutHint(error: StructuredError | undefined): Omit<StructuredError, "hint"> | undefined {
  if (!error) return undefined;
  return {
    type: error.type,
    subtype: error.subtype,
    message: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.risk !== undefined ? { risk: error.risk } : {}),
    ...(error.permission_violations !== undefined
      ? { permission_violations: error.permission_violations }
      : {}),
    ...(error.missing_scopes !== undefined
      ? { missing_scopes: error.missing_scopes }
      : {}),
    ...(error.console_url !== undefined ? { console_url: error.console_url } : {}),
    ...(error.request_id !== undefined ? { request_id: error.request_id } : {}),
    ...(error.trace_id !== undefined ? { trace_id: error.trace_id } : {}),
  };
}

export function toWorkflowCliEnvelope(
  command: WorkflowCliCommand,
  result: ToolResult,
): WorkflowCliEnvelope {
  const verificationSelection = result.stage === "edit.sync_docs"
    && result.nextAction.tool === "hy_verify"
    && (result.allowedTools ?? []).includes("hy_verify");
  const projectedAction = result.nextAction.tool
    ? routeAction(result.nextAction, ROUTE_DEPENDENCIES)
    : nullHandoffAction(result, ROUTE_DEPENDENCIES);
  const action = verificationSelection
    ? {
        ...projectedAction,
        command: null,
        argv: null,
        automatic: false,
      }
    : projectedAction;
  const allowed = [...new Set((result.allowedTools ?? []).map(routeName).concat(verificationSelection ? ["exam-plan"] : []))];
  const recovery = routeRecovery(result.recovery);
  const error = errorWithoutHint(result.error);
  return {
    schema: WORKFLOW_CLI_SCHEMA,
    version: WORKFLOW_CLI_VERSION,
    command,
    ok: result.ok,
    phase: result.phase,
    stage: result.stage,
    status: result.status,
    ...factFields(result),
    ...(error ? { error } : {}),
    route: {
      nextPhase: result.next,
      action,
      ...(verificationSelection ? { choices: ["verify", "exam-plan"] as WorkflowCliCommand[] } : {}),
      allowed,
      blocked: (result.blockedTools ?? []).map(routeName),
      control: verificationSelection
        ? { automatic: false, stop: true, reason: "information_required" }
        : result.control,
      userAction: routeUserAction(result.userAction),
      ...(recovery ? { recovery } : {}),
    },
  };
}

function inferredPhase(command: WorkflowCliCommand | null): Phase {
  if (command === "read-docs" || command === "plan" || command === "reset") return "plan";
  if (command === "approve") return "approve";
  if (command === "branch") return "branch";
  if (command === "edit" || command === "sync-docs") return "edit";
  if (command === "verify" || command === "exam-plan" || command === "exam-submit" || command === "amend-plan") return "verify";
  if (command === "commit") return "commit";
  if (command === "merge") return "merge";
  return "init";
}

function currentPosition(command: WorkflowCliCommand | null): { phase: Phase; stage: WorkflowStage } {
  try {
    const state = readState();
    return { phase: state.phase, stage: state.stage ?? DEFAULT_STAGE_BY_PHASE[state.phase] };
  } catch {
    const phase = inferredPhase(command);
    return { phase, stage: DEFAULT_STAGE_BY_PHASE[phase] };
  }
}

function failureEnvelope(command: WorkflowCliCommand | null, caught: unknown): WorkflowCliEnvelope {
  const error = errorWithoutHint(structuredError(caught));
  const position = currentPosition(command);
  const resetRequired = error?.code === "WORKFLOW_STATE_CORRUPT";
  const recoveryPhase: Phase = resetRequired ? "plan" : position.phase;
  const recoveryStage: WorkflowStage = resetRequired ? "plan.before_plan" : position.stage;
  const recoveryCommand: WorkflowCliCommand = resetRequired ? "reset" : "status";
  return {
    schema: WORKFLOW_CLI_SCHEMA,
    version: WORKFLOW_CLI_VERSION,
    command,
    ok: false,
    phase: position.phase,
    stage: position.stage,
    status: "failed",
    ...(error ? { error } : {}),
    route: {
      nextPhase: recoveryPhase,
      action: {
        command: recoveryCommand,
        argv: workflowCommandArgv(recoveryCommand),
        phase: recoveryPhase,
        stage: recoveryStage,
        automatic: false,
      },
      allowed: [recoveryCommand],
      blocked: [],
      control: { automatic: false, stop: true, reason: "repair_required" satisfies ControlReason },
      userAction: null,
      ...(resetRequired ? { recovery: { strategy: "reset", command: "reset", argv: workflowCommandArgv("reset") } } : {}),
    },
  };
}

/**
 * Dispatch one parsed workflow command through the existing application
 * handlers. The setup gate and setup-check attachment intentionally match the
 * current transport wrapper so the adapter does not fork workflow semantics.
 */
export async function dispatchWorkflowCommand(
  command: WorkflowCliCommand,
  input: WorkflowCliInput = {},
): Promise<ToolResult> {
  validateWorkflowCommandInput(command, input);
  const setupFailure = createSetupGate()();
  if (setupFailure) return setupFailure;
  const result = await COMMAND_SPECS[command].handler(input);
  return attachSetupCheck(result, checkSetupStamp());
}

/** Parse, dispatch, and serialize exactly one compact JSON document. */
export async function runWorkflowCli(argv: readonly string[]): Promise<WorkflowCliRunResult> {
  let command: WorkflowCliCommand | null = argv[0] && isWorkflowCliCommand(argv[0]) ? argv[0] : null;
  try {
    const parsed = parseWorkflowCliArgs(argv);
    command = parsed.command;
    const result = await dispatchWorkflowCommand(parsed.command, parsed.input);
    const envelope = toWorkflowCliEnvelope(parsed.command, result);
    return {
      exitCode: envelope.ok ? 0 : 1,
      stdout: `${JSON.stringify(envelope)}\n`,
      envelope,
    };
  } catch (error) {
    const envelope = failureEnvelope(command, error);
    return { exitCode: 1, stdout: `${JSON.stringify(envelope)}\n`, envelope };
  }
}
