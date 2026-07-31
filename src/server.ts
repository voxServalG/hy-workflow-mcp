#!/usr/bin/env node

import "dotenv/config";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ― Tool handlers
import { handleInit } from "./tools/init.js";
import { handleReadDocs } from "./tools/read_docs.js";
import { handleSyncDocs } from "./tools/sync_docs.js";
import { handlePlan } from "./tools/plan.js";
import { handleApprove } from "./tools/approve.js";
import { handleBranch } from "./tools/branch.js";
import { handleEdit } from "./tools/edit.js";
import { handleVerify } from "./tools/verify.js";
import { handleAmendPlan } from "./tools/amend_plan.js";
import { handleExamPlan } from "./tools/exam-plan.js";
import { handleExamSubmit } from "./tools/exam-submit.js";
import { handleCommit } from "./tools/commit.js";
import { handleMerge } from "./tools/merge.js";
import { handleReset } from "./tools/reset.js";
import { handleStatus } from "./tools/status.js";
import { attachSetupCheck, checkSetupStamp, createSetupGate } from "./bootstrap.js";
import { configHelp, runConfigCli } from "./config.js";
import { assertCommandCatalogMatchesTools } from "./commands/catalog.js";
import { runContractLint } from "./contralint/run.js";
import { structuredError } from "./errs/structured.js";
import { toolResult } from "./output/envelope.js";
import { PACKAGE_VERSION } from "./package-meta.js";
import { runSetupCli } from "./setup-cli.js";
import { runDoctorCli } from "./setup/doctor.js";
import { runLintCli } from "./lint.js";
import { readState } from "./state.js";
import { DEFAULT_STAGE_BY_PHASE, type Phase, type WorkflowStage } from "./runtime/state-machine.js";

// ― System prompt injected via MCP
const SYSTEM_PROMPT = `
hy-workflow MCP 负责一个严格但低打扰的开发闭环。所有工具输入输出均为 JSON。

控制契约：
- phase 是持久化工作流状态。
- stage 是 phase 内部的当前步骤，例如 commit.ci 和 merge.sync。
- next 是兼容旧客户端的阶段字符串，不是主要控制面。
- nextAction、control 和 userAction 是 agent 的权威续行动作。
- 只有 userAction.kind=approval 才能要求用户批准。wait、review_failure、fix_configuration、authenticate 和 external_action 都不得被改写成 approve 请求。

正常路径：
hy_status → hy_read_docs(before_plan) → hy_plan → [用户决定] hy_approve → hy_read_docs(before_approve) → hy_approve(自动续跑) → hy_branch → hy_edit → [外置代码编辑] → hy_read_docs(after_edit) → [外置文档编辑] → hy_sync_docs → hy_verify → hy_commit → hy_merge → hy_reset。

hy_plan 必须完整展示 display.body 后等待一次计划决定。收到用户决定后立即调用一次 hy_approve；它只接受 approve、reject 或 revise，未知文本不改变状态。如果 approve 时缺少 before_approve 审计，hy_approve 会把该 PlanDoc 的原决定原样持久化并自动路由到 hy_read_docs(before_approve)。没有文档漂移时按 nextAction 自动重放 hy_approve，不得再次询问用户；有漂移时工具停在 agent 审查，agent 必须用 auditDecision=continue 或 replan 明确结论。changedSinceBaseline 不会自动使批准失效。只有事实变化导致任务意图、scope、验证或风险发生实质变化时才用 replan 自动刷新 before_plan、生成新 PlanDoc，并只为新 PlanDoc 请求新的 userAction.kind=approval。否则用 continue 让批准继续绑定原 decisionId 和 PlanDoc hash，覆盖建分支、编辑、after_edit、修复、重试、验证、commit.ci、merge、merge.sync 和 reset。

hy_commit 内部创建提交、push、PR 并执行 commit.ci。CI pending 表示等待后重试，不需要批准。hy_merge 在既有计划批准下自动执行，并在 merge.sync 同步下游；不得在合并前索要第二次确认。CI 和下游同步没有单独的公共工具，分别属于 commit.ci 和 merge.sync。

before_plan、before_approve 和 after_edit 都不是新增的人类审核。hy_edit 只锁定 scope 并停止，agent 用标准文件工具完成代码编辑后再调用 hy_read_docs(after_edit)；该审计再次停止，让 agent 完成 PlanDoc 已声明的文档修改。文档编辑完成后调用 hy_sync_docs 记录证据，它会自动路由到 hy_verify。verify 失败进入同一批准范围内的 edit 修复循环。普通 API 重试、证据刷新和 CI 等待不清除批准。

运行时只使用当前项目配置、外置状态和新版明确接口。不得读取、校验、哈希、迁移、删除或依赖旧 AGENTS 注入块、旧大型 workflow、旧 lint JSON 或旧项目内运行时文件；它们存在或被修改都不得阻断新版流程。

禁止绕过 hy-workflow 直接 commit、push、创建 PR 或合并，也禁止编辑 PlanDoc scope 外文件。
`;

