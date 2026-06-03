import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";

function buildSummary(p: PlanDoc): string {
  const lines: string[] = [];
  lines.push(`## Plan: ${p.task}`);
  lines.push("");

  lines.push("### Scope");
  const changes = p.scope.changes;
  lines.push(`- **Changes** (string[], ${changes.length} item${changes.length !== 1 ? "s" : ""}):`);
  if (changes.length) { changes.forEach(f => lines.push(`  - \`${f}\``)); }
  else { lines.push("  (none)"); }
  const newFiles = p.scope.new_files;
  lines.push(`- **New files** (string[], ${newFiles.length} item${newFiles.length !== 1 ? "s" : ""}):`);
  if (newFiles.length) { newFiles.forEach(f => lines.push(`  - \`${f}\``)); }
  else { lines.push("  (none)"); }
  const deleted = p.scope.delete;
  lines.push(`- **Delete** (string[], ${deleted.length} item${deleted.length !== 1 ? "s" : ""}):`);
  if (deleted.length) { deleted.forEach(f => lines.push(`  - \`${f}\``)); }
  else { lines.push("  (none)"); }

  lines.push("");
  lines.push("### Boundary");
  lines.push(`- **Dependency DAG:** ${p.boundary.dependency_dag}`);
  const eps = p.boundary.entry_points;
  lines.push(`- **Entry points** (string[], ${eps.length} item${eps.length !== 1 ? "s" : ""}):`);
  eps.forEach(ep => lines.push(`  - \`${ep}\``));
  lines.push(`- **No new external deps** (boolean): \`${p.boundary.no_new_external}\``);

  lines.push("");
  lines.push("### Verify");
  const plat = p.verify.platform;
  lines.push(`- **Platform:** Python ${plat.python_version}`);
  const setup = plat.setup;
  lines.push(`  - setup (string[], ${setup.length} item${setup.length !== 1 ? "s" : ""}): ${setup.map(s => `\`${s}\``).join(", ") || "(none)"}`);
  const smokes = p.verify.smoke;
  lines.push(`- **Smoke** (CheckItem[], ${smokes.length} check${smokes.length !== 1 ? "s" : ""}):`);
  smokes.forEach(s => lines.push(`  - \`${s.command}\` → exit ${s.expected_exit}: ${s.description}`));
  const tests = p.verify.tests;
  lines.push(`- **Tests** (CheckItem[], ${tests.length} check${tests.length !== 1 ? "s" : ""}):`);
  tests.forEach(t => lines.push(`  - \`${t.command}\` → exit ${t.expected_exit}: ${t.description}`));

  lines.push("");
  const risks = p.risks;
  lines.push(`### Risks (string[], ${risks.length} item${risks.length !== 1 ? "s" : ""})`);
  risks.forEach(r => lines.push(`- ${r}`));

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
    return {
      next: "plan",
      error: `${field} must be a pure executable shell command, but "${cmd}" ${reason}. Put explanations in description and write an executable command only.`,
    };
  };

  for (const ep of p.boundary.entry_points) {
    if (hollow.has(ep.trim())) {
      return { next: "plan", error: `boundary.entry_points contains hollow command: "${ep}". Use real executable commands.` };
    }
    const rejected = rejectImpureCommand("boundary.entry_points", ep);
    if (rejected) return rejected;
  }
  for (const s of p.verify.smoke) {
    if (hollow.has(s.command.trim())) {
      return { next: "plan", error: `verify.smoke contains hollow command: "${s.command}". Use real executable commands.` };
    }
    const rejected = rejectImpureCommand("verify.smoke.command", s.command);
    if (rejected) return rejected;
  }
  for (const t of p.verify.tests) {
    if (hollow.has(t.command.trim())) {
      return { next: "plan", error: `verify.tests contains hollow command: "${t.command}". Use real executable commands.` };
    }
    const rejected = rejectImpureCommand("verify.tests.command", t.command);
    if (rejected) return rejected;
  }

  // Gate 7: semantic quality (soft — warnings only, do not block)
  const warnings: string[] = [];
  if (p.task.length < 20) {
    warnings.push(`task 较简短 (${p.task.length} chars)，建议补充问题动机和上下文`);
  }
  for (const r of p.risks) {
    if (r.length < 20) {
      warnings.push(`risk "${r}" 过于简短 (${r.length} chars)，建议包含触发场景、影响和缓解措施`);
    }
  }
  if (p.discussion.length < 50) {
    warnings.push("discussion 建议说明备选方案及否定理由");
  }

  const next = transition(state, "approve");
  next.plan = p;
  writeState(next);

  return {
    next: "approve",
    plan: p,
    summary: buildSummary(p),
    warnings: warnings.length ? warnings : undefined,
    message: "PlanDoc validated. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
  };
}
