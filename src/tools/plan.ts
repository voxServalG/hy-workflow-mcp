import { planDecisionId, readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";
import { normalizePlanDoc, validatePlanScopePaths } from "../plan_validation.js";

export async function handlePlan(args: { task: string; plan?: PlanDoc | unknown }): Promise<ToolResult> {
  const state = readState();

  assertPhase(state, "plan");

  const task = (args.task ?? "").trim();
  if (!task) {
    return toolResult("plan", {
      error: "task must be a non-empty string describing the work to be done.",
      allowedTools: ["hy_plan", "hy_status"],
    });
  }

  const beforePlan = state.documentReads?.beforePlan;
  if (!beforePlan) {
    return toolResult("plan", {
      error: "before_plan document baseline is required before hy_plan.",
      stage: "plan.before_plan",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
      nextAction: {
        tool: "hy_read_docs",
        arguments: { stage: "before_plan", task },
        phase: "plan",
        stage: "plan.before_plan",
        automatic: true,
      },
      control: { automatic: true, stop: false, reason: "repair_required" },
      userAction: null,
    });
  }
  const beforePlanTaskMismatch = beforePlan.task !== task;

  const rawPlan = args.plan;
  if (!rawPlan) {
    return toolResult("plan", {
      error: "PlanDoc is required.",
      allowedTools: ["hy_plan", "hy_status"],
      schema: {
        type: "object",
        required: ["task", "scope", "boundary", "verify", "risks", "discussion"],
        properties: {
          task: { type: "string" },
          scope: {
            type: "object",
            required: ["changes", "new_files", "delete"],
            additionalProperties: false,
            properties: {
              changes: { type: "array", items: { type: "string" } },
              new_files: { type: "array", items: { type: "string" } },
              delete: { type: "array", items: { type: "string" } },
            },
          },
          boundary: {
            type: "object",
            required: ["dependency_dag", "entry_points", "no_new_external"],
            additionalProperties: false,
            properties: {
              dependency_dag: { type: "string" },
              entry_points: { type: "array", items: { type: "string" } },
              no_new_external: { type: "boolean" },
            },
          },
          verify: {
            type: "object",
            required: ["platform", "smoke", "tests"],
            additionalProperties: false,
            properties: {
              platform: {
                type: "object",
                required: ["python_version", "setup"],
                additionalProperties: false,
                properties: {
                  python_version: { type: "string" },
                  setup: { type: "array", items: { type: "string" } },
                },
              },
              smoke: {
                type: "array",
                items: {
                  type: "object",
                  required: ["command", "expected_exit", "description"],
                  additionalProperties: false,
                  properties: {
                    command: { type: "string" },
                    expected_exit: { type: "number" },
                    description: { type: "string" },
                  },
                },
              },
              tests: {
                type: "array",
                items: {
                  type: "object",
                  required: ["command", "expected_exit", "description"],
                  additionalProperties: false,
                  properties: {
                    command: { type: "string" },
                    expected_exit: { type: "number" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          risks: { type: "array", items: { type: "string" } },
          discussion: { type: "string" },
        },
      },
    });
  }

  const normalizedPlan = normalizePlanDoc(rawPlan);
  if (!normalizedPlan.ok) {
    return toolResult("plan", {
      error: `PlanDoc has invalid shape: ${normalizedPlan.errors.join("; ")}`,
      allowedTools: ["hy_plan", "hy_status"],
    });
  }

  const p = normalizedPlan.plan;

  // Gate 1: required top-level fields
  if (!p.task || !p.scope || !p.boundary || !p.verify || !p.risks || p.discussion === undefined) {
    return toolResult("plan", { error: "PlanDoc missing required fields: task, scope, boundary, verify, risks, discussion.", allowedTools: ["hy_plan", "hy_status"] });
  }

  // Gate 2: scope not all-empty
  const hasChanges = (p.scope.changes?.length ?? 0) > 0;
  const hasNew = (p.scope.new_files?.length ?? 0) > 0;
  const hasDelete = (p.scope.delete?.length ?? 0) > 0;
  if (!hasChanges && !hasNew && !hasDelete) {
    return toolResult("plan", { error: "PlanDoc scope is empty. At least one of changes, new_files, or delete must be non-empty.", allowedTools: ["hy_plan", "hy_status"] });
  }

  const scopePathErrors = validatePlanScopePaths(projectRoot(), p);
  if (scopePathErrors.length) {
    return toolResult("plan", {
      error: `PlanDoc scope contains invalid paths: ${scopePathErrors.join("; ")}.`,
      allowedTools: ["hy_plan", "hy_status"],
    });
  }

  // Gate 3: boundary has substance
  if (!p.boundary.dependency_dag) {
    return toolResult("plan", { error: "PlanDoc boundary.dependency_dag is empty.", allowedTools: ["hy_plan", "hy_status"] });
  }
  if (!p.boundary.entry_points?.length) {
    return toolResult("plan", { error: "PlanDoc boundary.entry_points must contain at least 1 command.", allowedTools: ["hy_plan", "hy_status"] });
  }

  // Gate 4: verify has substance
  if (!p.verify.platform?.python_version) {
    return toolResult("plan", { error: "PlanDoc verify.platform.python_version is empty.", allowedTools: ["hy_plan", "hy_status"] });
  }
  if (!p.verify.smoke?.length) {
    return toolResult("plan", { error: "PlanDoc verify.smoke must contain at least 1 check.", allowedTools: ["hy_plan", "hy_status"] });
  }
  if (!p.verify.tests?.length) {
    return toolResult("plan", { error: "PlanDoc verify.tests must contain at least 1 check.", allowedTools: ["hy_plan", "hy_status"] });
  }

  // Gate 5: risks & discussion non-empty
  if (!p.risks.length) {
    return toolResult("plan", { error: "PlanDoc risks must contain at least 1 risk.", allowedTools: ["hy_plan", "hy_status"] });
  }
  if (p.discussion === "") {
    return toolResult("plan", { error: "PlanDoc discussion is empty.", allowedTools: ["hy_plan", "hy_status"] });
  }

  // Gate 6: hollow command check
  const hollow = new Set(["echo ok","echo \"ok\"","echo 'ok'","echo test","echo \"test\"","echo 'test'"]);
  const EXECUTABLE_PREFIXES = new Set([
    "sh","bash","node","npx","npm","yarn","pnpm","bun","deno","tsx","tsc","jest","vitest",
    "python","python3","py","pip","pip3","pytest","tox","mypy","ruff","black","uv",
    "cargo","rustc","go","gofmt","gcc","g++","make","cmake","java","mvn","gradle",
    "git","gh","docker","curl","wget",
  ]);
  const hasExecutable = (cmd: string): boolean => {
    const firstWord = cmd.trim().split(/\s+/)[0];
    return EXECUTABLE_PREFIXES.has(firstWord) || cmd.includes("/") || cmd.includes("\\");
  };
  const describeImpureCommand = (cmd: string): string | null => {
    const trimmed = cmd.trim();
    if (/^.+[（(][^)）]+[)）]$/.test(trimmed)) {
      return "contains parenthetical explanation";
    }
    if (/^[\p{L}\p{N}_ -]{1,40}[:：]\s+\S/u.test(trimmed) && !hasExecutable(trimmed)) {
      return "looks like a colon-prefixed description";
    }
    if (!hasExecutable(trimmed)) {
      return "does not start with a recognized executable";
    }
    return null;
  };
  const rejectImpureCommand = (field: string, cmd: string): ToolResult | null => {
    const reason = describeImpureCommand(cmd);
    if (!reason) return null;
    return toolResult("plan", {
      error: `${field} must be a pure executable shell command; "${cmd}" ${reason}.`,
      allowedTools: ["hy_plan", "hy_status"],
    });
  };

  for (const ep of p.boundary.entry_points) {
    if (hollow.has(ep.trim())) {
      return toolResult("plan", { error: `boundary.entry_points contains hollow command: "${ep}". Use real executable commands.`, allowedTools: ["hy_plan", "hy_status"] });
    }
    const rejected = rejectImpureCommand("boundary.entry_points", ep);
    if (rejected) return rejected;
  }
  for (const s of p.verify.smoke) {
    if (hollow.has(s.command.trim())) {
      return toolResult("plan", { error: `verify.smoke contains hollow command: "${s.command}". Use real executable commands.`, allowedTools: ["hy_plan", "hy_status"] });
    }
    const rejected = rejectImpureCommand("verify.smoke.command", s.command);
    if (rejected) return rejected;
  }
  for (const t of p.verify.tests) {
    if (hollow.has(t.command.trim())) {
      return toolResult("plan", { error: `verify.tests contains hollow command: "${t.command}". Use real executable commands.`, allowedTools: ["hy_plan", "hy_status"] });
    }
    const rejected = rejectImpureCommand("verify.tests.command", t.command);
    if (rejected) return rejected;
  }

  // Gate 7: semantic quality facts (soft; never block)
  const warnings: Array<Record<string, unknown>> = [];
  if (beforePlanTaskMismatch) {
    warnings.push({
      code: "BEFORE_PLAN_TASK_MISMATCH",
      beforePlanTask: beforePlan.task,
      planTask: task,
    });
  }
  if (p.task.length < 20) {
    warnings.push({ code: "TASK_TOO_SHORT", field: "task", actualLength: p.task.length, minLength: 20 });
  }
  p.risks.forEach((risk, index) => {
    if (risk.length < 20) {
      warnings.push({
        code: "RISK_TOO_SHORT",
        field: `risks[${index}]`,
        actualLength: risk.length,
        minLength: 20,
      });
    }
  });
  if (p.discussion.length < 50) {
    warnings.push({
      code: "DISCUSSION_TOO_SHORT",
      field: "discussion",
      actualLength: p.discussion.length,
      minLength: 50,
    });
  }

  const next = transition(state, "approve");
  next.plan = p;
  // A new PlanDoc is a new material intent. Historical approval must never
  // leak into the new decision even if state was recovered unusually.
  next.approval = null;
  next.pendingApproval = null;
  next.documentReads = {
    ...(state.documentReads ?? {}),
    beforeApprove: null,
    afterEdit: null,
  };
  next.syncDocs = null;
  next.mergeReceipt = null;
  writeState(next);

  const decisionId = planDecisionId(p)!;
  return toolResult("approve", {
    plan: p,
    warnings: warnings.length ? warnings : undefined,
    requires_user: true,
    stop_here: true,
    stage: "approve.decision",
    status: "pending",
    decisionId,
    allowedTools: ["hy_read_docs", "hy_approve", "hy_status"],
    blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"],
    nextAction: { tool: null, phase: "approve", stage: "approve.decision", automatic: false },
    control: { automatic: false, stop: true, reason: "approval_required" },
    userAction: {
      kind: "approval",
      decisionId,
      options: ["approve", "reject", "revise"],
    },
  });
}
