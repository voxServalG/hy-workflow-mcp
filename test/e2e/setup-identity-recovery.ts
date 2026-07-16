import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readRegistry } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { executeSetup } from "../../src/setup/operations.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  name = "claude" as const;
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot { const before = this.inspect(server); this.values.set(server, definition); return before; }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null) { if (previous?.definition) this.values.set(server, previous.definition); else this.values.delete(server); }
}

useRuntimeHome("hy-identity-runtime-");
const root = makeGitProject("hy-identity-");
execFileSync("git", ["remote", "add", "origin", "https://example.test/vox/hy-identity.git"], { cwd: root });
const client = new Client();
const setup: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
const installed = await executeSetup(root, setup, [client]);
const moved = `${root}-moved`;
fs.renameSync(root, moved);
assert(projectPaths(moved).identity.id === installed.projectId, "a unique stale remote record must reconcile a moved checkout to its original identity");
const unset = await executeSetup(moved, { ...setup, action: "unset", removeGlobal: true }, [client]);
assert(unset.removed && unset.remainingProjects === 0 && !readRegistry(moved).projects[installed.projectId], "unset from moved checkout must remove the original registry/state identity");
assert(fs.existsSync(path.join(moved, "hy-workflow.json")) && fs.existsSync(path.join(moved, ".github", "workflows", "hy-workflow.yml")), "identity recovery unset must keep both team artifacts");

const byIdRoot = makeGitProject("hy-by-id-source-");
const byIdClient = new Client();
const byId = await executeSetup(byIdRoot, setup, [byIdClient]);
const byIdPaths = projectPaths(byIdRoot);
fs.writeFileSync(byIdPaths.workflowState, '{"phase":"verify"}\n');
fs.writeFileSync(byIdPaths.scope, '{"files":["src/index.ts"]}\n');
fs.mkdirSync(path.dirname(byIdPaths.docsGraph), { recursive: true });
fs.writeFileSync(byIdPaths.docsGraph, '{"nodes":["docs/index.md"]}\n');
const recoveryRoot = makeGitProject("hy-by-id-runner-");
const restoreHooks = setSetupTestHooks({ failAt: "postcondition" });
let byIdFailed = false;
try { await executeSetup(recoveryRoot, { ...setup, action: "unset", clients: [], projectId: byId.projectId }, []); }
catch (error: any) { byIdFailed = error?.code === "SETUP_TRANSACTION_FAILED"; }
finally { restoreHooks(); }
assert(byIdFailed, "--project-id unset must expose the deterministic postcondition failure");
assert(Boolean(readRegistry(recoveryRoot).projects[byId.projectId]), "failed --project-id unset must restore its registry record");
assert(fs.existsSync(byIdPaths.deployment) && fs.existsSync(byIdPaths.workflowState) && fs.existsSync(byIdPaths.scope) && fs.existsSync(byIdPaths.docsGraph), "failed --project-id unset must restore all target external state");
const recovered = await executeSetup(recoveryRoot, { ...setup, action: "unset", clients: [], projectId: byId.projectId }, []);
assert(recovered.removed && !readRegistry(recoveryRoot).projects[byId.projectId], "--project-id must prune a stale deployment without requiring a client executable");

console.log("setup-identity-recovery: moved checkout and explicit by-id cleanup pass");
