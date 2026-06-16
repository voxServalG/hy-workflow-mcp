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
import { handlePlan } from "./tools/plan.js";
import { handleApprove } from "./tools/approve.js";
import { handleBranch } from "./tools/branch.js";
import { handleEdit } from "./tools/edit.js";
import { handleVerify } from "./tools/verify.js";
import { handleAmendPlan } from "./tools/amend_plan.js";
import { handleCommit } from "./tools/commit.js";
import { handleCi } from "./tools/ci.js";
import { handleMerge } from "./tools/merge.js";
import { handleChain } from "./tools/chain.js";
import { handleStatus } from "./tools/status.js";
import { handleReset } from "./tools/reset.js";
import { attachSetupCheck, checkSetupStamp, createSetupGate } from "./bootstrap.js";
import { configHelp, runConfigCli } from "./config.js";

// ― System prompt injected via MCP
const SYSTEM_PROMPT = `
你正在操作一个启用了 hy-workflow MCP 的项目。所有工具输入输出均为 JSON 格式。

## 硬性流程（必须严格按顺序，禁止跳过）

  首次使用: hy_init → hy_plan → ...
  后续使用: hy_status → hy_plan → hy_approve → hy_branch → hy_edit → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain

### 流程规则

**0. hy_init — 项目首次使用时调用。** 验证 setup 已部署 bootstrap 产物（codelint + doclint + docs-gardener + CI workflows），写入/更新 workflow 规则和本地忽略项，自动进 plan。hy_init 不会在 MCP 内启动 setup，也不会在 MCP 内启动交互式 harness；若返回 requires_user/stop_here，必须等待用户按 recovery 处理。用 hy_status 检查当前 phase，若为 init 则先调 hy_init。plan 阶段也可调 hy_init 补齐 workflow 规则。

1. hy_plan — 调用时传入 {task, plan}。你需要自行利用工作区上下文构造 PlanDoc JSON（通过 Read/Glob/Grep 了解项目结构、文件路径、可用命令）。服务端会通过 6 道 gate 校验 PlanDoc 质量，通过后方可进入 approve。
   **重要**: hy_plan 返回后，必须原样完整输出 summary 字段的内容向用户展示，不能摘要、压缩、改写。禁止在用户查看前自行推进到下一步。
2. hy_approve — 用户审视 plan。传 approved="approve" 放行，其他内容=驳回。
   **重要**: 严禁在用户未明确回复批准前调用 hy_approve({approved:'approve'})。你必须等待用户对展示的 plan 做出认可。犹豫时反问用户确认。用户明确拒绝时，将拒绝理由填入 approved 参数传回。
3. hy_branch — 创建分支，category ∈ {refactor, feat, chore, docs, ci, fix, test}。
4. hy_edit — 锁定 scope，用 Read/Edit/Write 编辑，禁止编辑 plan.scope 未声明的文件。
5. hy_verify — 全量校验: lint → compile → scope → boundary → platform → smoke → tests。失败回 hy_edit，通过进 hy_commit。
6. hy_commit — git add + commit + push + gh pr create，PR 正文嵌入 plan 摘要。
7. hy_ci — 等待 CI，红色回 hy_edit，全绿进 hy_merge。
8. hy_merge — 合并 PR，删除远程分支。
9. hy_chain — rebase 下游分支。

### 禁止操作

- 直接使用 git checkout / git commit / git push / gh pr create
- 跳过 hy_verify 直接调 hy_commit
- hy_approve 驳回后自行推进
- 编辑 plan.scope 声明外的文件

### hy_reset

hy_reset 可在任意阶段调用，重置到 plan 阶段并清空当前工作数据。用于 PR 已合并且 hy_chain 完成后的正常收尾；也可在用户明确要求放弃当前开发任务时使用。

---

## hy_plan 使用

调用 hy_plan({task: "描述你要做的任务", plan: { ... PlanDoc JSON ... }})。构造 PlanDoc 时：
- 先用 Read/Glob/Grep 了解项目结构，确认每个文件路径存在
- task：描述解决的**问题**和**动机**，不是操作步骤列表
- dependency_dag：说明哪些模块受影响、哪些不受影响、依赖链方向
- entry_points：覆盖编译+lint+测试，每条对应一个验证维度
- entry_points、smoke.command、tests.command 必须是纯 shell 命令，命令后不得加括号说明、冒号说明或自然语言说明
- 说明文字统一写到 description 字段；PlanDoc JSON 字符串尽量避免未转义的反斜杠、反引号、引号和换行
- risks：每条含场景+影响+缓解措施，不写一句话标签
- discussion：含至少一个备选方案及否定理由

PlanDoc 通过 6 道 gate 校验后写入状态，进入 approve。

## hy_plan 触发

**仅在当前 phase 为 plan 且用户明确在发起开发任务时**才调用 hy_plan。日常讨论、询问问题不算触发条件。
触发词包括 "计划一下"、"plan it"、"做个计划"、"做计划"、"plan this"、或用户描述开发任务意图时。
hy_status 返回的 action.triggerWords 也会告诉你触发词。

## approve 后自动推进

hy_approve 被输入 "approve" 通过后，返回结果包含 pipeline 数组和 stopAfter。
按 pipeline 顺序逐条执行到 stopAfter 为止，不可跳步或调序。
**每完成一步，用简短语句向用户汇报当前进度**（如"已创建分支 feat/xxx""已锁定 scope，开始编辑""验证通过，正在 commit"）。

任务完成标准不是 hy_commit，而是 PR 合并到 baseBranch 后调用 hy_chain（无下游分支时传空数组）并 hy_reset 回到 plan。
hy_commit → hy_ci → hy_merge → hy_chain → hy_reset 中间除非工具返回 error、requires_user 或 stop_here（例如 CI 红、CI pending/API 异常、push/PR/merge/rebase 失败），否则不要停下。

## 失败处理

hy_verify 失败: 编辑修复后重新 hy_verify。
hy_ci 有红:   停下并展示结构化失败信息；编辑修复后重新 hy_verify → hy_commit → hy_ci。
hy_ci pending/API 异常: 停下并展示结构化状态；不要进入 edit，等待后重试 hy_ci。

hy_status 随时可查看当前阶段。

## 提示

- 所有工具返回均为 JSON，含 next 字段指示下一阶段
- 工具返回会保留 legacy 字段，同时尽量提供 agent-facing envelope: ok、phase、display、hint、requires_user、stop_here、allowedTools、blockedTools、recovery
- display 是用户需要看到的内容；hint 是 agent 的下一步义务；requires_user 或 stop_here 为 true 时必须停下来等待用户明确输入
`;

