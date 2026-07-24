import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "hy-server-startup-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });

  const git = join(bin, "git");
  writeFileSync(git, "#!/bin/sh\nprintf 'git version test\\n'\n", "utf-8");
  chmodSync(git, 0o755);

  const gh = join(bin, "gh");
  writeFileSync(gh, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then printf 'gh version test\\n'; exit 0; fi",
    "if [ \"$1\" = \"auth\" ]; then sleep 3; exit 1; fi",
    "exit 1",
    "",
  ].join("\n"), "utf-8");
  chmodSync(gh, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HY_WORKFLOW_CONFIG_HOME: join(root, "config"),
    HY_WORKFLOW_STATE_HOME: join(root, "state"),
    HY_WORKFLOW_CACHE_HOME: join(root, "cache"),
  } as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/server.js")],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "startup-contract", version: "1.0.0" }, { capabilities: {} });
  const started = Date.now();
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const elapsed = Date.now() - started;
    assert(tools.tools.length === 14, `MCP surface should remain 14 tools, got ${tools.tools.length}`);
    assert(elapsed < 2_000, `MCP must connect before slow gh auth probing, took ${elapsed}ms`);
  } finally {
    await client.close();
  }
}

console.log("server-startup: MCP connects before lazy git/gh capability probes");
