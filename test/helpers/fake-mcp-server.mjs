import { createInterface } from "node:readline";

const names = JSON.parse(process.env.FAKE_MCP_TOOLS ?? '["wrong-tool"]');
const tools = names.map(name => ({
  name,
  description: `fixture ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } });
  } else if (message.method === "tools/list") {
    respond(message.id, { tools });
  } else if (message.method === "ping") {
    respond(message.id, {});
  }
});
