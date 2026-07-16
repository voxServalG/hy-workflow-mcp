import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readRegistry } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { executeSetup } from "../../src/setup/operations.js";
import { assertClientSnapshotUnchanged } from "../../src/setup/clients/effective.js";
import { definitionEquals } from "../../src/setup/clients/index.js";
import { createOpenCodeAdapter } from "../../src/setup/clients/opencode.js";
import { withSetupTransaction } from "../../src/setup/transaction.js";
import { MCP_DEFINITIONS, type ClientAdapter, type ClientServerSnapshot, type McpDefinition, type ServerName, type SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  name = "codex" as const;
  installed = true;
  values = new Map<ServerName, McpDefinition>();
  onInstall: (() => void) | null = null;
  onBeforeInstall: (() => void) | null = null;
  onInspect: (() => void) | null = null;
  detect() { return { name: this.name, installed: this.installed, executable: this.installed ? "codex" : null, version: this.installed ? "test" : null, configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { this.onInspect?.(); return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition, expectedPrevious?: ClientServerSnapshot): ClientServerSnapshot {
    const before = this.onBeforeInstall;
    this.onBeforeInstall = null;
    before?.();
    const previous = this.inspect(server);
    if (expectedPrevious) assertClientSnapshotUnchanged(this.name, server, expectedPrevious, previous);
    this.values.set(server, definition);
    const hook = this.onInstall;
    this.onInstall = null;
    hook?.();
    return previous;
  }
  remove(server: ServerName, expected: McpDefinition, previous?: ClientServerSnapshot | null, expectedCurrent?: ClientServerSnapshot) {
    const current = this.inspect(server);
    if (expectedCurrent) assertClientSnapshotUnchanged(this.name, server, expectedCurrent, current);
    if (!current.definition || !definitionEquals(current.definition, expected)) throw new Error(`refusing to remove changed ${server}`);
    if (previous?.definition) this.values.set(server, previous.definition);
    else this.values.delete(server);
  }
}

const options: SetupOptions = { action: "setup", mode: "shared", clients: ["codex"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };

useRuntimeHome("hy-locked-capture-race-");
const lockedRoot = makeGitProject("hy-locked-capture-");
const lockedClient = new Client();
await executeSetup(lockedRoot, options, [lockedClient]);
const restoreLockedHooks = setSetupTestHooks({ afterLockedPreflight: root => fs.writeFileSync(path.join(root, "hy-workflow.json"), "external change after locked preflight\n") });
let lockedRaceCode = "";
try { await executeSetup(lockedRoot, options, [lockedClient]); }
catch (error: any) { lockedRaceCode = error?.code; }
finally { restoreLockedHooks(); }
assert(lockedRaceCode === "SETUP_TRANSACTION_FAILED", "locked-preflight to capture artifact mutation must fail closed");
assert(fs.readFileSync(path.join(lockedRoot, "hy-workflow.json"), "utf-8") === "external change after locked preflight\n", "locked-preflight race must preserve the external edit");
assert(!fs.existsSync(projectPaths(lockedRoot).setupJournal), "pre-write baseline conflict needs no manual journal when setup wrote nothing");

useRuntimeHome("hy-shared-write-race-");
const writeRoot = makeGitProject("hy-shared-write-");
const writeClient = new Client();
writeClient.onInstall = () => fs.writeFileSync(path.join(writeRoot, "hy-workflow.json"), "external change after capture\n");
let writeRaceCode = "";
try { await executeSetup(writeRoot, options, [writeClient]); }
catch (error: any) { writeRaceCode = error?.code; }
assert(writeRaceCode === "SETUP_TRANSACTION_FAILED", "artifact mutation after capture must fail the before-write CAS");
assert(fs.readFileSync(path.join(writeRoot, "hy-workflow.json"), "utf-8") === "external change after capture\n", "before-write CAS must not overwrite the concurrent artifact content");
assert(fs.existsSync(projectPaths(writeRoot).setupJournal), "a concurrent after-capture artifact change must retain manual recovery evidence");

useRuntimeHome("hy-client-write-race-");
const clientRaceRoot = makeGitProject("hy-client-write-race-");
const clientRace = new Client();
const concurrentDefinition = { command: "external-client-command", args: ["--keep"] };
clientRace.onBeforeInstall = () => clientRace.values.set("hy-workflow", concurrentDefinition);
let clientRaceCode = "";
try { await executeSetup(clientRaceRoot, options, [clientRace]); }
catch (error: any) { clientRaceCode = error?.code; }
assert(clientRaceCode === "SETUP_CLIENT_CONFIG_UNSAFE", "client mutation after locked preflight must fail adapter CAS");
assert(definitionEquals(clientRace.values.get("hy-workflow") ?? null, concurrentDefinition), "client CAS must preserve the concurrent definition");
assert(!fs.existsSync(path.join(clientRaceRoot, "hy-workflow.json")) && fs.existsSync(projectPaths(clientRaceRoot).setupJournal), "blocked client CAS must not write project artifacts and must retain recovery evidence");

for (const target of ["deployment", "registry", "ownership", "artifact"] as const) {
  useRuntimeHome(`hy-postcondition-${target}-`);
  const root = makeGitProject(`hy-postcondition-${target}-`);
  const client = new Client();
  const paths = projectPaths(root);
  let corrupted = false;
  client.onInspect = () => {
    if (corrupted || !fs.existsSync(paths.deployment)) return;
    corrupted = true;
    if (target === "deployment") {
      const value = JSON.parse(fs.readFileSync(paths.deployment, "utf-8"));
      value.setupVersion = "corrupted";
      fs.writeFileSync(paths.deployment, JSON.stringify(value, null, 2) + "\n");
    } else if (target === "registry") {
      const value = readRegistry(root);
      value.projects[paths.identity.id].clients = [];
      fs.writeFileSync(paths.registry, JSON.stringify(value, null, 2) + "\n");
    } else if (target === "ownership") {
      fs.writeFileSync(paths.clientOwnership, '{"schemaVersion":"1","revision":99,"clients":{}}\n');
    } else {
      fs.writeFileSync(path.join(root, ".github", "workflows", "hy-workflow.yml"), "externally corrupted after setup writes\n");
    }
  };
  let code = "";
  try { await executeSetup(root, options, [client]); }
  catch (error: any) { code = error?.code; }
  assert(corrupted && code === "SETUP_TRANSACTION_FAILED", `${target} postcondition corruption must fail closed`);
  assert(fs.existsSync(paths.setupJournal), `${target} corruption must preserve the CAS conflict journal`);
  assert(client.values.size === 0, `${target} corruption must still roll back client entries`);
}

useRuntimeHome("hy-unset-unavailable-");
const unavailableRoot = makeGitProject("hy-unset-unavailable-");
const unavailableClient = new Client();
await executeSetup(unavailableRoot, options, [unavailableClient]);
unavailableClient.installed = false;
let unavailableCode = "";
try { await executeSetup(unavailableRoot, { ...options, action: "unset", removeGlobal: true }, [unavailableClient]); }
catch (error: any) { unavailableCode = error?.code; }
assert(unavailableCode === "SETUP_UNSET_INCOMPLETE", "unavailable owned clients must make requested global unset nonzero");
assert(!readRegistry(unavailableRoot).projects[projectPaths(unavailableRoot).identity.id] && !fs.existsSync(projectPaths(unavailableRoot).deployment), "incomplete global cleanup must still report committed local unset evidence");
assert(unavailableClient.values.size === 2, "unavailable client entries must remain untouched for recovery");

useRuntimeHome("hy-unset-finalize-");
const finalizeRoot = makeGitProject("hy-unset-finalize-");
const finalizeClient = new Client();
await executeSetup(finalizeRoot, options, [finalizeClient]);
const restoreFinalizeHooks = setSetupTestHooks({ failDirectoryCleanup: true });
let finalizeCode = "";
try { await executeSetup(finalizeRoot, { ...options, action: "unset", removeGlobal: false }, [finalizeClient]); }
catch (error: any) { finalizeCode = error?.code; }
finally { restoreFinalizeHooks(); }
assert(finalizeCode === "SETUP_UNSET_INCOMPLETE", "staged-directory cleanup leftovers must make unset nonzero");
assert(!readRegistry(finalizeRoot).projects[projectPaths(finalizeRoot).identity.id], "finalize cleanup failure must expose that registry removal already committed");

useRuntimeHome("hy-unset-directory-race-");
const directoryRaceRoot = makeGitProject("hy-unset-directory-race-");
await executeSetup(directoryRaceRoot, { ...options, clients: [] }, [], { inspectDirectTools: false });
const directoryRacePaths = projectPaths(directoryRaceRoot);
let recreated = "";
const restoreDirectoryRaceHooks = setSetupTestHooks({ afterDirectoryStage: target => {
  if (recreated) return;
  recreated = target;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "external-race.txt"), "preserve me\n");
} });
let directoryRaceCode = "";
try { await executeSetup(directoryRaceRoot, { ...options, action: "unset", clients: [], removeGlobal: false }, [], { inspectDirectTools: false }); }
catch (error: any) { directoryRaceCode = error?.code; }
finally { restoreDirectoryRaceHooks(); }
assert(directoryRaceCode === "SETUP_TRANSACTION_FAILED", "a staged directory recreated before commit must fail closed");
assert(Boolean(recreated) && fs.readFileSync(path.join(recreated, "external-race.txt"), "utf-8") === "preserve me\n", "directory CAS must preserve the concurrent target content");
assert(Boolean(readRegistry(directoryRaceRoot).projects[directoryRacePaths.identity.id]) && fs.existsSync(directoryRacePaths.setupJournal), "directory CAS conflict must restore registry evidence and retain the recovery journal");
assert(fs.readdirSync(path.dirname(recreated)).some(name => name.startsWith(`${path.basename(recreated)}.removing-`)), "directory CAS conflict must preserve the old staged tombstone for manual reconciliation");

useRuntimeHome("hy-client-journal-recovery-");
const clientRoot = makeGitProject("hy-client-journal-");
const recoveryClient = new Client();
recoveryClient.values.set("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
try {
  await withSetupTransaction(clientRoot, "setup", transaction => {
    transaction.markClient("client:codex:hy-workflow", {
      action: "install",
      previous: { definition: null, state: "absent" },
      desired: { definition: MCP_DEFINITIONS["hy-workflow"], state: "active" },
      appliedExact: true,
    });
    throw new Error("simulated process loss after client install");
  });
} catch {}
assert(fs.existsSync(projectPaths(clientRoot).setupJournal), "client crash residue must be journaled");
const recovered = await executeSetup(clientRoot, options, [recoveryClient]);
assert(recovered.ok && recoveryClient.values.size === 2, "a retry must CAS-reconcile client crash residue and complete setup");
assert(!fs.existsSync(projectPaths(clientRoot).setupJournal), "successful client reconciliation must clear the old journal");

if (process.platform !== "win32") {
  useRuntimeHome("hy-opencode-client-kill-runtime-");
  const killRoot = makeGitProject("hy-opencode-client-kill-");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-opencode-client-kill-bin-"));
  const executable = path.join(bin, "opencode");
  fs.writeFileSync(executable, "#!/bin/sh\necho opencode-test\n", { mode: 0o755 });
  const config = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hy-opencode-client-kill-config-")), "opencode.json");
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.OPENCODE_CONFIG = config;
  const child = spawnSync(process.execPath, ["--import", "tsx", path.resolve("test/helpers/setup-client-crash-child.ts"), killRoot], {
    cwd: path.resolve("."),
    env: process.env,
    encoding: "utf-8",
    timeout: 20_000,
  });
  assert(child.signal === "SIGKILL", `OpenCode setup child must die in the provisional WAL window: status=${child.status} stderr=${child.stderr}`);
  const installed = fs.readFileSync(config, "utf-8");
  const userEdited = installed.replace('"hy-workflow": {', '"hy-workflow": {\n      // user comment after setup crash');
  assert(userEdited !== installed, "OpenCode crash fixture must contain the installed entry");
  fs.writeFileSync(config, userEdited);
  fs.chmodSync(config, 0o640);
  let provisionalCode = "";
  try { await executeSetup(killRoot, { ...options, clients: ["opencode"] }, [createOpenCodeAdapter(killRoot)], { inspectDirectTools: false }); }
  catch (error: any) { provisionalCode = error?.code; }
  assert(provisionalCode === "SETUP_TRANSACTION_FAILED", "provisional client WAL must require manual reconciliation after a crash");
  assert(fs.readFileSync(config, "utf-8") === userEdited && (fs.statSync(config).mode & 0o777) === 0o640, "recovery must preserve a same-definition OpenCode comment and mode edit after SIGKILL");
  assert(fs.existsSync(projectPaths(killRoot).setupJournal), "unsafe provisional client evidence must remain for doctor-guided recovery");
}

console.log("setup-transaction-invariants: artifact races, postcondition corruption, and client crash recovery pass");
