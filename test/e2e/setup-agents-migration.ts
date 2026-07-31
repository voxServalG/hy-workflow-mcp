import * as fs from "node:fs";
import * as path from "node:path";
import { executeSetup } from "../../src/setup/operations.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  name = "claude" as const;
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot { const previous = this.inspect(server); this.values.set(server, definition); return previous; }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null) { if (previous?.definition) this.values.set(server, previous.definition); else this.values.delete(server); }
}

const options: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false };

useRuntimeHome("hy-agents-inert-runtime-");
const freshRoot = makeGitProject("hy-agents-not-created-");
const fresh = await executeSetup(freshRoot, options, [new Client()]);
assert(fresh.ok && !fresh.projectFilesChanged.includes("AGENTS.md"), "fresh setup must not plan AGENTS.md");
assert(!fs.existsSync(path.join(freshRoot, "AGENTS.md")), "fresh setup must not create AGENTS.md");

useRuntimeHome("hy-agents-existing-runtime-");
const existingRoot = makeGitProject("hy-agents-existing-");
const agentsPath = path.join(existingRoot, "AGENTS.md");
const arbitraryAgents = Buffer.from("# Team-owned instructions\narbitrary bytes and syntax: { [ ( ???\n", "utf-8");
fs.writeFileSync(agentsPath, arbitraryAgents);
fs.chmodSync(agentsPath, 0o000);
let result;
try {
  result = await executeSetup(existingRoot, options, [new Client()]);
  assert((fs.statSync(agentsPath).mode & 0o777) === 0, "setup must not change permissions on an unreadable AGENTS.md");
} finally {
  fs.chmodSync(agentsPath, 0o644);
}
assert(result?.ok && !result.projectFilesChanged.includes("AGENTS.md"), "setup must not read or report an arbitrary unreadable AGENTS.md as managed");
assert(fs.readFileSync(agentsPath).equals(arbitraryAgents), "setup must preserve arbitrary AGENTS.md bytes exactly");

console.log("setup-agents-migration: arbitrary unreadable AGENTS.md stays untouched");
