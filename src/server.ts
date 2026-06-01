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
import { handleCommit } from "./tools/commit.js";
import { handleCi } from "./tools/ci.js";
import { handleMerge } from "./tools/merge.js";
import { handleChain } from "./tools/chain.js";
import { handleStatus } from "./tools/status.js";

// ― System prompt injected via MCP
const SYSTEM_PROMPT = `
你正在操作一个启用了 hy-workflow MCP 的项目。所有工具输入输出均为 JSON 格式。

## 硬性流程（必须严格按顺序，禁止跳过）

  首次使用: hy_init → hy_plan → ...
  后续使用: hy_status → hy_plan → hy_approve → hy_branch → hy_edit → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain

### 流程规则

**0. hy_init — 项目首次使用时调用。** 部署 hy-harness（codelint + doclint + docs-gardener + CI workflows）。已部署则跳过，自动进 plan。用 hy_status 检查当前 phase，若为 init 则先调 hy_init。

1. hy_plan — 调用时传入 {task} 描述任务。服务端自动调用 DeepSeek API 生成 PlanDoc。你只需要清楚描述要做什么。
   **重要**: hy_plan 返回后，你必须将完整的 PlanDoc 以可读格式向用户展示。包含：Task（任务描述）、Scope（改/增/删的文件清单）、Boundary（入口点）、Verify（smoke/tests 命令）、Risks（风险）、Discussion（方案理由）。存在 summary 字段时可优先使用 summary。禁止只显示摘要片段。禁止在用户查看前自行推进到下一步。
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

---

## hy_plan 使用

调用 hy_plan({task: "描述你要做的任务"})。服务端自动分析项目上下文（garden-scan）并用 DeepSeek API 生成 PlanDoc。PlanDoc 生成后必须经过 6 道验证关才会被接受。

如果 API Key 未设置或 API 调用失败，hy_plan 会返回 error + PlanDoc JSON Schema。此时你需要手动构造 PlanDoc 并再次调用 hy_plan({task, plan})。

## hy_plan 触发

**仅在当前 phase 为 plan 且用户明确在发起开发任务时**才调用 hy_plan。日常讨论、询问问题不算触发条件。
触发词包括 "计划一下"、"plan it"、"做个计划"、"做计划"、"plan this"、或用户描述开发任务意图时。
hy_status 返回的 action.triggerWords 也会告诉你触发词。

## approve 后自动推进

hy_approve 被输入 "approve" 通过后，返回结果包含 pipeline 数组和 stopAfter。
按 pipeline 顺序逐条执行到 stopAfter 为止，不可跳步或调序。
**每完成一步，用简短语句向用户汇报当前进度**（如"已创建分支 feat/xxx""已锁定 scope，开始编辑""验证通过，正在 commit"）。

hy_commit 创建 PR 后任务结束。用户需要时手动调用:
  hy_ci → hy_merge → hy_chain

## 失败处理

hy_verify 失败: 编辑修复后重新 hy_verify。
hy_ci 有红:   编辑修复后重新 hy_verify → hy_commit → hy_ci。

hy_status 随时可查看当前阶段。

## 提示

- 所有工具返回均为 JSON，含 next 字段指示下一阶段
- PlanDoc 的 smokes/tests 的 max_tokens 需足够，建议默认 4096+
`;

// ― Server setup
const server = new Server(
  { name: "hy-workflow", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "hy_init",
    description: "初始化项目：部署 hy-harness（codelint + doclint + docs-gardener + CI workflows）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_plan",
    description: "分析任务 → 服务端自动调用 DeepSeek API 生成 PlanDoc。LLM 只需传 {task} 描述任务。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务描述，清晰说明要做什么（如：修复 hy_approve 状态机转换 bug）" },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "hy_approve",
    description: "用户审视 plan。传 approved=\"approve\" 放行到 branch，传其他任何字符串=驳回理由回到 plan。注意：approved 必须是字符串，不可传 boolean。",
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
    description: "创建分支。category ∈ {refactor,feat,chore,docs,ci,fix,test}",
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
    description: "锁定 scope，LLM 使用标准 Read/Edit/Write 编辑文件。完成后调 hy_verify。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_verify",
    description: "全量校验：doclint + codelint + scope + boundary + platform + smoke + tests。全绿方可 commit。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_commit",
    description: "git add + commit + push + gh pr create。PR 正文嵌入 plan 摘要。",
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
    description: "轮询 CI 状态，返回结构化报告。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_merge",
    description: "全绿后合并 PR + 删除分支。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hy_chain",
    description: "依次 rebase 所有下游分支。",
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
    description: "查看当前工作流阶段。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ― System prompt capability
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
  _systemPrompt: SYSTEM_PROMPT,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  try {
    const result = await dispatch(name, a);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: e.message || String(e) }, null, 2) }],
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
    case "hy_commit":  return handleCommit(args as any);
    case "hy_ci":      return handleCi();
    case "hy_merge":   return handleMerge();
    case "hy_chain":   return handleChain(args as any);
    case "hy_status":  return handleStatus();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`hy-workflow MCP v0.1.0 running`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("⚠ DEEPSEEK_API_KEY not set. hy_plan will run in manual fallback mode.");
    console.error("  Create a .env file in your project root:");
    console.error("    echo 'DEEPSEEK_API_KEY=sk-...' >> .env");
    console.error("  Or set it in your shell environment directly.");
    console.error("  Get your key at https://platform.deepseek.com/api_keys");
  }
}

main().catch(console.error);
