import type { ToolNextAction } from "../output/control.js";
import type { ToolResult } from "../output/envelope.js";
import type {
  WorkflowCliCommand,
  WorkflowCliInput,
  WorkflowCliInputRequirement,
  WorkflowCliRouteAction,
} from "./workflow.js";

export type WorkflowCliRouteDependencies = {
  commandForTool: (tool: string | null | undefined) => WorkflowCliCommand | null;
  commandArgv: (command: WorkflowCliCommand, input?: WorkflowCliInput) => string[];
  commandFields: (command: WorkflowCliCommand) => readonly string[];
};

export function routeArgv(
  tool: string | null | undefined,
  input: WorkflowCliInput | undefined,
  dependencies: WorkflowCliRouteDependencies,
): string[] | null {
  const command = dependencies.commandForTool(tool);
  if (!command) return null;
  const fields = dependencies.commandFields(command);
  if (fields.length > 0 && input === undefined) return null;
  return dependencies.commandArgv(command, input);
}

export function routeAction(
  nextAction: ToolNextAction,
  dependencies: WorkflowCliRouteDependencies,
): WorkflowCliRouteAction {
  const command = dependencies.commandForTool(nextAction.tool);
  const input = nextAction.arguments as WorkflowCliInput | undefined;
  return {
    command,
    ...(nextAction.tool && !command ? { target: nextAction.tool } : {}),
    argv: routeArgv(nextAction.tool, input, dependencies),
    ...(input !== undefined ? { input } : {}),
    phase: nextAction.phase,
    stage: nextAction.stage,
    automatic: nextAction.automatic,
  };
}

function partialHandoffAction(
  result: ToolResult,
  command: WorkflowCliCommand,
  dependencies: WorkflowCliRouteDependencies,
  input: WorkflowCliInput = {},
  inputRequired: WorkflowCliInputRequirement[] = [],
): WorkflowCliRouteAction {
  return {
    command,
    argv: inputRequired.length ? null : dependencies.commandArgv(command, input),
    ...(Object.keys(input).length ? { input } : {}),
    ...(inputRequired.length ? { inputRequired } : {}),
    phase: result.nextAction.phase,
    stage: result.nextAction.stage,
    automatic: false,
  };
}

function inputRequirement(
  path: string,
  type: WorkflowCliInputRequirement["type"],
  source: WorkflowCliInputRequirement["source"],
  options: { minLength?: number; values?: string[]; decisionId?: string } = {},
): WorkflowCliInputRequirement {
  return {
    path,
    type,
    source,
    ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
    ...(options.values ? { options: options.values } : {}),
    ...(options.decisionId ? { decisionId: options.decisionId } : {}),
  };
}

export function nullHandoffAction(
  result: ToolResult,
  dependencies: WorkflowCliRouteDependencies,
): WorkflowCliRouteAction {
  const allowed = new Set(result.allowedTools ?? []);
  const record = result as ToolResult & Record<string, unknown>;
  const decisionId = result.userAction?.decisionId
    ?? (typeof record.decisionId === "string" ? record.decisionId : undefined);
  if (result.stage === "plan.before_plan" && allowed.has("hy_read_docs")) {
    return partialHandoffAction(result, "read-docs", dependencies, { stage: "before_plan" }, [
      inputRequirement("task", "string", "current_user_task", { minLength: 1 }),
    ]);
  }
  if (result.stage === "plan.compose" && allowed.has("hy_plan")) {
    return partialHandoffAction(result, "plan", dependencies, {}, [
      inputRequirement("task", "string", "current_user_task", { minLength: 1 }),
      inputRequirement("plan", "object", "skill_synthesis"),
    ]);
  }
  if (result.stage === "approve.decision" && allowed.has("hy_approve")) {
    return partialHandoffAction(result, "approve", dependencies, decisionId ? { decisionId } : {}, [
      inputRequirement("approved", "enum", "human_decision", {
        values: result.userAction?.options,
        decisionId,
      }),
    ]);
  }
  if (result.stage === "approve.before_approve" && allowed.has("hy_approve")) {
    const auditRequired = (result.error as any)?.code === "APPROVAL_AUDIT_DECISION_REQUIRED";
    return partialHandoffAction(
      result,
      "approve",
      dependencies,
      { approved: "approve", ...(decisionId ? { decisionId } : {}) },
      auditRequired
        ? [inputRequirement("auditDecision", "enum", "skill_review", { values: ["continue", "replan"] })]
        : [],
    );
  }
  if (result.stage === "branch.create" && allowed.has("hy_branch")) {
    return partialHandoffAction(result, "branch", dependencies, {}, [
      inputRequirement("category", "enum", "skill_synthesis", {
        values: ["refactor", "feat", "chore", "docs", "ci", "fix", "test"],
      }),
      inputRequirement("topic", "string", "skill_synthesis", { minLength: 1 }),
    ]);
  }
  if (result.stage === "edit.implementation" && allowed.has("hy_read_docs")) {
    return partialHandoffAction(result, "read-docs", dependencies, { stage: "after_edit" });
  }
  if (result.stage === "edit.after_edit" && allowed.has("hy_sync_docs")) {
    return partialHandoffAction(result, "sync-docs", dependencies);
  }
  if (result.stage === "verify.run" && allowed.has("hy_exam_submit")) {
    const examId = typeof record.examId === "string" ? record.examId : undefined;
    return partialHandoffAction(
      result,
      "exam-submit",
      dependencies,
      examId ? { examId } : {},
      [
        ...(examId ? [] : [inputRequirement("examId", "string", "external_result", { minLength: 1 })]),
        inputRequirement("results", "array", "external_result"),
      ],
    );
  }
  if (result.stage === "verify.amendment" && allowed.has("hy_amend_plan")) {
    return partialHandoffAction(result, "amend-plan", dependencies, decisionId ? { decisionId } : {}, [
      inputRequirement("approved", "enum", "human_decision", {
        values: result.userAction?.options,
        decisionId,
      }),
    ]);
  }
  if (result.stage.startsWith("commit.") && allowed.has("hy_commit")) {
    return partialHandoffAction(result, "commit", dependencies, {}, [
      inputRequirement("title", "string", "skill_synthesis", { minLength: 1 }),
      inputRequirement("body", "string", "skill_synthesis"),
    ]);
  }
  return routeAction(result.nextAction, dependencies);
}
