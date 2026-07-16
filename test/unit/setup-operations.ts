import * as fs from "node:fs";
import * as path from "node:path";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { executeSetup, readOwnership } from "../../src/setup/operations.js";
import { readDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { gitStatus, makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeAdapter implements ClientAdapter {
  name = "codex" as const;
  definitions = new Map<ServerName, McpDefinition>();
  sharedFileExists = false;
  failRemove: ServerName | null = null;
  detect() { return { name: this.name, installed: true, executable: "fake-codex", version: "test", configured: [...this.definitions.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot {
    const definition = this.definitions.get(server) ?? null;
    return { definition, state: definition ? "active" : "absent", raw: { configFileExisted: this.sharedFileExists } };
  }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot {
    const previous = this.inspect(server);
    this.definitions.set(server, definition);
    this.sharedFileExists = true;
    return previous;
  }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null): void {
    if (server === this.failRemove) throw new Error(`simulated remove failure: ${server}`);
    if (previous?.definition) this.definitions.set(server, previous.definition);
    else this.definitions.delete(server);
    if (!this.definitions.size && (previous?.raw as any)?.configFileExisted === false) this.sharedFileExists = false;
  }
}

useRuntimeHome("hy-setup-operations-runtime-");
const root = makeGitProject("hy-setup-operations-");
const adapter = new FakeAdapter();
const options: SetupOptions = { action: "setup", mode: "shared", clients: ["codex"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
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
assert(setup.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,AGENTS.md,hy-workflow.json", "setup should write the shared config, workflow, and AGENTS.md managed block");
const setupStatus = gitStatus(root);
assert(setupStatus.includes("hy-workflow.json") && setupStatus.includes(".github/workflows/hy-workflow.yml") && setupStatus.includes("AGENTS.md"), "setup should expose the three managed artifacts to git");
assert(adapter.definitions.size === 2, "setup should configure both owned MCP servers");
const setupOwnership = readOwnership(root);
assert(
  (setupOwnership.clients.codex?.["hy-workflow"]?.previous?.raw as any)?.configFileExisted === false
    && (setupOwnership.clients.codex?.["docs-gardener"]?.previous?.raw as any)?.configFileExisted === false,
  "ownership must preserve both locked preflight baselines instead of a sibling-created transaction snapshot",
);
assert(readDeployment(root)?.clients[0] === "codex" && readDeployment(root)?.mode === "shared", "setup should register a shared project deployment");
assert(readDeployment(root)?.projectFiles.sort().join(",") === ".github/workflows/hy-workflow.yml,AGENTS.md,hy-workflow.json", "deployment should own the shared artifacts and AGENTS.md");
assert(projectPaths(root).config.includes(projectPaths(root).identity.id), "project config should be identity-scoped");

adapter.failRemove = "docs-gardener";
let unsetFailed = false;
let unsetError = "";
try {
  await executeSetup(root, { ...options, action: "unset", removeGlobal: true }, [adapter]);
} catch (error: any) {
  unsetError = JSON.stringify({ code: error?.code, message: error?.message, detail: error?.detail });
  unsetFailed = error?.code === "SETUP_CLIENT_COMMAND_FAILED" && /simulated remove failure/.test(error?.detail?.cause ?? "");
}
assert(unsetFailed, `unset should surface the client removal failure, got: ${unsetError}`);
assert(adapter.definitions.size === 2, "failed unset should roll back already removed global entries");
assert(readDeployment(root), "failed unset should preserve the project deployment");
adapter.failRemove = null;
const unset = await executeSetup(root, { ...options, action: "unset", removeGlobal: true }, [adapter]);
assert(unset.remainingProjects === 0 && adapter.definitions.size === 0, "last-project unset should remove owned global entries when requested");
assert(adapter.sharedFileExists === false, "last-project unset should restore an initially absent shared client config file");
assert(!readDeployment(root), "unset should remove the project deployment");
assert(gitStatus(root) === setupStatus && gitStatus(root) !== before, "unset must keep both team project files unchanged");
assert(fs.readFileSync(legacyConfigPath, "utf-8") === legacyConfigText, "unset must preserve the migrated legacy user config byte-for-byte");

const unknownRoot = makeGitProject("hy-setup-unknown-deployment-");
const unknownDeployment = projectPaths(unknownRoot).deployment;
fs.mkdirSync(path.dirname(unknownDeployment), { recursive: true });
fs.writeFileSync(unknownDeployment, '{"schemaVersion":"99","opaque":true}\n');
let unknownCode = "";
try { readDeployment(unknownRoot); } catch (error: any) { unknownCode = error?.code; }
assert(unknownCode === "SETUP_TRANSACTION_FAILED", "unknown deployment schemas must fail closed instead of being treated as absent");
assert(fs.readFileSync(unknownDeployment, "utf-8").includes('"opaque":true'), "unknown deployment state must remain untouched");
