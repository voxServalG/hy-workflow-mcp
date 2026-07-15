import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { executeSetup } from "../../src/setup/operations.js";
import { readDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { gitStatus, makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeAdapter implements ClientAdapter {
  name = "codex" as const;
  definitions = new Map<ServerName, McpDefinition>();
  failRemove: ServerName | null = null;
  detect() { return { name: this.name, installed: true, executable: "fake-codex", version: "test", configured: [...this.definitions.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.definitions.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot {
    const previous = this.inspect(server);
    this.definitions.set(server, definition);
    return previous;
  }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null): void {
    if (server === this.failRemove) throw new Error(`simulated remove failure: ${server}`);
    if (previous?.definition) this.definitions.set(server, previous.definition);
    else this.definitions.delete(server);
  }
}

useRuntimeHome("hy-setup-operations-runtime-");
const root = makeGitProject("hy-setup-operations-");
const adapter = new FakeAdapter();
const options: SetupOptions = { action: "setup", mode: "local", clients: ["codex"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false };
const before = gitStatus(root);
const setup = await executeSetup(root, options, [adapter]);
assert(setup.projectFilesChanged.length === 0 && gitStatus(root) === before, "local setup must preserve exact git status");
assert(adapter.definitions.size === 2, "setup should configure both owned MCP servers");
assert(readDeployment(root)?.clients[0] === "codex", "setup should register the project deployment");
assert(projectPaths(root).config.includes(projectPaths(root).identity.id), "project config should be identity-scoped");

adapter.failRemove = "docs-gardener";
let unsetFailed = false;
try {
  await executeSetup(root, { ...options, action: "unset", removeGlobal: true }, [adapter]);
} catch (error: any) {
  unsetFailed = /simulated remove failure/.test(error?.message ?? String(error));
}
assert(unsetFailed, "unset should surface the client removal failure");
assert(adapter.definitions.size === 2, "failed unset should roll back already removed global entries");
assert(readDeployment(root), "failed unset should preserve the project deployment");
adapter.failRemove = null;
const unset = await executeSetup(root, { ...options, action: "unset", removeGlobal: true }, [adapter]);
assert(unset.remainingProjects === 0 && adapter.definitions.size === 0, "last-project unset should remove owned global entries when requested");
assert(!readDeployment(root), "unset should remove the project deployment");
assert(gitStatus(root) === before, "unset must preserve exact git status");
