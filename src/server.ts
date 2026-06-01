#!/usr/bin/env node

import "dotenv/config";

import * as fs from "node:fs";
import * as path from "node:path";
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
import { handleReset } from "./tools/reset.js";

// ― System prompt loaded from external file
let SYSTEM_PROMPT = "";
try {
  const promptPath = path.join(process.cwd(), "prompts", "system.md");
  SYSTEM_PROMPT = fs.readFileSync(promptPath, "utf-8");
} catch {
  SYSTEM_PROMPT = "hy-workflow MCP active. Use hy_status to check current phase.";
}

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
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              content: { type: "string" },
            },
            required: ["heading", "content"],
          },
        },
        body: { type: "string", description: "Fallback raw body (deprecated, prefer sections)" },
      },
      required: ["title"],
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
  {
    name: "hy_reset",
    description: "重置工作流：清空 .hy/workflow.json 回到 init 阶段。任意阶段可调用。",
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
    case "hy_reset":   return handleReset();
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
