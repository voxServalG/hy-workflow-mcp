import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";

function buildSummary(p: PlanDoc): string {
  const lines: string[] = [];
  lines.push(`## Plan: ${p.task}`);
  lines.push("");
  lines.push("### Scope");
  if (p.scope.changes.length) {
    lines.push("**Changes:**");
    p.scope.changes.forEach(f => lines.push(`- \`${f}\``));
  }
  if (p.scope.new_files.length) {
    lines.push("**New files:**");
    p.scope.new_files.forEach(f => lines.push(`- \`${f}\``));
  }
  if (p.scope.delete.length) {
    lines.push("**Delete:**");
    p.scope.delete.forEach(f => lines.push(`- \`${f}\``));
  }
  lines.push("");
  lines.push("### Boundary");
  lines.push(`- Dependency DAG: ${p.boundary.dependency_dag}`);
  lines.push(`- Entry points:`);
  p.boundary.entry_points.forEach(ep => lines.push(`  - \`${ep}\``));
  lines.push(`- No new external deps: ${p.boundary.no_new_external}`);
  lines.push("");
  lines.push("### Verify");
  lines.push(`- Platform: Python ${p.verify.platform.python_version}`);
  if (p.verify.platform.setup.length) {
    p.verify.platform.setup.forEach(s => lines.push(`  - \`${s}\``));
  }
  lines.push(`- Smoke checks (${p.verify.smoke.length}):`);
  p.verify.smoke.forEach(s => lines.push(`  - \`${s.command}\` → exit ${s.expected_exit}: ${s.description}`));
  lines.push(`- Tests (${p.verify.tests.length}):`);
  p.verify.tests.forEach(t => lines.push(`  - \`${t.command}\` → exit ${t.expected_exit}: ${t.description}`));
  lines.push("");
  lines.push("### Risks");
  p.risks.forEach(r => lines.push(`- ${r}`));
  lines.push("");
  lines.push("### Discussion");
  lines.push(p.discussion);
  return lines.join("\n");
}

export async function handlePlan(args: { task: string; plan?: PlanDoc }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "plan");

  const task = (args.task ?? "").trim();
  if (!task) {
    return { next: "plan", error: "task must be a non-empty string describing the work to be done." };
  }

  const p = args.plan;
  if (!p) {
    return {
      next: "plan",
      error: "PlanDoc not provided. You must construct the PlanDoc JSON yourself using your workspace knowledge, then call hy_plan with {task, plan}.",
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
    };
  }

  // Gate 1: required top-level fields
  if (!p.task || !p.scope || !p.boundary || !p.verify || !p.risks || p.discussion === undefined) {
    return { next: "plan", error: "PlanDoc missing required fields: task, scope, boundary, verify, risks, discussion." };
  }

  // Gate 2: scope not all-empty
  const hasChanges = (p.scope.changes?.length ?? 0) > 0;
  const hasNew = (p.scope.new_files?.length ?? 0) > 0;
  const hasDelete = (p.scope.delete?.length ?? 0) > 0;
  if (!hasChanges && !hasNew && !hasDelete) {
    return { next: "plan", error: "PlanDoc scope is empty. At least one of changes, new_files, or delete must be non-empty." };
  }

  // Gate 3: boundary has substance
  if (!p.boundary.dependency_dag) {
    return { next: "plan", error: "PlanDoc boundary.dependency_dag is empty." };
  }
  if (!p.boundary.entry_points?.length) {
    return { next: "plan", error: "PlanDoc boundary.entry_points must contain at least 1 command." };
  }

  // Gate 4: verify has substance
  if (!p.verify.platform?.python_version) {
    return { next: "plan", error: "PlanDoc verify.platform.python_version is empty." };
  }
  if (!p.verify.smoke?.length) {
    return { next: "plan", error: "PlanDoc verify.smoke must contain at least 1 check." };
  }
  if (!p.verify.tests?.length) {
    return { next: "plan", error: "PlanDoc verify.tests must contain at least 1 check." };
  }

  // Gate 5: risks & discussion non-empty
  if (!p.risks.length) {
    return { next: "plan", error: "PlanDoc risks must contain at least 1 risk." };
  }
  if (p.discussion === "") {
    return { next: "plan", error: "PlanDoc discussion is empty." };
  }

  // Gate 6: hollow command check
  const hollow = new Set(["echo ok","echo \"ok\"","echo 'ok'","echo test","echo \"test\"","echo 'test'"]);
  const EXECUTABLE_PREFIXES = new Set([
    "sh","bash","node","npx","npm","yarn","pnpm","bun","deno","tsx","tsc","jest","vitest",
    "python","python3","py","pip","pip3","pytest","tox","mypy","ruff","black",
    "cargo","rustc","go","gofmt","gcc","g++","make","cmake","java","mvn","gradle",
    "git","gh","docker","curl","wget",
  ]);
  const hasExecutable = (cmd: string): boolean => {
    const firstWord = cmd.trim().split(/\s+/)[0];
    return EXECUTABLE_PREFIXES.has(firstWord) || cmd.includes("/") || cmd.includes("\\");
  };

  for (const ep of p.boundary.entry_points) {
    if (hollow.has(ep.trim())) {
      return { next: "plan", error: `boundary.entry_points contains hollow command: "${ep}". Use real executable commands.` };
    }
  }
  for (const s of p.verify.smoke) {
    if (hollow.has(s.command.trim())) {
      return { next: "plan", error: `verify.smoke contains hollow command: "${s.command}". Use real executable commands.` };
    }
    if (!hasExecutable(s.command)) {
      return { next: "plan", error: `verify.smoke command "${s.command}" is not executable. Use a recognized command prefix (npx, node, python, etc).` };
    }
  }
  for (const t of p.verify.tests) {
    if (hollow.has(t.command.trim())) {
      return { next: "plan", error: `verify.tests contains hollow command: "${t.command}". Use real executable commands.` };
    }
    if (!hasExecutable(t.command)) {
      return { next: "plan", error: `verify.tests command "${t.command}" is not executable. Use a recognized command prefix (npx, node, python, etc).` };
    }
  }

  const next = transition(state, "plan");
  next.phase = "plan";
  next.plan = p;
  writeState(next);

  return {
    next: "approve",
    plan: p,
    summary: buildSummary(p),
    message: "PlanDoc validated. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
  };
}