// ― Server setup
const server = new Server(
  { name: "hy-workflow", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "hy_init",
    description: "初始化工作流：验证 setup 已部署 bootstrap 产物，写入/更新 AGENTS.md 和本地忽略项；不会在 MCP 内启动 setup。返回兼容式 agent-facing envelope，说明下一步是否可 hy_plan。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_plan",
    description: "分析任务 → LLM 使用工作区上下文构造 PlanDoc JSON → 服务端 6 道 gate 校验。成功返回 summary/display/requires_user/stop_here，必须展示给用户并等待 approve。",
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
    description: "锁定 scope，LLM 使用标准 Read/Edit/Write 编辑文件。返回 display/hint/allowedTools，完成后调 hy_verify。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_verify",
    description: "全量校验：doclint + codelint + scope + boundary + platform + smoke + tests。失败返回按 layer 的 recovery；全绿方可 commit。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
    description: "git add + commit + push + gh pr create。PR 正文嵌入 plan 摘要；成功后继续 hy_ci，不默认停下。",
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
    name: "hy_ci",
    description: "按 timeoutSeconds/intervalSeconds bounded polling CI 状态。全绿时继续 hy_merge；CI 红、超时仍 pending 或 API 异常时结构化停下。",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: { type: "number", description: "Maximum seconds to poll pending checks before returning pending status. Defaults to 600, capped at 1800." },
        intervalSeconds: { type: "number", description: "Seconds between CI polling attempts. Defaults to 10, minimum 2." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "hy_merge",
    description: "全绿并经用户确认后合并 PR + 删除分支。返回下一步 hy_chain guidance。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_chain",
    description: "依次 rebase 所有下游分支。返回 done display 和恢复提示。",
    inputSchema: {
      type: "object",
      properties: {
        branches: { type: "array", items: { type: "string" } },
      },
      required: ["branches"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_status",
    description: "查看当前工作流阶段。返回 phase、allowedTools 和下一步提示。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_reset",
    description: "重置到 plan 阶段，清空当前工作数据（branch/pr/plan/verifyHash）。用于 PR 合并并完成 hy_chain 后的正常收尾，也可在用户明确放弃任务后调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const setupGate = createSetupGate();

// ― System prompt capability
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
  _systemPrompt: SYSTEM_PROMPT,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  try {
    const setupGateResult = setupGate();
    if (setupGateResult) {
      return { content: [{ type: "text", text: JSON.stringify(setupGateResult, null, 2) }] };
    }

    const result = await dispatch(name, a);
    const setupCheck = checkSetupStamp();
    return { content: [{ type: "text", text: JSON.stringify(attachSetupCheck(result, setupCheck), null, 2) }] };
  } catch (e: any) {
    const message = e instanceof SyntaxError
      ? `PlanDoc JSON 解析失败：${e.message}. 请检查 risks / discussion / command 等字符串字段中的反斜杠、反引号、换行和未转义引号；建议重新生成不含 Markdown inline-code 的纯 JSON。`
      : e.message || String(e);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    };
  }
});

async function dispatch(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "hy_init":    return handleInit();
    case "hy_plan":    return handlePlan(args as any);
    case "hy_approve": return handleApprove(args as any);
    case "hy_branch":  return handleBranch(args as any);
    case "hy_edit":    return handleEdit();
    case "hy_verify":  return handleVerify();
    case "hy_amend_plan": return handleAmendPlan(args as any);
    case "hy_commit":  return handleCommit(args as any);
    case "hy_ci":      return handleCi(args as any);
    case "hy_merge":   return handleMerge();
    case "hy_chain":   return handleChain(args as any);
    case "hy_status":  return handleStatus();
    case "hy_reset":   return handleReset();
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
    process.stdout.write("0.1.0\n");
    return;
  }
  if (argv[0] === "config") {
    const result = runConfigCli(argv.slice(1));
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`hy-workflow MCP v0.1.0 running`);
}

main().catch(console.error);
