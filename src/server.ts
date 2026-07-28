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

// ― System prompt injected via MCP
const SYSTEM_PROMPT = `
你正在操作一个启用了 hy-workflow MCP 的项目。所有工具输入输出均为 JSON 格式。

## 硬性流程（必须严格按顺序，禁止跳过）

  首次使用: hy_init → hy_read_docs(before_plan) → hy_plan → ...
  后续使用: hy_status → hy_read_docs(before_plan) → hy_plan → hy_read_docs(before_approve) → hy_approve → hy_branch → hy_edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify → hy_commit → hy_merge

### 流程规则

**0. hy_init — 项目首次使用时调用。** 验证 OS 用户目录中的 deployment、根目录 hy-workflow.json 与外置运行时状态；hy_init 本身默认不写项目或 .git，随后自动进 plan。hy_init 不会在 MCP 内启动 setup TUI；若返回 requires_user/stop_here，必须等待用户按 recovery 处理。

1. hy_read_docs(before_plan) — 在 hy_plan 前由 agent 自动调用，不需要人类审核。读取 hy-workflow.json project.docsDir 指向的文档系统，形成规划事实基线，用于发现约束、术语、相关文件、未知点和验证期望。
2. hy_plan — 调用时传入 {task, plan}。你需要先基于 before_plan 的文档事实基线构造 PlanDoc JSON（通过 Read/Glob/Grep 了解项目结构、文件路径、可用命令）。服务端会通过 gate 校验 PlanDoc 质量，通过后方可进入 approve。
   **重要**: hy_plan 返回后，必须逐段完整输出 display.body 给用户，对照 display.requiredSections 确保每段都不遗漏。禁止压缩、改写、只输出标题。全部展示完毕后才等用户 approve。
3. hy_read_docs(before_approve) — 在用户表达 approve 后、调用 hy_approve 前由 agent 自动调用，不需要人类审核。读取文档系统并对当前 PlanDoc 做事实对齐审计；若发现事实偏移、scope 漏项、验证不足或风险缺失，必须驳回并重新 hy_plan，不得调用 hy_approve。
4. hy_approve — 用户审视 plan。传 approved="approve" 放行，其他内容=驳回。
   **重要**: 严禁在用户未明确回复批准前调用 hy_approve({approved:'approve'})。收到用户批准后，先自动调用 hy_read_docs({stage:'before_approve'}) 完成 agent 侧审计，再调用 hy_approve。before_approve 不是新增人类审核 gate。犹豫时反问用户确认。用户明确拒绝时，将拒绝理由填入 approved 参数传回。
5. hy_branch — 创建分支，category ∈ {refactor, feat, chore, docs, ci, fix, test}。
6. hy_edit — 锁定 scope，用 Read/Edit/Write 编辑，禁止编辑 plan.scope 未声明的文件。
7. hy_read_docs(after_edit) — 实现编辑后由 agent 自动调用，读取文档并审计当前实现 diff 与文档是否需要同步；不新增人类审核。
8. hy_sync_docs — 根据 after_edit 审计确认文档同步 gate，只允许在 plan.scope 声明的文档或团队 workflow/template 文件内同步，完成后再 hy_verify。
9. hy_verify — 本地任务 gate: compile → scope → boundary → platform → smoke → tests。setup 生成的 GitHub Actions workflow 必须执行第一方内建 D001–D005 与 C001–C005 lint；hy_verify 失败回 hy_edit，通过进 hy_commit。
10. hy_commit — git add + commit + push + gh pr create + 自动轮询 CI 直到全绿或失败。PR 正文嵌入 plan 摘要；CI 全绿直接进 hy_merge，失败回 hy_edit，pending 可重试 hy_commit。
11. hy_merge — 合并 PR + 删除远程分支 + 自动 rebase 下游 Agent 分支。任务完成后下一个 hy_plan 自动复位。
12. hy_reset — 恢复工具。当 state 卡死在 commit/merge 等非 plan 阶段、或用户命令放弃当前任务时，从任意 phase 重置到 plan。正常流程不需要调它（hy_plan 从 commit/merge/done 进入时自动复位）。

### 禁止操作

- 直接使用 git checkout / git commit / git push / gh pr create
- 跳过 hy_verify 直接调 hy_commit
- hy_approve 驳回后自行推进
- 编辑 plan.scope 声明外的文件

### Setup 与 CI 产物契约

- setup 不提供部署模式选择，固定维护 hy-workflow.json、.github/workflows/hy-workflow.yml 与 AGENTS.md 托管块
- deployment、registry、workflow state、scope、DocsGraph 和客户端配置均外置；旧 compatibility JSON 只作只读迁移输入，不生成也不得提交
- unset 只解除本机部署，不删除三个团队产物
- 旧用户 config 与含 mode 的 deployment manifest 仅只读兼容，不恢复第二套模式
- GitHub workflow 必须离线运行第一方内建 D001–D005 与 C001–C005；仓库管理员需把 Verify check 配为 required，setup 不修改 ruleset

---

## hy_plan 使用

调用 hy_plan({task: "描述你要做的任务", plan: { ... PlanDoc JSON ... }})。构造 PlanDoc 时：
- 先调用 hy_read_docs({stage:"before_plan", task}) 建立文档事实基线，再用 Read/Glob/Grep 了解项目结构，确认每个文件路径存在
- task 格式：现状 → 期望（从什么现状到什么期望，≤80字）。一句话说清楚改变，动机和理由放在 body/notes
- dependency_dag：说明哪些模块受影响、哪些不受影响、依赖链方向
- entry_points、smoke.command、tests.command 必须是纯 shell 命令，命令后不得加括号说明、冒号说明或自然语言说明
- risks 格式：场景：… → 影响：… → 缓解：…（三项用 → 分隔，每个风险 ≤200 字）
- discussion：含至少一个备选方案及否定理由

PlanDoc 通过 6 道 gate 校验后写入状态，进入 approve。

## hy_plan 触发

**仅在当前 phase 为 plan 且用户明确在发起开发任务时**才调用 hy_plan。日常讨论、询问问题不算触发条件。
触发词包括 "计划一下"、"plan it"、"做个计划"、"做计划"、"plan this"、或用户描述开发任务意图时。
hy_status 返回的 action.triggerWords 也会告诉你触发词。

## approve 后自动推进

hy_approve 被输入 "approve" 通过后，返回结果包含 pipeline 数组和 stopAfter。
按 pipeline 顺序逐条执行到 stopAfter 为止，不可跳步或调序。hy_edit 后必须先调用 hy_read_docs({stage:"after_edit"})，再调用 hy_sync_docs，最后才调用 hy_verify。
**每完成一步，用简短语句向用户汇报当前进度**（如"已创建分支 feat/xxx""已锁定 scope，开始编辑""验证通过，正在 commit"）。

任务完成标准是 PR 合并到 baseBranch 后 hy_merge 自动 rebase 下游分支并返回 done。下一个 hy_plan 会自动复位状态。
hy_commit → hy_merge 中间除非工具返回 error、requires_user 或 stop_here，否则不要停下。

## 失败处理

hy_verify 失败: 编辑修复后重新 hy_verify。
hy_commit CI 轮询有红: 停下并展示结构化失败信息；编辑修复后重新 hy_verify → hy_commit。
hy_commit CI pending/超时: 停下并展示状态；等待后重试 hy_commit（不重复 commit/push）。

hy_status 随时可查看当前阶段。

## 提示

- 所有工具返回均为 JSON，含 next 字段指示下一阶段
- 工具返回会保留 legacy 字段，同时尽量提供 agent-facing envelope: ok、phase、display、hint、requires_user、stop_here、allowedTools、blockedTools、recovery
- display 是用户需要看到的内容；hint 是 agent 的下一步义务；requires_user 或 stop_here 为 true 时必须停下来等待用户明确输入
`;

