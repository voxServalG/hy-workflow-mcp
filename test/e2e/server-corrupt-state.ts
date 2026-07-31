import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MINIMAL_PROJECT_CONTRACT, writeDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const runtime = mkdtempSync(join(tmpdir(), "hy-server-corrupt-state-"));
const roots = {
  config: join(runtime, "config"),
  state: join(runtime, "state"),
  cache: join(runtime, "cache"),
};
process.env.HY_WORKFLOW_CONFIG_HOME = roots.config;
process.env.HY_WORKFLOW_STATE_HOME = roots.state;
process.env.HY_WORKFLOW_CACHE_HOME = roots.cache;

const root = process.cwd();
writeDeployment(root, {
  setupVersion: "2026.07.16.1",
  mode: "shared",
  clients: [],
  projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml"],
  projectContract: MINIMAL_PROJECT_CONTRACT,
  tools: {},
  artifacts: {},
});
const workflowState = projectPaths(root).workflowState;
mkdirSync(dirname(workflowState), { recursive: true });
writeFileSync(workflowState, "{not json\n", "utf-8");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/server.js")],
  cwd: root,
  env: {
    ...process.env,
    HY_WORKFLOW_CONFIG_HOME: roots.config,
    HY_WORKFLOW_STATE_HOME: roots.state,
    HY_WORKFLOW_CACHE_HOME: roots.cache,
  } as Record<string, string>,
  stderr: "pipe",
});
const client = new Client({ name: "corrupt-state-contract", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const failed = await client.callTool({ name: "hy_status", arguments: {} });
  const failedText = failed.content.find(item => item.type === "text");
  assert(failedText?.type === "text", "corrupt-state response should contain JSON text");
  const payload = JSON.parse(failedText.text);
  assert(failed.isError === true && payload.error?.code === "WORKFLOW_STATE_CORRUPT", `server should preserve the corrupt-state identity: ${failedText.text}`);
  assert(payload.recovery?.strategy === "reset" && payload.recovery?.tool === "hy_reset", `corrupt state should route to reset instead of looping through status: ${failedText.text}`);
  assert(payload.nextAction?.tool === "hy_reset" && payload.allowedTools?.join(",") === "hy_reset", `corrupt state should expose one executable recovery tool: ${failedText.text}`);

  const reset = await client.callTool({ name: "hy_reset", arguments: {} });
  const resetText = reset.content.find(item => item.type === "text");
  assert(resetText?.type === "text", "reset response should contain JSON text");
  const resetPayload = JSON.parse(resetText.text);
  assert(resetPayload.ok === true && resetPayload.phase === "plan" && resetPayload.stage === "plan.before_plan", `hy_reset should replace only the unreadable external state: ${resetText.text}`);
} finally {
  await client.close();
}

console.log("server-corrupt-state: unreadable external state routes once to hy_reset and recovers");
