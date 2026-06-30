import { readState, writeState, transition, assertPhase } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";

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

function allScopePaths(p: PlanDoc): string[] {
  return [...p.scope.new_files, ...p.scope.changes, ...p.scope.delete];
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function inlineCodeList(items: string[], max = 4): string {
  const shown = items.slice(0, max).map(item => `\`${item}\``).join("、");
  return items.length > max ? `${shown} 等 ${items.length} 项` : shown;
}

function pathKind(path: string): "runtime" | "test" | "docs" | "config" | "artifact" | "other" {
  if (path.startsWith("src/")) return "runtime";
  if (path.startsWith("test/") || path.startsWith("tests/")) return "test";
  if (path.startsWith("docs/") || path === "README.md") return "docs";
  if (path.startsWith("dist/")) return "artifact";
  if (path.startsWith(".github/") || path === "setup" || path === "setup.ps1" || path === "package.json" || path === "hy-workflow.json" || path === ".gitignore") return "config";
  return "other";
}

function describeScopeEffect(p: PlanDoc): string {
  const kinds = new Set(allScopePaths(p).map(pathKind));
  const has = (kind: ReturnType<typeof pathKind>) => kinds.has(kind);
  let effect: string;

  if (has("runtime") && has("test") && has("docs")) {
    effect = "运行时代码、测试覆盖和文档说明会保持一致，用户可见行为、回归验证和公开契约同步更新";
  } else if (has("runtime") && has("test")) {
    effect = "运行时代码会体现本次行为变化，并由测试覆盖对应回归场景";
  } else if (has("runtime") && has("docs")) {
    effect = "运行时代码和用户可读说明会同步更新，公开契约反映新的行为边界";
  } else if (has("runtime")) {
    effect = "运行时代码会体现本次计划声明的行为变化";
  } else if (has("docs") && has("test")) {
    effect = "文档契约和验证覆盖会同步更新，后续变更能被测试守住";
  } else if (has("docs")) {
    effect = "文档体系会呈现本次计划声明的信息结构和用户可读说明，代码行为保持不变";
  } else if (has("test")) {
    effect = "测试体系会覆盖本次计划声明的验证场景，生产代码行为保持不变";
  } else if (has("config")) {
    effect = "项目配置、入口或自动化契约会反映本次计划声明的运行边界";
  } else if (has("artifact")) {
    effect = "发布或构建产物会与本次计划声明的分发边界保持一致";
  } else {
    effect = "计划 scope 内的项目文件会达到本次任务声明的目标状态";
  }

  if (p.scope.delete.length) {
    effect += "，计划删除项会从项目中移除";
  }
  return effect;
}

function describeVerificationState(p: PlanDoc): string {
  const commands = unique([...p.verify.smoke, ...p.verify.tests].map(check => check.command));
  if (!commands.length) return "验证通过时，计划声明的检查应证明该项目状态成立。";
  return `验证通过时，${inlineCodeList(commands, 3)} 均应 exit 0，证明该项目状态成立。`;
}

function buildExpectedState(p: PlanDoc): string {
  const paths = unique(allScopePaths(p));
  const keyPaths = paths.length ? inlineCodeList(paths, 4) : "PlanDoc 声明的 scope";
  return [
    `计划应用后，项目应满足：${cleanSentence(p.task)}`,
    `${describeScopeEffect(p)}。`,
    `主要落点：${keyPaths}。`,
    `边界状态：${cleanSentence(p.boundary.dependency_dag)}`,
    describeVerificationState(p),
  ].join(" ");
}

function buildSummary(p: PlanDoc): string {
  const lines: string[] = [];
  lines.push("## Plan");
  lines.push("");
  lines.push(`**现在状态**: ${p.task}`);
  lines.push("");
  lines.push(`**期望状态**: ${buildExpectedState(p)}`);
  lines.push("");

  lines.push("### Scope");
  lines.push(`**将要增加** (${plural(p.scope.new_files.length, "file")}):`);
  addPathList(lines, p.scope.new_files, "new");
  lines.push("");
  lines.push(`**将要改动** (${plural(p.scope.changes.length, "file")}):`);
  addPathList(lines, p.scope.changes, "change");
  lines.push("");
  lines.push(`**将要删除** (${plural(p.scope.delete.length, "file")}):`);
  addPathList(lines, p.scope.delete, "delete");

  lines.push("");
  lines.push("### Boundary");
  lines.push(`**影响范围**: ${p.boundary.dependency_dag}`);
  lines.push("");
  lines.push(`**外部依赖**: ${p.boundary.no_new_external ? "本次不会新增外部依赖。" : "本次计划会新增或调整外部依赖，需要额外确认。"}`);
  lines.push("");
  lines.push("**关键检查入口**:");
  p.boundary.entry_points.forEach(ep => lines.push(`- \`${ep}\``));

  lines.push("");
  lines.push("### Verify");
  const plat = p.verify.platform;
  lines.push("**测试平台搭建**:");
  lines.push(`- Python version: ${plat.python_version}`);
  if (plat.setup.length) plat.setup.forEach(command => lines.push(`- command: \`${command}\``));
  else lines.push("- command: 无需额外搭建命令");
  for (const category of classifyChecks(p.verify.smoke, p.verify.tests)) {
    lines.push("");
    lines.push(`**${category.title}**: ${category.explanation}`);
    if (category.checks.length) category.checks.forEach(check => addCheck(lines, check));
    else lines.push("- 本次计划未声明这一层级的测试。");
  }

  lines.push("");
  lines.push("### Risks");
  p.risks.forEach(r => lines.push(`- ${r}`));

  lines.push("");
  lines.push("### Discussion");
  p.discussion.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean).forEach(paragraph => {
    lines.push(paragraph);
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

export async function handlePlan(args: { task: string; plan?: PlanDoc }): Promise<ToolResult> {
  const state = readState();
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

  const p = args.plan;
  if (!p) {
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
    },
    requires_user: true,
    stop_here: true,
    hint: "You MUST show display.body to the user and wait for explicit approval. After the user approves, call hy_read_docs with stage before_approve before hy_approve. Do not call hy_approve before the document audit exists.",
    allowedTools: ["hy_read_docs", "hy_approve", "hy_status"],
    blockedTools: ["hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    recovery: {
      tool: "hy_plan",
      instruction: "If the user rejects the plan, revise the PlanDoc and call hy_plan again.",
    },
    message: "PlanDoc validated. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
  });
}
