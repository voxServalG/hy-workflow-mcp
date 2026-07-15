import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { executeSetup } from "../../src/setup/operations.js";
import { gitStatus, makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

class MemoryClient implements ClientAdapter {
  name = "claude" as const;
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot {
    const before = this.inspect(server);
    this.values.set(server, definition);
    return before;
  }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null): void {
    if (previous?.definition) this.values.set(server, previous.definition);
    else this.values.delete(server);
  }
}

useRuntimeHome("hy-zero-diff-runtime-");
const root = makeGitProject("hy-zero-diff-project-");
const client = new MemoryClient();
const base: SetupOptions = { action: "setup", mode: "local", clients: ["claude"], language: "zh", yes: true, dryRun: false, json: true, removeGlobal: false };
const pristine = gitStatus(root);
const setup = await executeSetup(root, base, [client]);
assert(setup.message === "No project files changed" && setup.projectFilesChanged.length === 0, "local setup should explicitly report zero project changes");
assert(gitStatus(root) === pristine, "local setup must preserve exact status including untracked files");
const unset = await executeSetup(root, { ...base, action: "unset", removeGlobal: true }, [client]);
assert(unset.message === "No project files changed" && unset.projectFilesChanged.length === 0, "unset should explicitly report zero project changes");
assert(gitStatus(root) === pristine, "unset must preserve exact status including untracked files");
