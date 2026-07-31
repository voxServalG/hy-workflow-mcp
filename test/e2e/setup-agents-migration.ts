import * as fs from "node:fs";
import * as path from "node:path";
import { executeSetup } from "../../src/setup/operations.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { AGENTS_CLOSE, AGENTS_OPEN } from "../../src/setup/agents-rules.js";
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
const existing = `${AGENTS_OPEN}\n<!-- hy-workflow-rules-version: 2020.01.01 -->\nold injected rules\n${AGENTS_CLOSE}\nteam-owned instructions\n`;
fs.writeFileSync(path.join(existingRoot, "AGENTS.md"), existing);
const result = await executeSetup(existingRoot, options, [new Client()]);
assert(result.ok && !result.projectFilesChanged.includes("AGENTS.md"), "setup must not report an existing AGENTS.md as managed");
assert(fs.readFileSync(path.join(existingRoot, "AGENTS.md"), "utf-8") === existing, "setup must not read-rewrite or migrate an existing AGENTS.md block");

console.log("setup-agents-migration: AGENTS injection and migration are retired");
