import * as fs from "node:fs";
import * as path from "node:path";
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
const options: SetupOptions = { action: "setup", mode: "shared", clients: ["codex"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false };
const legacyConfigPath = projectPaths(root).config;
const legacyConfigText = JSON.stringify({
  legacyMarker: { preserve: true },
  project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"], maxLines: 500 },
  doclint: { maxLines: 200 },
  docsGardener: { catalogs: {} },
}, null, 2) + "\n";
fs.mkdirSync(path.dirname(legacyConfigPath), { recursive: true });
fs.writeFileSync(legacyConfigPath, legacyConfigText, "utf-8");
const before = gitStatus(root);
const setup = await executeSetup(root, options, [adapter]);
assert(setup.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "setup should write exactly the shared config and workflow");
const setupStatus = gitStatus(root);
assert(setupStatus.includes("hy-workflow.json") && setupStatus.includes(".github/workflows/hy-workflow.yml"), "setup should expose exactly the two team artifacts to git");
assert(adapter.definitions.size === 2, "setup should configure both owned MCP servers");
assert(readDeployment(root)?.clients[0] === "codex" && readDeployment(root)?.mode === "shared", "setup should register a shared project deployment");
assert(readDeployment(root)?.projectFiles.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "deployment should own both shared artifacts even when already current");
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
assert(gitStatus(root) === setupStatus && gitStatus(root) !== before, "unset must keep both team project files unchanged");
assert(fs.readFileSync(legacyConfigPath, "utf-8") === legacyConfigText, "unset must preserve the migrated legacy user config byte-for-byte");
