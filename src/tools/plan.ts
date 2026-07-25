import * as path from "node:path";
import { readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";
import { normalizePlanDoc, validatePlanScopePaths } from "../plan_validation.js";
import { REQUIRED_SECTIONS } from "../output/contract.js";

type CheckItem = PlanDoc["verify"]["smoke"][number];
type TestCategory = {
  title: string;
  explanation: string;
  checks: CheckItem[];
};

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function pathReason(path: string, action: "change" | "new" | "delete"): string {
  if (path.startsWith("src/")) return action === "delete" ? "移除不再需要的源码入口" : "调整运行时代码行为";
  if (path.startsWith("dist/")) return action === "delete" ? "移除对应编译产物" : "同步发布用编译产物";
  if (path.startsWith("test/") || path.startsWith("tests/")) return action === "delete" ? "移除不再适用的测试" : "更新验证覆盖";
  if (path.startsWith("docs/")) return action === "delete" ? "移除过期文档" : "同步用户和 agent 可读说明";
  if (path === "README.md") return action === "delete" ? "移除入口说明" : "同步项目入口说明";
  if (action === "new") return "新增本次任务需要的文件";
  if (action === "delete") return "删除本次任务不再需要的文件";
  return "更新本次任务涉及的文件";
}

function addPathList(lines: string[], paths: string[], action: "change" | "new" | "delete"): void {
  if (!paths.length) {
    lines.push("- 无");
    return;
  }
  for (const path of paths) {
    lines.push(`- \`${path}\`: ${pathReason(path, action)}`);
  }
}

function classifyChecks(smoke: CheckItem[], tests: CheckItem[]): TestCategory[] {
  const categories: TestCategory[] = [
    {
      title: "单元测试 (Unit Test)",
      explanation: "开发人员编写并执行，测试代码中的最小模块或函数。",
      checks: [],
    },
    {
      title: "集成测试 (Integration Test)",
      explanation: "在单元测试后进行，检查多个模块组合在一起时的数据交互和接口是否正常。",
      checks: [],
    },
    {
      title: "系统测试 (System Test)",
      explanation: "将整个系统作为一个整体，进行功能、性能、安全及兼容性测试。",
      checks: [],
    },
    {
      title: "验收测试 (Acceptance Test)",
      explanation: "业务方或最终用户介入，验证系统是否满足实际需求。",
      checks: [],
    },
  ];

  const assign = (check: CheckItem, fallback: number) => {
    const text = `${check.command} ${check.description}`.toLowerCase();
    if (/acceptance|验收|user|用户/.test(text)) categories[3].checks.push(check);
    else if (/integration|集成|e2e|端到端/.test(text)) categories[1].checks.push(check);
    else if (/system|系统|dist|doclint|codelint|build|compile|tsc|lint/.test(text)) categories[2].checks.push(check);
    else if (/unit|单元|vitest|jest|test|tsx/.test(text)) categories[0].checks.push(check);
    else categories[fallback].checks.push(check);
  };

  smoke.forEach(check => assign(check, 2));
  tests.forEach(check => assign(check, 0));

  return categories;
}

function addCheck(lines: string[], check: CheckItem): void {
  lines.push(`- command: \`${check.command}\``);
  lines.push(`  thing to test: ${check.description}`);
  lines.push(`  expectation: exit ${check.expected_exit}`);
}

function cleanSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return /[。.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

function extractTitle(task: string): { title: string; why: string } {
  const arrow = task.indexOf("→");
  if (arrow > 0) {
    const t = cleanSentence(task.slice(0, arrow)).trim();
    const w = cleanSentence(task.slice(arrow + 1)).trim();
    if (t.length >= 6) return { title: t, why: w };
  }
  const dot = task.indexOf("。");
  if (dot > 10) return { title: cleanSentence(task.slice(0, dot)), why: cleanSentence(task.slice(dot + 1)) };
  return { title: cleanSentence(task).slice(0, 120), why: "" };
}

function pathKind(p: string): string {
  if (p.startsWith("src/")) return "代码";
  if (p.startsWith("test/") || p.startsWith("tests/")) return "测试";
  if (p.startsWith("docs/") || p === "README.md") return "文档";
  return "其他";
}

function addPathGroups(lines: string[], paths: string[], _action: string): void {
  if (!paths.length) { lines.push("- 无"); return; }
  const groups = new Map<string, string[]>();
  for (const f of paths) {
    const dir = path.dirname(f) + "/";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(path.basename(f));
  }
  for (const [dir, files] of groups) {
    lines.push(`- ${pathKind(paths[0])} (${dir}): ${files.join(", ")}`);
  }
}

function buildSummary(p: PlanDoc): string {
  const lines: string[] = [];
  const { title, why } = extractTitle(p.task);
  lines.push(`## ${title}`);
  lines.push("");
  const whyText = why || cleanSentence(p.task).slice(0, 200);
  if (whyText) { lines.push(`> **为什么**: ${whyText}`); lines.push(""); }
  lines.push("### 改动");
  addPathGroups(lines, p.scope.changes, "change");
  addPathGroups(lines, p.scope.new_files, "new");
  addPathGroups(lines, p.scope.delete, "delete");
  lines.push("");
  const dag = p.boundary.dependency_dag;
  lines.push(`> **影响**: ${dag.length > 120 ? dag.slice(0, 120) + "..." : dag}`);
  lines.push("");
  lines.push("### 验证");
  for (const ep of p.boundary.entry_points) lines.push(`- [ ] \`${ep}\``);
  lines.push("");
  if (p.risks.length) {
    lines.push("### 风险");
    for (const r of p.risks) lines.push(`- ${r.length > 200 ? r.slice(0, 200) + "..." : r}`);
    lines.push("");
  }
  if (p.discussion.length) {
    lines.push("<details>");
    lines.push("<summary>讨论 + 备选方案</summary>");
    lines.push("");
    lines.push(p.discussion);
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n").trimEnd();
}

export async function handlePlan(args: { task: string; plan?: PlanDoc | unknown }): Promise<ToolResult> {
  const state = readState();

  // Auto-reset from terminal phases: clear derived state so the new task starts fresh.
  if (state.phase === "done" || state.phase === "merge" || state.phase === "commit") {
    state.phase = "plan";
    state.branch = null;
    state.prNumber = null;
    state.plan = null;
    state.approval = null;
    state.verifyHash = null;
    state.verifiedImplementationDigest = null;
    state.verifiedManifestHash = null;
    state.pendingAmendment = null;
    state.implementationManifest = null;
    state.documentReads = null;
    state.syncDocs = null;
    writeState(state);
  }

  assertPhase(state, "plan");

  const task = (args.task ?? "").trim();
  if (!task) {
    return toolResult("plan", {
      error: "task must be a non-empty string describing the work to be done.",
      hint: "Provide a concrete task and construct a PlanDoc before calling hy_plan again.",
      allowedTools: ["hy_plan", "hy_status"],
    });
  }

  const beforePlan = state.documentReads?.beforePlan;
  if (!beforePlan) {
    return toolResult("plan", {
      error: "before_plan document baseline is required before hy_plan.",
      hint: `Call hy_read_docs with { stage: "before_plan", task } first. This is an automatic agent context step, not a user review gate.`,
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    });
  }
  const beforePlanTaskMismatch = beforePlan.task !== task;

  const rawPlan = args.plan;
  if (!rawPlan) {
    return toolResult("plan", {
      error: "PlanDoc not provided. You must construct the PlanDoc JSON yourself using your workspace knowledge, then call hy_plan with {task, plan}.",
      hint: "Read project files, build a complete PlanDoc, and retry hy_plan.",
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
      hint: "Construct a complete PlanDoc object with string fields and array fields that match the schema, then call hy_plan again.",
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
      error: `PlanDoc scope paths must stay inside the project root, and scope.changes/scope.delete paths must already exist before approval: ${scopePathErrors.join("; ")}. Put planned creations in scope.new_files.`,
      hint: "Confirm each existing-file path with Read/Glob before hy_plan. Keep files that will be created in scope.new_files, but still use project-relative paths under the repository root.",
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
      error: `${field} must be a pure executable shell command, but "${cmd}" ${reason}. Put explanations in description and write an executable command only.`,
      hint: "Keep command fields as pure shell commands and move explanations into description fields.",
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

  // Gate 7: semantic quality (soft — warnings only, do not block)
  const warnings: string[] = [];
  if (beforePlanTaskMismatch) {
    warnings.push(`before_plan task differs from hy_plan task; using the existing document baseline. before_plan="${beforePlan.task}", hy_plan="${task}"`);
  }
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
  next.documentReads = {
    ...(state.documentReads ?? {}),
    beforeApprove: null,
    afterEdit: null,
  };
  next.syncDocs = null;
  writeState(next);

  const summary = buildSummary(p);
  return toolResult("approve", {
    plan: p,
    summary,
    warnings: warnings.length ? warnings : undefined,
    display: {
      title: "Plan ready for approval",
      body: summary,
      requiredSections: [...REQUIRED_SECTIONS],
    },
    requires_user: true,
    stop_here: true,
    hint: "You MUST display the ENTIRE display.body to the user, matching ALL requiredSections anchors in order. Do not skip any section. Wait for explicit approval before calling hy_approve.",
    allowedTools: ["hy_read_docs", "hy_approve", "hy_status"],
    blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    recovery: {
      tool: "hy_plan",
      instruction: "If the user rejects the plan, revise the PlanDoc and call hy_plan again.",
    },
    message: "PlanDoc validated. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
  });
}