// ― Server setup
const server = new Server(
  { name: "hy-workflow", version: PACKAGE_VERSION },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "hy_init",
    description: "初始化工作流：验证当前配置和外置状态，不读取、迁移或校验任何旧项目注入物，也不写项目或 .git。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_read_docs",
    description: "读取配置的项目文档系统，不读取根 AGENTS.md。before_plan 建立事实基线；before_approve 在首个 hy_approve 保存决定后自动执行并续跑；after_edit 审计后停止等待已声明文档编辑。两者都不是人类批准 gate。",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["before_plan", "before_approve", "after_edit"], description: "文档读取阶段。before_plan 在 hy_plan 前调用；before_approve 只在首个 hy_approve 已记录用户决定后自动调用，完成后自动续跑同一决定；after_edit 在实现编辑后调用，并在任何已声明文档编辑完成前停止。" },
        task: { type: "string", description: "before_plan 必填，用于把文档事实基线绑定到用户任务。" },
        cursor: { type: "string", description: "可选的有界分页游标；仅用于读取同一阶段和任务的后续相关文档页。" },
      },
      required: ["stage"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_plan",
    description: "分析任务 → 构造 PlanDoc JSON → 6 道 gate 校验。成功返回 display.body 含 6 个必须展示的节（标题·为什么·改动·影响·验证·风险），对照 display.requiredSections 逐段完整输出，禁止省略。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务描述，清晰说明要做什么（如：修复 hy_approve 状态机转换 bug）" },
        plan: {
          type: "object",
          required: ["task", "scope", "boundary", "verify", "risks", "discussion"],
          additionalProperties: false,
          description: "PlanDoc JSON。scope 里文件路径必须是经 Read/Glob 确认存在的真实路径；entry_points/smoke/tests 命令必须覆盖编译+lint+测试三个验证维度，且必须是纯 shell 命令，禁止 echo ok、括号说明、冒号说明或自然语言说明。",
          properties: {
            task: { type: "string", description: "描述要解决的问题和动机，而非仅列操作步骤。如 '修复 approve 不校验 plan 就切 phase 的问题' 优于 '修改 approve.ts'。" },
            scope: {
              type: "object",
              required: ["changes", "new_files", "delete"],
              additionalProperties: false,
              properties: {
                changes:   { type: "array", items: { type: "string" }, description: "要修改的现有文件。每个路径必须经 Read/Glob 确认存在。" },
                new_files: { type: "array", items: { type: "string" }, description: "要创建的新文件。列出完整相对路径。" },
                delete:    { type: "array", items: { type: "string" }, description: "要删除的文件。列出完整相对路径。" },
              },
            },
            boundary: {
              type: "object",
              required: ["dependency_dag", "entry_points", "no_new_external"],
              additionalProperties: false,
              properties: {
                dependency_dag: { type: "string", description: "列出直接受影响的模块、间接受波及的下游、以及明确不受影响的模块。如 'plan.ts 不再依赖 llm.ts；server.ts 引用不变；无其他模块受波及'。" },
                entry_points:   { type: "array", items: { type: "string" }, description: "必须覆盖改动的关键验证面：编译、lint、确定性测试。每条必须是纯 shell 命令，说明文字写入 description，禁止凑数。" },
                no_new_external: { type: "boolean", description: "是否引入新的外部依赖（npm 包、API、服务）" },
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
                    python_version: { type: "string", description: "Minimum Python version" },
                    setup: { type: "array", items: { type: "string" }, description: "Environment setup commands" },
                  },
                },
                smoke: {
                  type: "array",
                  description: "快速验证 (<5s/条，min 1)。每条对应一个验证维度（编译、lint、格式检查等），禁止 echo ok 类空洞命令。",
                  items: {
                    type: "object",
                    required: ["command", "expected_exit", "description"],
                    additionalProperties: false,
                    properties: {
                      command:      { type: "string", description: "Pure shell command to run. Do not append parenthetical, colon-prefixed, or natural-language explanations." },
                      expected_exit: { type: "number", description: "Expected exit code (0 for success)" },
                      description:  { type: "string", description: "What this check verifies" },
                    },
                  },
                },
                tests: {
                  type: "array",
                  description: "完整测试套件 (min 1)。建议覆盖单元测试和集成测试。",
                  items: {
                    type: "object",
                    required: ["command", "expected_exit", "description"],
                    additionalProperties: false,
                    properties: {
                      command:      { type: "string", description: "Pure shell command to run. Do not append parenthetical, colon-prefixed, or natural-language explanations." },
                      expected_exit: { type: "number", description: "Expected exit code" },
                      description:  { type: "string", description: "What this check verifies" },
                    },
                  },
                },
              },
            },
            risks:      { type: "array", items: { type: "string" }, description: "每条包含：什么场景触发、什么被影响、如何缓解。如一 'reset 在用户未确认时触发会丢 plan — 由提示词限制调用时机'。不写 'No risks' 或一句话标签。" },
            discussion: { type: "string", description: "说明为何选此方案。含至少一个被考虑但被否定的备选方案及否定理由。" },
          },
        },
      },
      required: ["task", "plan"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_approve",
    description: "提交用户对当前 PlanDoc 的单次决定。只接受 approve、reject 或 revise；未知文本无效且不改变状态。若缺少 before_approve 审计，先持久化原决定并自动完成审计。无文档漂移时自动续跑；有漂移时由 agent 用 auditDecision=continue 或 replan 明确事实审计结论，不得再次询问用户批准同一 PlanDoc。",
    inputSchema: {
      type: "object",
      properties: {
        approved: { type: "string", enum: ["approve", "reject", "revise"], description: "对当前 decisionId 的明确决定。" },
        note: { type: "string", description: "备注" },
        auditDecision: { type: "string", enum: ["continue", "replan"], description: "仅在 before_approve 报告文档漂移后使用。continue 表示 PlanDoc 的意图、scope、验证和风险仍无实质变化；replan 表示退回刷新事实并生成新 PlanDoc。不是新的用户批准。" },
      },
      required: ["approved"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_branch",
    description: "创建分支。category ∈ {refactor,feat,chore,docs,ci,fix,test}。成功后 envelope 指向 hy_edit。",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "重构/功能/杂务/文档/CI/修复/测试" },
        topic: { type: "string", description: "kebab-case 主题" },
      },
      required: ["category", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_edit",
    description: "锁定 scope 后停止，等待 LLM 使用标准 Read/Edit/Write 完成代码编辑；不会假装已经编辑，也不会自动进入 after_edit。代码编辑完成后调用 hy_read_docs(after_edit)，按审计完成所有已声明文档编辑，再调用 hy_sync_docs。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_sync_docs",
    description: "代码编辑和 hy_read_docs(after_edit) 已完成后，等待 agent 先完成 plan.scope 内已声明的文档或团队 workflow/template 编辑；随后记录文档同步证据并自动路由 hy_verify。工具本身不改写文档。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_verify",
    description: "本地任务校验（同步快路径）：compile + scope + boundary + platform + smoke + tests。setup 部署的 GitHub Actions 必须执行第一方内建 D001–D005 与 C001–C005 lint；要求 after_edit 文档审计和 hy_sync_docs 已完成；全绿方可 commit。单命令预计 >60s 或 tests 层较重时请改用 hy_exam_plan/hy_exam_submit 异步模式避免 MCP transport 超时。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_exam_plan",
    description: "异步 verify 第 1 步（出题）：立即返回一份检查清单（examId + nonce + 每命令 cwd/timeoutMs/expectExitCode），不在 MCP transport 里跑命令。适合长 test 套件或命令预计 >60s 的场景。agent 用 Bash 逐条运行、收集 exitCode 和最后 4KB stdout，再调 hy_exam_submit 交卷。清单与同步 hy_verify 跑的命令一致。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_exam_submit",
    description: "异步 verify 第 2 步（阅卷）：提交 hy_exam_plan 颁发的 examId 与完整结果集（id/command/nonce/exitCode/stdoutTail）。校验精确 planHash、包含未跟踪内容的完整实现指纹、nonce、命令、退出码与输出约束，同时复核当前审批、文档证据、本地 scope 和 no_new_external 边界。全部通过后持久化 implementationManifest 与 verifiedImplementationDigest；兼容输出或 PR 标签中的 verifyHash 仅为该 digest 的别名。任一失败都回到 edit，修复并刷新 after_edit/sync_docs 后必须重新出题，不接受原试卷局部补交。",
    inputSchema: {
      type: "object",
      properties: {
        examId: { type: "string", description: "hy_exam_plan 返回的 examId（2 小时 TTL）。" },
        results: {
          type: "array",
          description: "按 ExamCheck 列表逐条提交结果。",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              command: { type: "string", description: "原样返回 ExamCheck.command 字串，不能改。" },
              nonce: { type: "string" },
              exitCode: { type: "integer" },
              durationMs: { type: "integer" },
              stdoutTail: { type: "string", description: "stdout 最后 4KB。" },
              stderrTail: { type: "string" },
            },
            required: ["id", "command", "nonce", "exitCode"],
          },
        },
      },
      required: ["examId", "results"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_amend_plan",
    description: "处理一个有稳定 decisionId 的实质 scope 修订。approve 绑定修订后的 PlanDoc，并自动重跑 after_edit、sync_docs、verify；reject/revise 保留原批准并回到 edit。",
    inputSchema: {
      type: "object",
      properties: {
        approved: { type: "string", enum: ["approve", "reject", "revise"], description: "对 pending amendment 的明确决定。" },
        note: { type: "string", description: "用户批准修订的备注。" },
      },
      required: ["approved"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_commit",
    description: "在原批准范围内 commit、push、创建或复用 PR，并运行 commit.ci。CI pending 只需等待重试，不需要新批准。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_merge",
    description: "CI 全绿后在原计划批准下自动合并，不索要第二次确认；随后执行 merge.sync 同步下游分支。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_reset",
    description: "恢复工具：从任意 phase 重置到 plan，清空当前工作数据（branch/pr/plan/verifyHash）。用于 state 卡死时的显式恢复，也可在用户明确放弃任务后调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_status",
    description: "查看持久 phase、内部 stage，以及权威 nextAction/control/userAction。只有 userAction.kind=approval 才请求批准。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

let setupGate: ReturnType<typeof createSetupGate> | null = null;

function currentSetupGate(): ReturnType<typeof createSetupGate> {
  setupGate ??= createSetupGate();
  return setupGate;
}

function inferredPhaseForTool(name: string, args: Record<string, any>): Phase {
  if (name === "hy_read_docs") {
    if (args.stage === "before_approve") return "approve";
    if (args.stage === "after_edit") return "edit";
    return "plan";
  }
  const phases: Record<string, Phase> = {
    hy_init: "init",
    hy_plan: "plan",
    hy_approve: "approve",
    hy_branch: "branch",
    hy_edit: "edit",
    hy_sync_docs: "edit",
    hy_verify: "verify",
    hy_amend_plan: "verify",
    hy_exam_plan: "verify",
    hy_exam_submit: "verify",
    hy_commit: "commit",
    hy_merge: "merge",
    hy_reset: "plan",
    hy_status: "init",
  };
  return phases[name] ?? "init";
}

function recoveryPosition(name: string, args: Record<string, any>): { phase: Phase; stage: WorkflowStage; stateReadable: boolean } {
  try {
    const state = readState();
    return { phase: state.phase, stage: state.stage ?? DEFAULT_STAGE_BY_PHASE[state.phase], stateReadable: true };
  } catch {
    const phase = inferredPhaseForTool(name, args);
    return { phase, stage: DEFAULT_STAGE_BY_PHASE[phase], stateReadable: false };
  }
}

// ― System prompt capability
assertCommandCatalogMatchesTools(TOOLS);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
  _systemPrompt: SYSTEM_PROMPT,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  try {
    const setupGateResult = currentSetupGate()();
    if (setupGateResult) {
      return { content: [{ type: "text", text: JSON.stringify(setupGateResult, null, 2) }] };
    }

    const result = await dispatch(name, a);
    const setupCheck = checkSetupStamp();
    return { content: [{ type: "text", text: JSON.stringify(attachSetupCheck(result, setupCheck), null, 2) }] };
  } catch (e: any) {
    const error = e instanceof SyntaxError
      ? structuredError({ type: "validation", subtype: "invalid_plan", message: "PlanDoc JSON parse failed: " + e.message })
      : structuredError(e);
    const position = recoveryPosition(name, a);
    const recoveryTool = position.stateReadable ? "hy_status" : "hy_reset";
    const recoveryInstruction = position.stateReadable
      ? "Inspect persisted workflow state before retrying the failed tool."
      : "Reset the unreadable external workflow state. Project files and Git data are not changed.";
    const result = toolResult(position.phase, {
      phase: position.phase,
      stage: position.stage,
      error,
      display: { title: "hy-workflow tool error", body: error.message },
      hint: position.stateReadable
        ? "Inspect the structured error and call hy_status before retrying the workflow step."
        : "The external workflow state is unreadable. Call hy_reset to replace only that state and return to plan.",
      requires_user: true,
      stop_here: true,
      allowedTools: [recoveryTool],
      recovery: position.stateReadable
        ? { strategy: "retry", tool: "hy_status", instruction: recoveryInstruction }
        : { strategy: "reset", tool: "hy_reset", instruction: recoveryInstruction },
      nextAction: { tool: recoveryTool, phase: position.phase, stage: position.stage, automatic: false },
      control: { automatic: false, stop: true, reason: "review_required" },
      userAction: { kind: "review_failure", instruction: "Inspect the error and persisted workflow state; no new approval is implied." },
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: true,
    };
  }
});

async function dispatch(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "hy_init":    return handleInit();
    case "hy_read_docs": return handleReadDocs(args as any);
    case "hy_sync_docs": return handleSyncDocs();
    case "hy_plan":    return handlePlan(args as any);
    case "hy_approve": return handleApprove(args as any);
    case "hy_branch":  return handleBranch(args as any);
    case "hy_edit":    return handleEdit();
    case "hy_verify":  return handleVerify();
    case "hy_exam_plan": return handleExamPlan();
    case "hy_exam_submit": return handleExamSubmit(args as any);
    case "hy_amend_plan": return handleAmendPlan(args as any);
    case "hy_commit":  return handleCommit(args as any);
    case "hy_merge":   return handleMerge();
    case "hy_reset":   return handleReset();
    case "hy_status":  return handleStatus();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(configHelp() + "\n");
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(PACKAGE_VERSION + "\n");
    return;
  }
  if (argv[0] === "setup" || argv[0] === "unset") {
    process.exitCode = await runSetupCli(argv.slice(1), argv[0]);
    return;
  }
  if (argv[0] === "doctor") {
    process.exitCode = await runDoctorCli(argv.slice(1));
    return;
  }
  if (argv[0] === "config") {
    const result = runConfigCli(argv.slice(1));
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
    return;
  }
  if (argv[0] === "lint") {
    const result = await runLintCli(argv.slice(1));
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
    return;
  }
  if (argv[0] === "lint-contract") {
    const report = runContractLint(process.cwd());
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`hy-workflow MCP v${PACKAGE_VERSION} running`);
}

main().catch(console.error);