// ― Server setup
const server = new Server(
  { name: "hy-workflow", version: PACKAGE_VERSION },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "hy_init",
    description: "初始化工作流：验证 OS 用户目录中的 deployment 与根 hy-workflow.json 并初始化外置状态；不写项目或 .git，也不会在 MCP 内启动 setup TUI。成功后必须先调用 hy_read_docs(before_plan)，再调用 hy_plan。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_read_docs",
    description: "自动读取项目文档系统。before_plan 建立有预算的规划事实基线；before_approve 对当前 PlanDoc 做 agent 侧文档审计；after_edit 审计实现 diff 与文档同步需求。若返回 pagination.hasMore，可用 cursor 读取下一页补充事实；成功后不需要人类审核。",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["before_plan", "before_approve", "after_edit"], description: "文档读取阶段。before_plan 在 hy_plan 前调用；before_approve 在用户 approve 后、hy_approve 前调用；after_edit 在实现编辑后、hy_sync_docs 前调用。" },
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
    description: "用户审视 plan。传 approved=\"approve\" 放行到 branch，传其他任何字符串=驳回理由回到 plan。返回 pipeline 和 allowedTools；approved 必须是字符串，不可传 boolean。",
    inputSchema: {
      type: "object",
      properties: {
        approved: { type: "string", description: "必须传字符串 'approve' 才放行（如 approved='approve'）。传其他任何字符串均为驳回，内容作为驳回理由。不可传 boolean true/false。" },
        note: { type: "string", description: "备注" },
      },
      required: ["approved", "note"],
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
    description: "锁定 scope，LLM 使用标准 Read/Edit/Write 编辑文件。返回 display/hint/allowedTools；完成编辑后必须先调 hy_read_docs(after_edit)，再调 hy_sync_docs，最后才调 hy_verify。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_sync_docs",
    description: "实现编辑后、hy_verify 前的文档同步 gate。要求已运行 hy_read_docs(after_edit)，确认只在 plan.scope 声明的文档或团队 workflow/template 文件内同步。",
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
    description: "异步 verify 第 2 步（阅卷）：提交 hy_exam_plan 颁发的 examId + 每条命令的 result（id/command/nonce/exitCode/stdoutTail）。校验 nonce、命令字串、exitCode、mustContain 正则，以及 scopeFingerprint（git write-tree）与出题时一致。全部通过才写 verifyHash 放行 commit，否则返回 failedChecks 供修后补交。",
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
    description: "在 hy_verify 返回 amend_required 后，经用户明确 approve，应用 pending plan scope 修订并回到 edit/verify 流程，不完整 reset 到 plan。",
    inputSchema: {
      type: "object",
      properties: {
        approved: { type: "string", description: "必须为字符串 'approve' 才会应用 pending amendment。" },
        note: { type: "string", description: "用户批准修订的备注。" },
      },
      required: ["approved"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_commit",
    description: "git add + commit + push + gh pr create + 自动轮询 CI 直到全绿或失败。PR 正文嵌入 plan 摘要；CI 全绿直接返回 next=merge，失败返回 edit，pending 可重试。",
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
    description: "全绿并经用户确认后合并 PR + 删除分支 + 自动 rebase 下游 Agent 分支。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_reset",
    description: "恢复工具：从任意 phase 重置到 plan，清空当前工作数据（branch/pr/plan/verifyHash）。用于 state 卡死时的显式恢复，也可在用户明确放弃任务后调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_status",
    description: "查看当前工作流阶段。返回 phase、allowedTools 和下一步提示。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

let setupGate: ReturnType<typeof createSetupGate> | null = null;

function currentSetupGate(): ReturnType<typeof createSetupGate> {
  setupGate ??= createSetupGate();
  return setupGate;
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
    const result = toolResult("plan", {
      error,
      display: { title: "hy-workflow tool error", body: error.message },
      hint: "Inspect the structured error and call hy_status before retrying the workflow step.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
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
