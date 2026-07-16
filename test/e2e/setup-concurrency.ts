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
  name = "codex" as const;
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "codex", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot { const previous = this.inspect(server); this.values.set(server, definition); return previous; }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null) { if (previous?.definition) this.values.set(server, previous.definition); else this.values.delete(server); }
}

useRuntimeHome("hy-concurrency-runtime-");
const options: SetupOptions = { action: "setup", mode: "shared", clients: ["codex"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
const root = makeGitProject("hy-concurrency-");
const client = new Client();
const results = await Promise.all(Array.from({ length: 16 }, () => executeSetup(root, options, [client])));
assert(results.every(result => result.ok), "all serialized concurrent setup calls should succeed");
assert(client.values.size === 2, "concurrent setup must converge to exactly two client definitions");
assert(Object.keys(readRegistry(root).projects).length === 1, "concurrent setup must keep one registry record for one project");
assert(!fs.existsSync(projectPaths(root).setupJournal) && !fs.existsSync(projectPaths(root).setupLock), "successful concurrency must leave no lock or journal");

for (const failpoint of ["client:codex:hy-workflow", "ownership", "shared:config", "shared:workflow", "deployment", "registry", "postcondition"]) {
  useRuntimeHome(`hy-fail-${failpoint.replace(/[^a-z]+/g, "-")}-runtime-`);
  const failedRoot = makeGitProject(`hy-fail-${failpoint.replace(/[^a-z]+/g, "-")}-`);
  const failedClient = new Client();
  const restoreHooks = setSetupTestHooks({ failAt: failpoint });
  let failed = false;
  try { await executeSetup(failedRoot, options, [failedClient]); }
  catch (error: any) { failed = error?.code === "SETUP_TRANSACTION_FAILED"; }
  finally { restoreHooks(); }
  assert(failed, `${failpoint}: deterministic failure must surface`);
  assert(failedClient.values.size === 0, `${failpoint}: client mutations must roll back`);
  assert(!fs.existsSync(path.join(failedRoot, "hy-workflow.json")), `${failpoint}: config must roll back`);
  assert(!fs.existsSync(path.join(failedRoot, ".github", "workflows", "hy-workflow.yml")), `${failpoint}: workflow must roll back`);
  assert(!fs.existsSync(projectPaths(failedRoot).deployment), `${failpoint}: deployment must roll back`);
  assert(!readRegistry(failedRoot).projects[projectPaths(failedRoot).identity.id], `${failpoint}: registry must roll back`);
  assert(!fs.existsSync(projectPaths(failedRoot).setupJournal), `${failpoint}: successful rollback must clear journal`);
}

const unsetRoot = makeGitProject("hy-unset-rollback-");
const unsetClient = new Client();
await executeSetup(unsetRoot, options, [unsetClient]);
const unsetPaths = projectPaths(unsetRoot);
fs.writeFileSync(unsetPaths.workflowState, '{"phase":"edit"}\n');
fs.writeFileSync(unsetPaths.scope, '{"files":["src/index.ts"]}\n');
fs.mkdirSync(path.dirname(unsetPaths.docsGraph), { recursive: true });
fs.writeFileSync(unsetPaths.docsGraph, '{"nodes":["docs/index.md"]}\n');
const restoreUnsetHooks = setSetupTestHooks({ failAt: "postcondition" });
let unsetFailed = false;
try { await executeSetup(unsetRoot, { ...options, action: "unset", removeGlobal: true }, [unsetClient]); }
catch (error: any) { unsetFailed = error?.code === "SETUP_TRANSACTION_FAILED"; }
finally { restoreUnsetHooks(); }
assert(unsetFailed, "unset postcondition failpoint must surface");
assert(unsetClient.values.size === 2, "failed unset must restore both owned client definitions");
assert(fs.existsSync(unsetPaths.deployment) && fs.existsSync(unsetPaths.workflowState) && fs.existsSync(unsetPaths.scope) && fs.existsSync(unsetPaths.docsGraph), "failed unset must restore deployment, workflow, scope, and docs graph");
assert(Boolean(readRegistry(unsetRoot).projects[unsetPaths.identity.id]), "failed unset must restore the registry record");

useRuntimeHome("hy-unset-registration-race-runtime-");
const firstRoot = makeGitProject("hy-unset-registration-first-");
const secondRoot = makeGitProject("hy-unset-registration-second-");
const sharedClient = new Client();
await executeSetup(firstRoot, options, [sharedClient]);
let registeredDuringWindow = false;
const restoreRegistrationHook = setSetupTestHooks({
  afterUnsetPreflightBeforeLock: async () => {
    registeredDuringWindow = true;
    await executeSetup(secondRoot, options, [sharedClient]);
  },
});
let racedUnset;
try { racedUnset = await executeSetup(firstRoot, { ...options, action: "unset", removeGlobal: true }, [sharedClient]); }
finally { restoreRegistrationHook(); }
const racedRegistry = readRegistry(firstRoot);
assert(registeredDuringWindow, "the concurrent registration fixture must run after unset preview and before its lock");
assert(racedUnset.remainingProjects === 1 && Object.keys(racedRegistry.projects).length === 1, "unset must recompute the live registry while locked");
assert(Boolean(racedRegistry.projects[projectPaths(secondRoot).identity.id]) && fs.existsSync(projectPaths(secondRoot).deployment), "the concurrently registered project must remain deployed");
assert(!racedRegistry.projects[projectPaths(firstRoot).identity.id] && !fs.existsSync(projectPaths(firstRoot).deployment), "only the requested project may be unregistered");
assert(sharedClient.values.size === 2, "global MCP definitions must remain while the concurrently registered project exists");

console.log("setup-concurrency: lock serialization, setup failpoints, unset rollback, and last-project race revalidation pass");
