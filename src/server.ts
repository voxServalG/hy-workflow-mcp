#!/usr/bin/env node

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
你正在操作一个启用了 hy-workflow MCP 的项目。

## 硬性流程（必须严格按顺序，禁止跳过）

  hy_status → hy_plan → hy_approve → hy_branch → hy_edit → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain

### 流程规则

1. hy_plan — 分析任务生成 PlanDoc。每个字段会被 hy_verify 实际执行，决定了 PR 能不能合并。
2. hy_approve — 用户审视 plan，approved=true 放行，approved=false 驳回回到 hy_plan。
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

## hy_plan 编写指南

下面每个字段都标注了【消费方式】——这是它在下游怎么被执行的。填空洞内容你的 PR 合不了。

### scope
【消费: hy_edit 锁定文件, hy_verify 用 git diff 对比。声明了没改 → warning；改了没声明 → hard fail】

- changes: 已存在、本次修改的文件
- new_files: 本次新建的文件
- delete: 本次删除的文件

### boundary
【消费: entry_points 逐条被 hy_verify 执行，命令在本机跑通了不等于 CI 能跑】

- dependency_dag: 文字描述改动影响面。哪怕只改了一个文件也写"X 独立，无上游依赖"
- entry_points: 可执行命令列表，至少 1 条。 坏例: "echo ok"（空洞）。 好例: "npx tsc --noEmit" 或 "python -c 'from core import main'"
- no_new_external: 本次是否引入新第三方依赖

### verify
【消费: plan.tests 在 CI 无头 Linux 容器里执行。能本机跑的 python 脚本 ≠ CI 能跑】

platform:
  - python_version: 最低 Python 版本
  - setup: 环境准备命令（安装依赖、编译等）

smoke: 快速烟雾测试（<5s），至少 1 条实质性命令。 坏例: { command: "echo ok" }。 好例: { command: "npx tsc --noEmit", expected_exit: 0, description: "编译检查" }

tests: 针对本次改动的功能验证，至少 1 条。只测你改的部分，不给全量回归。 自检: 这条 PASS 了，我有信心说"改动正确"吗？

### risks
【消费: PR 正文，供 reviewer 审查】

至少 1 条诚实担忧。 坏例: ["无风险"]（永远有风险，至少写"兼容性: 未在 Windows 测试"）

### discussion
【消费: PR 正文】

写下方案选择的权衡——为什么选 A 不选 B？不写，reviewer 会替你问。

---

## PlanDoc 结构（调用 hy_plan 时 plan 参数必须遵从此结构）

{
  "task": "任务简述",
  "plan": {
    "task": "同上",
    "scope": { "changes": [], "new_files": [], "delete": [] },
    "boundary": {
      "dependency_dag": "描述改动影响面",
      "entry_points": ["至少1条可执行命令"],
      "no_new_external": true
    },
    "verify": {
      "platform": { "python_version": ">=3.10", "setup": [] },
      "smoke": [ { "command": "...", "expected_exit": 0, "description": "..." } ],
      "tests": [ { "command": "...", "expected_exit": 0, "description": "..." } ]
    },
    "risks": ["至少1条风险"],
    "discussion": "方案讨论与权衡说明"
  }
}

## 自检清单（调用 hy_plan 前逐条确认）

scope 和 git diff 预期一致？
entry_points 在干净环境能执行？不是 echo ok？
smoke 有至少 1 条实质性命令？
tests 验证的是本次改动的功能点？
risks 有至少 1 条真实担忧？
discussion 解释了"为什么这样做"？

hy_status 随时可查看当前阶段。
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
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hy_plan",
    description: "分析任务 → 生成完整 PlanDoc。LLM 必须输出符合结构约定的 plan，缺字段/空内容会被拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务简述" },
        plan: {
          type: "object",
          description: "PlanDoc 对象，必须包含: task, scope, boundary, verify, risks, discussion",
          properties: {
            task:       { type: "string", description: "任务简述" },
            scope:      { type: "object", description: "{ changes: string[], new_files: string[], delete: string[] }" },
            boundary:   { type: "object", description: "{ dependency_dag: string, entry_points: string[], no_new_external: boolean }" },
            verify:     { type: "object", description: "{ platform: {...}, smoke: CheckItem[], tests: CheckItem[] }" },
            risks:      { type: "array",  description: "风险列表，至少 1 条" },
            discussion: { type: "string", description: "方案讨论与权衡说明" },
          },
          required: ["task", "scope", "boundary", "verify", "risks", "discussion"],
        },
      },
      required: ["task", "plan"],
    },
  },
  {
    name: "hy_approve",
    description: "用户审视 plan。approved=true 放行 → branch，approved=false 驳回 → plan。唯一用户 gate。",
    inputSchema: {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        note: { type: "string", description: "可选备注" },
      },
      required: ["approved"],
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
    },
  },
  {
    name: "hy_edit",
    description: "锁定 scope，LLM 使用标准 Read/Edit/Write 编辑文件。完成后调 hy_verify。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hy_verify",
    description: "全量校验：doclint + codelint + scope + boundary + platform + smoke + tests。全绿方可 commit。",
    inputSchema: { type: "object", properties: {} },
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
    },
  },
  {
    name: "hy_ci",
    description: "轮询 CI 状态，返回结构化报告。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hy_merge",
    description: "全绿后合并 PR + 删除分支。",
    inputSchema: { type: "object", properties: {} },
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
    },
  },
  {
    name: "hy_status",
    description: "查看当前工作流阶段。",
    inputSchema: { type: "object", properties: {} },
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
}

main().catch(console.error);
