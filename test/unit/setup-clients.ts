import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOpenCodeAdapter } from "../../src/setup/clients/opencode.js";
import { definitionEquals, normalizeDefinition } from "../../src/setup/clients/index.js";
import { MCP_DEFINITIONS } from "../../src/setup/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(definitionEquals(normalizeDefinition({ transport: { command: "x", args: ["a"], env: { B: "2", A: "1" } } }), { command: "x", args: ["a"], env: { A: "1", B: "2" } }), "definition normalization should ignore env key order");

if (process.platform !== "win32") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-opencode-client-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "opencode");
  fs.writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode-test; fi\n", { mode: 0o755 });
  const config = path.join(root, "opencode.json");
  fs.writeFileSync(config, '{\n  // preserve this comment\n  "theme": "dark",\n  "mcp": { "other": { "type": "remote", "url": "https://example.test" } }\n}\n');
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.OPENCODE_CONFIG = config;
  const adapter = createOpenCodeAdapter();
  const previous = adapter.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
  assert(previous.definition === null, "new OpenCode MCP should have no previous definition");
  assert(definitionEquals(adapter.inspect("hy-workflow").definition, MCP_DEFINITIONS["hy-workflow"]), "OpenCode adapter should install the direct command");
  adapter.remove("hy-workflow", MCP_DEFINITIONS["hy-workflow"], previous);
  const restored = fs.readFileSync(config, "utf-8");
  assert(restored.includes("// preserve this comment") && restored.includes('"theme": "dark"') && restored.includes('"other"'), "OpenCode JSONC edits must preserve comments and unrelated fields");
  assert(!adapter.inspect("hy-workflow").definition, "OpenCode unset should remove only the owned entry");
}
