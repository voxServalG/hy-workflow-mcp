import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";
import { execSync } from "node:child_process";
import { generatePlanDoc } from "../llm.js";

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

export async function handlePlan(args: { task: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "plan");

  const task = (args.task ?? "").trim();
  if (!task) {
    return { next: "plan", error: "task must be a non-empty string describing the work to be done." };
  }

  // Run garden-scan to get project baseline
  let context = "";
  try {
    context = execSync("npx --yes docs-gardener garden-scan", {
      encoding: "utf-8", timeout: 30_000, stdio: ["pipe","pipe","pipe"]
    });
  } catch {
    context = "{}";
  }

  let p: PlanDoc;

  // Attempt API-based PlanDoc generation
  const result = await generatePlanDoc(task, context);

  if (!result.ok) {
    // API failed — return error with schema, ask LLM to construct manually
    return {
      next: "plan",
      error: `PlanDoc generation failed: ${result.error}`,
      fallback: {
        message: "Construct PlanDoc manually and pass it with the 'plan' field.",
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
      },
    };
  }

  p = result.plan;

  // ── Gate 1: required top-level fields ──────────────────────
  if (!p.task || !p.scope || !p.boundary || !p.verify || !p.risks || p.discussion === undefined) {
    return { next: "plan", error: "API output missing required fields: task, scope, boundary, verify, risks, discussion. Retry with a more specific task description." };
  }

  // ── Gate 2: scope not all-empty ─────────────────────────────
  const hasChanges = (p.scope.changes?.length ?? 0) > 0;
  const hasNew = (p.scope.new_files?.length ?? 0) > 0;
  const hasDelete = (p.scope.delete?.length ?? 0) > 0;
  if (!hasChanges && !hasNew && !hasDelete) {
    return { next: "plan", error: "API generated empty scope. Retry with a more specific task description." };
  }

  // ── Gate 3: boundary has substance ──────────────────────────
  if (!p.boundary.dependency_dag) {
    return { next: "plan", error: "API generated empty dependency_dag. Retry." };
  }
  if (!p.boundary.entry_points?.length) {
    return { next: "plan", error: "API generated empty entry_points. Retry." };
  }

  // ── Gate 4: verify has substance ────────────────────────────
  if (!p.verify.platform?.python_version) {
    return { next: "plan", error: "API generated empty python_version. Retry." };
  }
  if (!p.verify.smoke?.length) {
    return { next: "plan", error: "API generated empty smoke checks. Retry." };
  }
  if (!p.verify.tests?.length) {
    return { next: "plan", error: "API generated empty tests. Retry." };
  }

  // ── Gate 5: risks & discussion non-empty ────────────────────
  if (!p.risks.length) {
    return { next: "plan", error: "API generated empty risks. Retry." };
  }
  if (p.discussion === "") {
    return { next: "plan", error: "API generated empty discussion. Retry." };
  }

  // ── Gate 6: hollow command check ────────────────────────────
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
      return { next: "plan", error: `API generated hollow entry_point: "${ep}". Retry.` };
    }
  }
  for (const s of p.verify.smoke) {
    if (hollow.has(s.command.trim())) {
      return { next: "plan", error: `API generated hollow smoke command: "${s.command}". Retry.` };
    }
    if (!hasExecutable(s.command)) {
      return { next: "plan", error: `API generated non-executable smoke command: "${s.command}". Retry.` };
    }
  }
  for (const t of p.verify.tests) {
    if (hollow.has(t.command.trim())) {
      return { next: "plan", error: `API generated hollow test command: "${t.command}". Retry.` };
    }
    if (!hasExecutable(t.command)) {
      return { next: "plan", error: `API generated non-executable test command: "${t.command}". Retry.` };
    }
  }

  // ── Gate 7: command availability check (soft warning) ──────
  let projectScripts: string[] = [];
  try {
    const pkgJson = JSON.parse(execSync("cat package.json", { encoding: "utf-8", timeout: 5_000 }));
    projectScripts = Object.keys(pkgJson.scripts ?? {});
  } catch {}

  const KNOWN_RUNNERS = new Set([
    ...EXECUTABLE_PREFIXES,
    ...projectScripts.map(s => `npm run ${s}`),
    ...projectScripts.map(s => `npx --yes ${s}`),
  ]);

  const unvalidated: string[] = [];
  for (const ep of p.boundary.entry_points) {
    const w = ep.trim().split(/\s+/)[0];
    const full = ep.trim();
    const inWhitelist = EXECUTABLE_PREFIXES.has(w) || projectScripts.includes(w) ||
      KNOWN_RUNNERS.has(full) || full.includes("/") || full.includes("\\");
    if (!inWhitelist) unvalidated.push(ep.trim());
  }
  for (const s of p.verify.smoke) {
    const w = s.command.trim().split(/\s+/)[0];
    const full = s.command.trim();
    const inWhitelist = EXECUTABLE_PREFIXES.has(w) || projectScripts.includes(w) ||
      KNOWN_RUNNERS.has(full) || full.includes("/") || full.includes("\\");
    if (!inWhitelist) unvalidated.push(s.command.trim());
  }
  for (const t of p.verify.tests) {
    const w = t.command.trim().split(/\s+/)[0];
    const full = t.command.trim();
    const inWhitelist = EXECUTABLE_PREFIXES.has(w) || projectScripts.includes(w) ||
      KNOWN_RUNNERS.has(full) || full.includes("/") || full.includes("\\");
    if (!inWhitelist) unvalidated.push(t.command.trim());
  }

  const next = transition(state, "plan");
  next.phase = "plan";
  next.plan = p;
  writeState(next);

  const resultObj: any = {
    next: "approve",
    plan: p,
    summary: buildSummary(p),
    message: "PlanDoc generated via DeepSeek API. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
    source: "api",
  };

  if (unvalidated.length) {
    resultObj.warnings = {
      gate7: `Some commands may not be available in this project: ${unvalidated.join(", ")}`,
      note: "These are soft warnings. The plan will still proceed but these commands should be verified.",
    };
  }

  return resultObj;
}
